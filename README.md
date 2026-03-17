# Attache

Attache is a local AI orchestrator built on the GitHub Copilot SDK. It runs a daemon on your machine, keeps a long-lived orchestrator session alive, and lets you interact with it from a desktop GUI, Telegram, or any HTTP client. For coding work, Attache dispatches worker Copilot sessions into project directories and streams the results back to you.

## Highlights

- Persistent orchestrator daemon with ongoing context
- Pluggable backends: Copilot SDK (default), Claude Agent SDK, OpenAI Codex
- Blazor Hybrid desktop GUI with streaming markdown, 4-pane layout, and system tray
- Unified conversation transcript across all channels (GUI + Telegram)
- Optional Telegram control from your phone
- Configurable workfolder for project-scoped sessions
- Worker session management for repo-specific coding tasks
- Cron-based task scheduling for recurring jobs
- Local HTTP API with SSE for real-time streaming
- SQLite-backed state, memory, and session persistence

## Prerequisites

- **Node.js 18+**
- **GitHub Copilot CLI** installed and authenticated (`copilot login`)
- **.NET 10 SDK** (Windows, for the desktop GUI)

## Install

```bash
npm install -g attache
```

## Quick start

### 1. Authenticate Copilot

```bash
copilot login
```

### 2. Launch the GUI

```bash
# From source (development)
dotnet run --project gui/AttacheGui.csproj

# Or if installed via npm, launch from:
# %LOCALAPPDATA%\Programs\attache-gui\AttacheGui.exe
```

The GUI auto-starts the daemon if it isn't running. On first launch, a setup wizard walks you through choosing a display name, default model, and optional Telegram integration. No terminal required.

### 3. Talk to Attache

Example prompts:

- "Start working on the auth bug in ~/dev/myapp"
- "What sessions are running?"
- "Check on the api-tests session"
- "Switch to claude-opus-4.6"

## Command reference

| Command | Description |
| --- | --- |
| `attache start` | Start the daemon |
| `attache update` | Install the latest published package update |
| `attache help` | Show CLI help |

| Flag | Description |
| --- | --- |
| `--self-edit` | Enable self-edit mode for the current daemon process |

## Desktop GUI

The GUI is a .NET 10 Blazor Hybrid app (`gui/`) with a WinForms host and BlazorWebView. All UI is Razor components with HTML/CSS.

### Layout

```
+----------------------------------------------------------------------+
| Workfolder: ~/dev/myapp (main)                         [Settings]    |
+------------------+-----------------------------+---------------------+
|  Workers         |   Transcript                |  Inspector          |
|  > auth-fix [*]  |   You: fix the login bug    |  Workfolder: ...    |
|    ~/dev/myapp   |   Assistant: I'll fix...     |  Git: main          |
|                  |   ```typescript              |  Model: opus-4.6    |
|                  |   const user = await...      |  Workers: 1/5       |
|                  |   ```                        |  Uptime: 12m 30s    |
+------------------+-----------------------------+---------------------+
| [*] Connected    [Type a message...                      ] [Send]    |
+----------------------------------------------------------------------+
```

### Features

- Streaming markdown rendering (Markdig + highlight.js)
- Unified transcript: see both GUI and Telegram conversations
- Worker list with status indicators and selection
- Inspector: workfolder, git branch, model, backend, process diagnostics
- Configuration dialog: model, backend, workfolder, Telegram, display name
- System tray: start/stop/restart daemon, hide to tray on close, auto-start at login

## Configuration

Stored in `~/.attache/.env`, editable via the GUI Settings dialog or setup wizard on first launch.

| Key | Description | Default |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | -- |
| `AUTHORIZED_USER_ID` | Numeric Telegram user ID | -- |
| `API_PORT` | Daemon API port | `7777` |
| `COPILOT_MODEL` | Default model | `claude-sonnet-4.6` |
| `WORKER_TIMEOUT` | Worker timeout in ms | `600000` |
| `ASSISTANT_DISPLAY_NAME` | Cosmetic name shown in UI | `Attache` |
| `ATTACHE_SELF_EDIT` | Allow self-modification | disabled |
| `ATTACHE_PREVENT_SLEEP` | Keep PC awake while daemon runs | disabled |
| `ATTACHE_WORKFOLDER` | Default working directory for workers | -- |
| `ATTACHE_BACKEND` | Backend provider (`copilot`, `claude`, `codex`) | `copilot` |
| `ANTHROPIC_API_KEY` | API key (required for Claude backend) | -- |
| `OPENAI_API_KEY` | API key (required for Codex backend) | -- |

### Key paths

| Purpose | Path |
| --- | --- |
| Config env file | `~/.attache/.env` |
| SQLite database | `~/.attache/attache.db` |
| API bearer token | `~/.attache/api-token` |
| Session state | `~/.attache/sessions/` |
| User skills | `~/.attache/skills/` |

## Daemon API

Listens on `http://127.0.0.1:7777` (configurable via `API_PORT`).

- `/status` is public
- All other routes require `Authorization: Bearer <token>` (from `~/.attache/api-token`)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/status` | Health check |
| `GET` | `/config/effective` | Runtime identity and config |
| `GET` | `/sessions` | List worker sessions |
| `GET` | `/workers/:id` | Worker detail |
| `GET` | `/workers/:id/logs` | Worker output logs |
| `POST` | `/workers/:id/cancel` | Cancel a worker |
| `GET` | `/diagnostics` | Process, routing, and worker diagnostics |
| `GET` | `/transcript` | Conversation history from database |
| `GET` | `/workfolder` | Current working directory + git info |
| `POST` | `/workfolder` | Change workfolder (triggers restart) |
| `POST` | `/config` | Update `.env` config values |
| `GET` | `/stream` | SSE event stream |
| `POST` | `/message` | Submit a prompt |
| `POST` | `/cancel` | Cancel in-flight message |
| `GET` | `/model` | Current model |
| `POST` | `/model` | Switch model |
| `GET` | `/backend` | Current backend provider |
| `POST` | `/backend` | Switch backend provider |
| `GET` | `/memory` | List memories |
| `POST` | `/memory` | Add a memory |
| `DELETE` | `/memory/:id` | Remove a memory |
| `GET` | `/skills` | List skills |
| `GET` | `/skills/:slug/content` | Read a skill's content |
| `PUT` | `/skills/:slug` | Update a local skill |
| `DELETE` | `/skills/:slug` | Remove a local skill |
| `GET` | `/cron` | List cron jobs |
| `POST` | `/cron` | Create a cron job |
| `PUT` | `/cron/:id` | Update a cron job |
| `DELETE` | `/cron/:id` | Delete a cron job |
| `GET` | `/capabilities` | API capabilities manifest |
| `POST` | `/restart` | Restart daemon |

## Architecture

```
Telegram ───> Attache Daemon <─── Desktop GUI
                    │
             Orchestrator Session
                    │
        +-----------+-----------+
        |           |           |
      Worker 1    Worker 2    Worker N
```

- **Daemon** (`src/daemon.ts`): Backend client, Express API, optional Telegram bot
- **Orchestrator** (`src/copilot/orchestrator.ts`): long-lived session, serial message queue
- **Workers** (`src/copilot/tools.ts`): background sessions in project directories (max 5, configurable timeout)
- **Backend** (`src/backend/`): pluggable providers — Copilot SDK, Claude Agent SDK, OpenAI Codex
- **Cron** (`src/cron/scheduler.ts`): recurring task scheduling via node-cron
- **GUI** (`gui/`): Blazor Hybrid WinForms app with streaming SSE, Markdig markdown, system tray

## Development

```bash
# Clone and install
git clone https://github.com/ThomasRohde/attache.git
cd attache
npm install

# Start daemon (development, with hot reload)
npm run dev

# Start daemon (one-shot)
npm run daemon

# Full build (TypeScript + GUI exe)
npm run build

# Start daemon + launch GUI
npm start

# Build TypeScript only
npm run build:ts

# Build GUI exe only (single-file, self-contained)
npm run build:gui
# Output: gui/dist-win/AttacheGui.exe

# Launch GUI in development mode (debug build, hot reload)
dotnet run --project gui/AttacheGui.csproj
```

### Project structure

```
src/
  cli.ts              Command router (start, update, help)
  daemon.ts           Daemon lifecycle
  config.ts           Configuration (Zod + dotenv)
  api/
    server.ts         Express API + SSE
    events.ts         SSE event schema
  copilot/
    orchestrator.ts   Single persistent session with serial message queue
    tools.ts          24 tools (workers, skills, memory, models, cron, system)
    skills.ts         Skill discovery and management
    system-message.ts Orchestrator prompt construction
  backend/
    types.ts          BackendClient / BackendSession interfaces
    registry.ts       Singleton backend registry
    providers/        copilot, claude, codex implementations
  cron/
    scheduler.ts      node-cron task scheduling
  store/
    db.ts             SQLite (better-sqlite3, WAL mode)
  telegram/
    bot.ts            grammy Telegram bot

gui/
  AttacheGui.csproj   .NET 10 Blazor Hybrid project
  Program.cs          Entry point (STAThread, singleton mutex)
  MainForm.cs         WinForms host (BlazorWebView + NotifyIcon)
  Services/           ApiClient, SseService, DaemonManager, AppState, MarkdownService
  Models/             API response models
  Components/
    Layout/           MainLayout.razor
    Pages/            Dashboard.razor (orchestrates panes + SSE)
    Panes/            TranscriptPane, WorkersPane, InspectorPane, ComposerPane
    Shared/           MarkdownBlock, WorkerCard, StatusDot
    Dialogs/          ConfigDialog, WorkfolderPicker
  wwwroot/            index.html, CSS dark theme, highlight.js
```

## License

MIT
