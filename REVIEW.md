# Review Report

Scope for this pass:
- Reviewed correctness, security, documentation, and maintainability outside the in-progress cron feature.
- Cron-related findings are intentionally excluded per request.

Verification:
- `dotnet build gui/AttacheGui.csproj` succeeds.
- `npm run build:ts` currently fails only in cron-related code and is not part of the findings below.

## Findings

1. Critical — Backends default to unattended command and file-change approval, and tool-less backends are explicitly taught how to drive the privileged local API.
Why it matters: prompt injection from repository content, webpages, MCP/tool output, or skills can turn into arbitrary shell execution, file edits, worker creation, memory writes, skill changes, or daemon restarts without a human checkpoint.
Refs: `src/backend/providers/copilot/index.ts:99-103`, `src/backend/providers/claude/index.ts:85-92`, `src/backend/providers/codex/index.ts:309-315`, `src/backend/providers/codex/session.ts:74-80`, `src/backend/providers/codex/session.ts:121-138`, `src/copilot/system-message.ts:56-60`, `src/copilot/system-message.ts:204-236`

2. High — A blank `~/.attache/api-token` disables authentication for the local API.
Why it matters: if the token file exists but contains only whitespace, startup accepts it, `apiToken` becomes empty after `.trim()`, and the auth middleware skips protection on every route because `!apiToken` short-circuits to `next()`.
Refs: `src/api/server.ts:37-42`, `src/api/server.ts:52-57`

3. High — Worker directory protections do not block Attache’s own state directory under `~/.attache`.
Why it matters: workers can be started inside the directory that holds the SQLite database, `.env`, session state, and API bearer token, so a compromised or prompt-injected worker can read or modify Attache’s own credentials and persistent state.
Refs: `src/paths.ts:5-15`, `src/copilot/tools.ts:59-62`, `src/copilot/tools.ts:103-110`, `src/api/server.ts:212-219`

4. Medium — Startup still trusts the current working directory’s `.env` file.
Why it matters: launching Attache from an untrusted repository allows that repository to inject unset configuration values such as backend selection, self-edit mode, API keys, Telegram settings, or workfolder into a long-lived daemon process.
Refs: `src/config.ts:6-10`

5. Medium — Public and internal docs describe API and architecture that no longer exist.
Why it matters: README still documents `/auto` endpoints and a `src/copilot/router.ts` module that are not present, while the implementation exposes `/models` and `/backend`. Internal docs also undercount the tool surface, which increases onboarding and review friction.
Refs: `README.md:14`, `README.md:150-172`, `README.md:218-219`, `CLAUDE.md:84`, `src/api/server.ts:571-638`, `src/copilot/tools.ts:17-40`

6. Medium — Telegram setup errors still direct users to a nonexistent `attache setup` command.
Why it matters: when Telegram auth is misconfigured, the product tells users to follow a CLI flow that does not exist, even though the repo docs say first-run setup is GUI-driven and the CLI only supports `start`, `update`, and `help`.
Refs: `src/telegram/bot.ts:17-20`, `src/telegram/bot.ts:236`, `src/cli.ts:21-30`, `CLAUDE.md:33-35`

7. Medium — The orchestration core is still effectively untestable in practice.
Why it matters: there is no real test runner, and `sendToOrchestrator()` returns `Promise<void>` while doing the real work inside a detached async block. That makes completion, retry, and failure handling depend on callbacks and side effects instead of awaitable contracts.
Refs: `package.json:23`, `src/copilot/orchestrator.ts:399-459`

## Residual Risk

- This pass excludes the in-flight cron work, so scheduler-specific correctness and contract issues are intentionally not covered here.
- The largest remaining risk area is prompt-injection resistance across repo content, external tools, and worker sessions, because the current backend defaults optimize for autonomy rather than containment.
