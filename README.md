# Attache

Attache is a local AI orchestrator built on the GitHub Copilot SDK. It runs a daemon on your machine, keeps a long-lived orchestrator session alive, and lets you talk to it from Telegram or a terminal UI. For coding work, Attache dispatches worker Copilot sessions into project directories and streams the results back to you.

## Highlights

- Persistent orchestrator daemon for ongoing context and task routing
- Pane-based Ink terminal UI plus a readline fallback client
- Optional Telegram control from your phone
- Worker session management for repo-specific coding tasks
- Local HTTP API with server-sent events for real-time streaming
- Configurable model selection and auto-routing controls
- SQLite-backed state, memory, and session persistence

## Install

Requirements:

- Node.js 18+
- GitHub Copilot CLI installed and authenticated with `copilot login`

Install from npm:

```bash
npm install -g attache
```

Or use the install script:

```bash
curl -fsSL https://raw.githubusercontent.com/burkeholland/attache/main/install.sh | bash
```

## Quick start

### 1. Run setup

```bash
attache setup
```

Setup will:

- create or update local config
- let you choose an assistant display name
- optionally configure Telegram access

### 2. Make sure Copilot CLI is authenticated

```bash
copilot login
```

### 3. Start the daemon

```bash
attache start
```

To allow the daemon to modify its own source tree for supported workflows:

```bash
attache start --self-edit
```

### 4. Open a terminal client

Primary Ink UI:

```bash
attache tui
```

Readline fallback UI:

```bash
attache tui:legacy
```

### 5. Start talking to Attache

Example prompts:

- "Start working on the auth bug in ~/dev/myapp"
- "What sessions are running?"
- "Check on the api-tests session"
- "Kill the auth-fix session"
- "What changed in the last worker run?"

## Command reference

| Command | Description |
| --- | --- |
| `attache start` | Start the daemon |
| `attache tui` | Open the Ink terminal UI |
| `attache tui:legacy` | Open the readline fallback UI |
| `attache setup` | Run interactive setup |
| `attache update` | Install the latest published package update |
| `attache help` | Show CLI help |

### Start flags

| Flag | Description |
| --- | --- |
| `--self-edit` | Enable self-edit mode for the current daemon process |

## Terminal UIs

### Ink UI: `attache tui`

The Ink client is the primary local terminal experience. It renders four working areas:

- workers pane
- transcript pane
- inspector pane
- composer pane

It polls `/sessions` and `/diagnostics`, streams responses from `/stream`, submits prompts to `/message`, and uses `/cancel` for interruption.

#### Ink controls

| Key | Action |
| --- | --- |
| `Tab` | Cycle focus between panes |
| `Up` / `Down` | Change the selected worker when the workers pane is focused |
| `Enter` | Send the current composer text |
| `Esc` | Cancel the current in-flight response |
| `q` | Quit when focus is not in the composer |
| `Ctrl+C` | Quit the app |

### Readline UI: `attache tui:legacy`

The readline client remains available as a lightweight fallback.

#### Readline commands

| Command | Description |
| --- | --- |
| `/model [name]` | Show or switch the current model |
| `/memory` | Show stored memories |
| `/skills` | List installed skills |
| `/workers` | List active worker sessions |
| `/copy` | Copy the last response to the clipboard |
| `/status` | Daemon health check |
| `/restart` | Restart the daemon |
| `/cancel` | Cancel the current in-flight message |
| `/clear` | Clear the screen |
| `/help` | Show help |
| `/quit` | Exit the UI |
| `Escape` | Cancel a running response |

## Configuration and data

Attache stores its local state under `~/.attache`.

### Key paths

| Purpose | Path |
| --- | --- |
| Config env file | `~/.attache/.env` |
| SQLite database | `~/.attache/attache.db` |
| API bearer token | `~/.attache/api-token` |
| Session state | `~/.attache/sessions/` |
| User skills | `~/.attache/skills/` |
| TUI history | `~/.attache/tui_history` |
| TUI debug log | `~/.attache/tui-debug.log` |

### Config values

These values are loaded from the active env file:

| Key | Description |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `AUTHORIZED_USER_ID` | Numeric Telegram user ID allowed to control the bot |
| `API_PORT` | Local daemon API port, default `7777` |
| `COPILOT_MODEL` | Default Copilot model, default `claude-sonnet-4.6` |
| `WORKER_TIMEOUT` | Worker timeout in milliseconds, default `600000` |
| `ASSISTANT_DISPLAY_NAME` | Cosmetic assistant name shown in the UI and responses |
| `ATTACHE_SELF_EDIT` | Enable self-edit mode when set to `1` |

`ASSISTANT_DISPLAY_NAME` only changes display text. It does not change product identity, package names, file names, or API schema fields.

## Local daemon API

The daemon listens on `http://127.0.0.1:$API_PORT`.

Authentication:

- `/status` is public for local health checks
- all other routes require `Authorization: Bearer <token>`
- the token is stored in `~/.attache/api-token`

The response stream is schema-versioned so clients can evolve without immediately breaking older consumers.

### API surface

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/status` | Health check and active worker summary |
| `GET` | `/config/effective` | Effective runtime identity and config values |
| `GET` | `/sessions` | List worker sessions |
| `GET` | `/workers/:id` | Inspect a single worker |
| `GET` | `/workers/:id/logs?tail=200` | Fetch worker output and tailed log lines |
| `POST` | `/workers/:id/cancel` | Cancel and remove a worker |
| `GET` | `/diagnostics` | Runtime diagnostics, routing, process info, worker counts |
| `GET` | `/stream` | Server-sent event response stream |
| `POST` | `/message` | Queue a user prompt for the orchestrator |
| `POST` | `/cancel` | Cancel the current in-flight orchestrator message |
| `GET` | `/model` | Read the current model |
| `POST` | `/model` | Change and persist the current model |
| `GET` | `/auto` | Read auto-routing config |
| `POST` | `/auto` | Update auto-routing config |
| `GET` | `/memory` | List stored memories |
| `GET` | `/skills` | List installed skills |
| `DELETE` | `/skills/:slug` | Remove a local skill |
| `POST` | `/restart` | Restart the daemon |
| `POST` | `/send-photo` | Send a photo through the configured Telegram bot |

## How it works

```text
Telegram ----> Attache Daemon <---- Terminal UI
                    |
             Orchestrator Session
                    |
        +-----------+-----------+
        |           |           |
      Worker 1    Worker 2    Worker N
```

### Core pieces

- **Daemon**: runs the Copilot SDK client, local HTTP API, and optional Telegram bot
- **Orchestrator**: the long-lived Copilot session that receives every message and decides whether to answer directly or delegate work
- **Workers**: short-lived Copilot sessions created in explicit project directories for coding tasks
- **Terminal clients**: local frontends that connect to the daemon instead of talking to Copilot directly

### Working directory model

- the orchestrator inherits the directory where you launched `attache start`
- each worker gets an explicit `workingDirectory` chosen for the task
- Attache state stays under `~/.attache` regardless of launch directory

## Development

```bash
# Clone and install
git clone https://github.com/burkeholland/attache.git
cd attache
npm install

# Run the daemon
npm run daemon

# Run the Ink UI directly in another terminal
npm run tui

# Run the readline fallback UI directly
npm run tui:legacy

# Watch the daemon in development
npm run dev

# Build TypeScript
npm run build
```

## Acknowledgements

Attache grows directly out of Max. Thanks to Max for the foundation, the workflows, and the users who got the project this far.
