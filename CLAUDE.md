# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Attache?

Attache is a multi-modal AI assistant daemon that orchestrates Copilot SDK sessions. It accepts input from Telegram, a desktop GUI (Blazor Hybrid), and an HTTP API, then delegates coding tasks to short-lived worker sessions. All state persists in `~/.attache/`.

## Commands

```bash
npm run build          # TypeScript compilation (tsc)
npm run daemon         # Run daemon via tsx
npm run dev            # Watch mode for daemon (tsx watch)
npm run build:gui      # Publish GUI as single-file exe
```

### Desktop GUI (Windows only)

The `gui/` directory contains a .NET Blazor Hybrid desktop app (`AttacheGui`) that provides the full UI: streaming markdown transcript, worker management, inspector, configuration, and system tray integration. Requires .NET 10 SDK targeting `win-x64`.

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
  - Single persistent Copilot SDK session
  - Serial message queue processing
  - Feeds worker results back as new messages
        │
        ▼
  Workers (src/copilot/tools.ts)
  - Short-lived Copilot CLI sessions, created on-demand
  - Max 5 concurrent, 600s timeout
  - Each runs in an explicit working directory
  - Blocked from sensitive dirs (.ssh, .aws, .kube, etc.)
```

### Key subsystems

- **Router** (`src/copilot/router.ts`): Auto-selects model tier (fast/standard/premium) based on message complexity. Uses gpt-4.1 as classifier. Design tasks always route to opus.
- **Skills** (`src/copilot/skills.ts`): Three directories — bundled (`skills/`), local (`~/.attache/skills`), global (`~/.agents/skills`). SKILL.md format with YAML frontmatter.
- **Database** (`src/store/db.ts`): better-sqlite3 with WAL mode. Tables: `worker_sessions`, `attache_state`, `conversation_log` (max 200), `memories`.
- **API** (`src/api/server.ts`): SSE streaming via `/stream`, message submission via `/message`, transcript via `/transcript`. Schema-versioned events (`src/api/events.ts`).
- **GUI** (`gui/`): Blazor Hybrid WinForms app with BlazorWebView. 4-pane layout — workers, transcript (streaming Markdig-rendered markdown), inspector, composer. SSE + polling. System tray with daemon lifecycle management.
- **Telegram** (`src/telegram/bot.ts`): grammy framework. Auth via `AUTHORIZED_USER_ID`.

### Configuration

Loaded from `~/.attache/.env` and cwd `.env`, validated with Zod (`src/config.ts`):

| Variable | Purpose | Default |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | — |
| `AUTHORIZED_USER_ID` | Numeric Telegram user ID | — |
| `API_PORT` | Daemon API port | 7777 |
| `COPILOT_MODEL` | Default model | claude-sonnet-4.6 |
| `WORKER_TIMEOUT` | Worker timeout (ms) | 600000 |
| `ASSISTANT_DISPLAY_NAME` | Cosmetic name | Attache |
| `ATTACHE_SELF_EDIT` | Allow self-modification | disabled |
| `ATTACHE_WORKFOLDER` | Default working directory | — |

### Entry points

- `src/cli.ts` — Command router (start, update, help)
- `src/daemon.ts` — Daemon lifecycle (init client → start API → start bot → shutdown)
- `gui/Program.cs` — Desktop GUI entry point

## Institutional memory (cwmem)

This repo includes the packaged `cwmem` skill at `.claude/skills/cwmem`. Use that skill when the task is about recording, updating, linking, searching, or verifying repository memory, or when a meaningful architecture/process change should be saved. Prefer `--dry-run` for cautious writes, reuse `--idempotency-key` on retries, never hand-edit `memory/`, and run `cwmem sync export` after successful mutations.

## Tech stack

- TypeScript (ES2022, Node16 modules)
- Copilot SDK (`@github/copilot-sdk`) for orchestrator and worker sessions
- Express 5 for HTTP API
- grammy for Telegram bot
- .NET 10 Blazor Hybrid (WinForms + BlazorWebView) for desktop GUI
- Markdig for server-side markdown rendering
- better-sqlite3 for persistence
- Zod 4 for config validation
