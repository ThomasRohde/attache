# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Attache?

Attache is a multi-modal AI assistant daemon that orchestrates coding sessions via pluggable backends (Copilot SDK, Claude Agent SDK, OpenAI Codex). It accepts input from Telegram, a desktop GUI (Blazor Hybrid), and an HTTP API, then delegates coding tasks to short-lived worker sessions. All state persists in `~/.attache/`.

## Commands

```bash
npm run build          # Full build: TypeScript + GUI exe
npm run build:ts       # TypeScript compilation only (tsc)
npm run build:gui      # Publish GUI as single-file exe only
npm start              # Start daemon + launch GUI
npm run daemon         # Run daemon only via tsx
npm run dev            # Watch mode for daemon (tsx watch)
```

### Desktop GUI (Windows only)

The `gui/` directory contains a .NET 10 Blazor Hybrid desktop app (`AttacheGui`) that provides the full UI: streaming markdown transcript, worker management, inspector, configuration, and system tray integration. Requires .NET 10 SDK targeting `win-x64`.

```bash
# Debug build (fast iteration)
dotnet run --project gui/AttacheGui.csproj

# Publish single-file self-contained exe (for distribution)
npm run build:gui
# Output: gui/dist-win/AttacheGui.exe
```

No test suite exists yet.

> **Note:** First-run configuration (display name, model, Telegram) is handled by the in-GUI setup wizard. There is no CLI setup command.

## Architecture

```
Telegram / GUI / HTTP API
        │
        ▼
  Express API Server (localhost:7777, bearer token auth)
        │
        ▼
  Daemon Process (src/daemon.ts)
        │
        ▼
  Orchestrator (src/copilot/orchestrator.ts)
  - Single persistent session (resumable across daemon restarts)
  - Serial message queue (prevents concurrent session access)
  - Feeds worker results back as new messages via feedBackgroundResult()
        │
        ▼
  Backend Abstraction (src/backend/)
  - Pluggable: copilot (default), claude, codex
  - BackendClient / BackendSession interfaces (src/backend/types.ts)
  - Singleton registry (src/backend/registry.ts)
  - Each provider in src/backend/providers/{copilot,claude,codex}/
        │
        ▼
  Workers (src/copilot/tools.ts)
  - Short-lived sessions, created on-demand via backend
  - Max 5 concurrent, 600s timeout (configurable)
  - Non-blocking dispatch: orchestrator returns immediately
  - On completion → feedBackgroundResult() → re-queued as orchestrator message
  - Blocked from sensitive dirs (.ssh, .aws, .kube, etc.)
```

### Key subsystems

- **Backend abstraction** (`src/backend/`): `BackendClient` and `BackendSession` interfaces with capability flags (customTools, sessionResume, infiniteSessions, machineSessionDiscovery, etc.). Three providers: Copilot (full features), Claude (via Anthropic API), Codex (via OpenAI). Backend selected via `ATTACHE_BACKEND` env var.
- **Skills** (`src/copilot/skills.ts`): Three directories — bundled (`skills/`), local (`~/.attache/skills`), global (`~/.agents/skills`). SKILL.md format with YAML frontmatter. Usage tracked in `skill_usage` SQLite table.
- **Cron scheduler** (`src/cron/scheduler.ts`): node-cron based task scheduling. Tools: `schedule_task`, `list_schedules`, `update_schedule`, `remove_schedule`. Persisted in `cron_jobs` and `cron_executions` tables. SSE broadcast of execution events, optional Telegram notification on completion.
- **Database** (`src/store/db.ts`): better-sqlite3 with WAL mode. Tables: `worker_sessions`, `attache_state` (key-value), `conversation_log` (max 200, pruned on insert), `memories` (categorized: preference/fact/project/person/routine), `skill_usage`, `cron_jobs`, `cron_executions`.
- **API** (`src/api/server.ts`): SSE streaming via `/stream`, message submission via `/message`, transcript via `/transcript`. Schema-versioned events (`src/api/events.ts`). Bearer token auth from `~/.attache/api-token`.
- **GUI** (`gui/`): Blazor Hybrid WinForms app with BlazorWebView. 4-pane layout — workers, transcript (streaming Markdig-rendered markdown), inspector, composer. SSE + polling. System tray with daemon lifecycle management.
- **Telegram** (`src/telegram/bot.ts`): grammy framework. Auth via `AUTHORIZED_USER_ID`. Commands: `/start`, `/help`, `/cancel`, `/clear`, `/model`, `/provider`, `/memory`, `/skills`, `/workers`, `/restart`.
- **System message** (`src/copilot/system-message.ts`): Constructs orchestrator prompt with identity, capabilities, tool descriptions, memory summary, and backend-specific instructions. Self-edit protection unless `ATTACHE_SELF_EDIT=1`.

### Message flow

1. Input arrives from Telegram, GUI, or HTTP API with a `source` tag (`tui`, `telegram`, `background`)
2. `sendToOrchestrator()` queues the message (serial processing prevents race conditions)
3. Orchestrator session processes with tools available (24 registered tools for workers, skills, memory, model switching, cron scheduling, system control)
4. Tool calls like `create_worker_session` dispatch non-blocking workers
5. Response streams as SSE delta events + Telegram chunks
6. Worker completion → `feedBackgroundResult()` → new message queued to orchestrator
7. All messages logged to `conversation_log` table

### Session persistence

- Orchestrator session ID saved to `attache_state` table, resumed on daemon restart
- On resume failure, falls back to new session with last 10 messages injected for context recovery
- Backend change clears saved session (sessions are not portable across backends)
- Health check (30s interval) auto-reconnects if backend disconnects

### Configuration

Loaded from `~/.attache/.env` and cwd `.env`, validated with Zod (`src/config.ts`). Runtime updates via `persistEnvVar()` write back to file. `prepareConfigUpdate()` validates changes and reports which require daemon restart.

| Variable | Purpose | Default |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | — |
| `AUTHORIZED_USER_ID` | Numeric Telegram user ID | — |
| `API_PORT` | Daemon API port | 7777 |
| `COPILOT_MODEL` | Default model | claude-sonnet-4.6 |
| `WORKER_TIMEOUT` | Worker timeout (ms) | 600000 |
| `ASSISTANT_DISPLAY_NAME` | Cosmetic name | Attache |
| `ATTACHE_SELF_EDIT` | Allow self-modification | disabled |
| `ATTACHE_PREVENT_SLEEP` | Keep PC awake while daemon runs | disabled |
| `ATTACHE_WORKFOLDER` | Default working directory | — |
| `ATTACHE_BACKEND` | Backend provider (copilot/claude/codex) | copilot |
| `ANTHROPIC_API_KEY` | Required for Claude backend | — |
| `OPENAI_API_KEY` | Required for Codex backend | — |

**Hot-reloadable** (no restart): model, display name, worker timeout.
**Restart required**: API port, Telegram tokens, backend.

### Entry points

- `src/cli.ts` — Command router (start, update, help)
- `src/daemon.ts` — Daemon lifecycle (config → backend client → orchestrator → API → cron scheduler → Telegram → shutdown)
- `gui/Program.cs` — Desktop GUI entry point (singleton mutex, splash screen, DI container)

### Key paths

| Purpose | Path |
|---|---|
| Config | `~/.attache/.env` |
| SQLite database | `~/.attache/attache.db` |
| API bearer token | `~/.attache/api-token` |
| Session state | `~/.attache/sessions/` |
| User skills | `~/.attache/skills/` |
| Global skills | `~/.agents/skills/` |
| MCP server configs | `~/.copilot/mcp-config.json` |
| GUI window bounds | `~/.attache/window.json` |

## Institutional memory (cwmem)

This repo includes the packaged `cwmem` skill at `.claude/skills/cwmem`. Use that skill when the task is about recording, updating, linking, searching, or verifying repository memory, or when a meaningful architecture/process change should be saved. Prefer `--dry-run` for cautious writes, reuse `--idempotency-key` on retries, never hand-edit `memory/`, and run `cwmem sync export` after successful mutations.

## Tech stack

- TypeScript (ES2022, Node16 modules, ESM via `"type": "module"`)
- Copilot SDK (`@github/copilot-sdk`) — primary backend
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) — alternate backend
- OpenAI Codex (`@openai/codex`) — alternate backend
- Express 5 for HTTP API
- grammy for Telegram bot
- .NET 10 Blazor Hybrid (WinForms + BlazorWebView) for desktop GUI
- Markdig for server-side markdown rendering
- better-sqlite3 for persistence
- node-cron for task scheduling
- Zod 4 for config validation
