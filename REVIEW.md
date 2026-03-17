# Review Report

This report collates focused review passes on correctness/runtime behavior, security/trust boundaries, and documentation/maintainability.

Verification run during review:

- `npm run build:ts` passed.
- `dotnet build gui/AttacheGui.csproj` passed.
- `npm test` does not run tests; it prints `No test suite yet`.

## High

1. `[Correctness]` Global cancel/clear aborts unrelated queued work and can strand cron executions in `running`.
The orchestrator uses one global `messageQueue` for TUI, Telegram, and background work. `cancelCurrentMessage()` drains the whole queue and aborts the active turn, regardless of source. If the aborted work is a cron execution, the scheduler cleanup path never runs because `sendToOrchestrator()` exits early on `cancelled`/`abort` errors without invoking the completion callback. That leaves the cron execution row and in-memory guard stuck until the 10-minute stale timeout expires.
Refs: `src/copilot/orchestrator.ts:74-83`, `src/copilot/orchestrator.ts:422-429`, `src/copilot/orchestrator.ts:440-443`, `src/copilot/orchestrator.ts:463-482`, `src/cron/scheduler.ts:64-68`, `src/cron/scheduler.ts:85-131`

2. `[Correctness/UX]` Background completions reuse the same SSE completion event as foreground replies, so cron/worker notifications can terminate the wrong GUI response.
`broadcastToSSE()` emits `createCompleteEvent()`, which produces a legacy `message` event. The GUI treats every `message` event as the end of the current assistant turn and calls `FinalizeAssistantMessage()`, clearing `StreamingContent` and `IsProcessing`. A cron summary or background worker completion can therefore finalize an unrelated in-flight foreground reply in the dashboard.
Refs: `src/daemon.ts:76-85`, `src/cron/scheduler.ts:111-117`, `src/api/server.ts:1136-1140`, `src/api/events.ts:54-60`, `gui/Services/SseService.cs:105-114`, `gui/Components/Pages/Dashboard.razor:181-185`, `gui/Services/AppState.cs:68-80`

3. `[Correctness]` Tool-driven model switches do not reliably take effect on the next turn.
The `switch_model` tool updates `config.copilotModel` and persists it, but unlike the API/Telegram `/model` paths it never resets the live orchestrator session. `executeOnSession()` continues reusing `orchestratorSession`, so a natural-language request that is fulfilled through the tool can report a successful switch while the next turn still runs on the old session/model.
Refs: `src/copilot/tools.ts:429-457`, `src/copilot/orchestrator.ts:50-54`, `src/copilot/orchestrator.ts:160-170`, `src/copilot/orchestrator.ts:307-351`

4. `[Security]` All three backends auto-approve privileged actions, so prompt injection or API-token compromise becomes direct local code execution.
The Copilot backend uses `onPermissionRequest: approveAll`, the Claude backend sets `permissionMode: "bypassPermissions"` plus `allowDangerouslySkipPermissions: true`, and the Codex backend auto-accepts approval requests. That removes any last-mile approval barrier between “can send a prompt” and “can execute commands / edit files as the daemon user”.
Refs: `src/backend/providers/copilot/index.ts:99-103`, `src/backend/providers/claude/index.ts:85-100`, `src/backend/providers/codex/index.ts:309-321`

5. `[Security]` Worker directory controls do not protect Attache's own secret store and are not confined to the configured workfolder.
Worker creation accepts arbitrary `working_dir` values and only blocks a short home-directory blacklist. `BLOCKED_WORKER_DIRS` omits `~/.attache`, even though `/send-photo` explicitly treats that directory as sensitive because it contains API tokens and keys. The same API surface also allows attaching to unrelated Copilot sessions elsewhere on the machine. In practice, the bearer token authorizes far broader filesystem reach than the product framing suggests.
Refs: `src/copilot/tools.ts:58-61`, `src/api/server.ts:193-235`, `src/api/server.ts:1082-1107`, `src/copilot/tools.ts:697-735`

## Medium

1. `[Correctness]` Cron overlap prevention can enqueue duplicate executions while the first run is only waiting in the orchestrator queue.
The scheduler marks a job as running before it enters the single serialized orchestrator queue. If other work keeps that queue busy for more than `MAX_EXECUTION_MS`, the next tick clears the “stale” running guard and starts a second copy even though the first one still has not completed.
Refs: `src/cron/scheduler.ts:17-20`, `src/cron/scheduler.ts:48-65`, `src/cron/scheduler.ts:85-131`, `src/copilot/orchestrator.ts:74-83`, `src/copilot/orchestrator.ts:369-389`, `src/copilot/orchestrator.ts:422-429`

2. `[Correctness/API]` Worker sessions are effectively one-shot even though the API/tool contract describes reusable sessions.
Both the public worker prompt endpoint and the `send_to_worker` tool destroy the session and delete its DB row in `finally`. That makes follow-up prompts impossible after each dispatch, contradicts the “existing worker session” / “follow-up instructions” contract, and makes session status inspection impossible after completion.
Refs: `src/api/server.ts:288-335`, `src/copilot/tools.ts:178-225`, `src/copilot/system-message.ts:156-160`

3. `[Correctness]` The per-job `notify_telegram` flag is stored and exposed but never honored during execution.
Cron jobs persist `notify_telegram`, and both the API and tool layer let callers create/update that flag, but the scheduler sends Telegram notifications for every completion whenever Telegram is enabled. Users cannot actually disable Telegram notifications per job.
Refs: `src/store/db.ts:67-80`, `src/store/db.ts:365-406`, `src/api/server.ts:803-865`, `src/copilot/tools.ts:520-589`, `src/cron/scheduler.ts:119-128`

4. `[Correctness/UI]` The GUI saves Telegram settings through `/config` but ignores the server's restart requirement.
`prepareConfigUpdate()` marks `AUTHORIZED_USER_ID` and `TELEGRAM_BOT_TOKEN` as `restartRequired`, but `ApiClient.PostConfigAsync()` only returns success/failure and discards the response body. The Telegram tab in `ConfigDialog` posts the config and stops there, so newly saved Telegram credentials may not take effect until the user manually restarts the daemon.
Refs: `src/config.ts:254-263`, `src/config.ts:303-311`, `gui/Services/ApiClient.cs:287-296`, `gui/Components/Dialogs/ConfigDialog.razor:218-225`

5. `[Security]` `/skills/:slug/content` joins unvalidated slugs into filesystem paths.
`readSkill()` does `join(dir, slug, "SKILL.md")` without the traversal guard used by the update/delete paths, and the route passes `req.params.slug` through unchanged. If encoded slashes or equivalent traversal input reach the route parameter, the endpoint can escape the skill roots and read unintended `SKILL.md` files.
Refs: `src/api/server.ts:707-715`, `src/copilot/skills.ts:133-151`

6. `[Documentation]` README still documents a routing subsystem and `/auto` API that do not exist.
The public docs still advertise auto-routing, `/auto` REST endpoints, and `src/copilot/router.ts`, but the implementation no longer contains that module or those handlers. The same section also says `tools.ts` contains 14 tools while the registry now defines substantially more. This makes the README unreliable as an integration and operations reference.
Refs: `README.md:14`, `README.md:96-97`, `README.md:148-151`, `README.md:169-173`, `README.md:218-220`, `src/copilot/tools.ts:16-40`

7. `[Engineering]` There is no automated test suite, and CI does not cover backend changes.
`npm test` is a placeholder, and the only GitHub Actions workflow in the repo is a GUI build that only triggers on `gui/**` changes. High-risk backend paths such as the orchestrator queue, cron execution, config persistence, and the HTTP API have no automated regression coverage.
Refs: `package.json:15-26`, `.github/workflows/build-gui.yml:3-11`, `.github/workflows/build-gui.yml:16-55`

## Low

1. `[Capabilities/API]` `/capabilities` advertises `/cron` as a built-in slash command even though the built-in dispatcher does not implement it.
Unknown slash commands fall through to the model, so `/cron` may still work opportunistically via prompting, but the capabilities manifest overstates what the server itself implements. Any client using `/capabilities` as a hard contract will be misled.
Refs: `src/api/server.ts:415-489`, `src/api/server.ts:924-939`

2. `[Documentation]` Configuration documentation lags the actual supported settings.
`.env.example` and the README config table omit several supported runtime options, including `WORKER_TIMEOUT`, `ATTACHE_BACKEND`, `ATTACHE_WORKFOLDER`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `ATTACHE_PREVENT_SLEEP`. That forces users to treat the source as the real config reference.
Refs: `.env.example:1-11`, `README.md:104-113`, `src/config.ts:37-49`, `src/config.ts:52-64`

## Assumptions

- This was primarily a static review. I did not run end-to-end Telegram, cron, or API interaction scenarios.
- The path-traversal finding for `/skills/:slug/content` assumes traversal input can reach `req.params.slug` after routing/decoding.
- The severity of the approval-bypass findings assumes the bearer token and chat surfaces are intended to have narrower authority than “full local automation as the daemon user”.
