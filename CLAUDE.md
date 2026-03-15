# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Attache?

Attache is a multi-modal AI assistant daemon that orchestrates Copilot SDK sessions. It accepts input from Telegram, a terminal UI (Ink/React), and an HTTP API, then delegates coding tasks to short-lived worker sessions. All state persists in `~/.attache/`.

## Commands

```bash
npm run build          # TypeScript compilation (tsc)
npm run daemon         # Run daemon via tsx
npm run tui            # Run Ink terminal UI via tsx
npm run tui:legacy     # Run readline-based fallback UI
npm run dev            # Watch mode for daemon (tsx watch)
npm run build:shell    # Publish tray app as single-file exe
```

### Tray app (Windows only)

The `shell/` directory contains a .NET WinForms system-tray app (`AttacheShell`) that manages the daemon lifecycle, opens the TUI, and provides quick input. Requires .NET 10 SDK targeting `win-x64`.

```bash
# Debug build (fast iteration)
cd shell && dotnet build AttacheShell.csproj -c Release

# Publish single-file self-contained exe (for distribution)
npm run build:shell
# Output: shell/dist-win/AttacheShell.exe
```

No test suite exists yet.

## Architecture

```
Telegram / TUI / HTTP API
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
- **API** (`src/api/server.ts`): SSE streaming via `/stream`, message submission via `/message`. Schema-versioned events (`src/api/events.ts`).
- **Ink TUI** (`src/ui/ink/app.tsx`): 4-pane React/Ink layout — workers list, transcript, inspector, composer. Polls daemon API.
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

### Entry points

- `src/cli.ts` — Command router (start, tui, setup, update, help)
- `src/daemon.ts` — Daemon lifecycle (init client → start API → start bot → shutdown)
- `src/ui/ink/index.tsx` — Ink TUI entry
- `src/tui/index.ts` — Legacy readline TUI entry

## Institutional memory (cwmem)

This repo includes the packaged `cwmem` skill at `.claude/skills/cwmem`. Use that skill when the task is about recording, updating, linking, searching, or verifying repository memory, or when a meaningful architecture/process change should be saved. Prefer `--dry-run` for cautious writes, reuse `--idempotency-key` on retries, never hand-edit `memory/`, and run `cwmem sync export` after successful mutations.

## Tech stack

- TypeScript (ES2022, Node16 modules, react-jsx)
- Copilot SDK (`@github/copilot-sdk`) for orchestrator and worker sessions
- Express 5 for HTTP API
- grammy for Telegram bot
- Ink 5 + React 18 for terminal UI
- better-sqlite3 for persistence
- Zod 4 for config validation
