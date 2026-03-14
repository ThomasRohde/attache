# GitHub Copilot SDK (TypeScript) — Deep Research

## Executive Summary

The TypeScript SDK is an ESM package, `@github/copilot-sdk`, that gives applications programmatic control over GitHub Copilot CLI via JSON-RPC; the repository still labels the SDK as technical preview.[^1][^2]

Its core abstraction split is straightforward: `CopilotClient` manages CLI transport/process and session lifecycle, while `CopilotSession` manages per-session messaging and event-driven interaction.[^3][^4][^14]

The TypeScript surface is broad: custom tools, hooks, user-input handling, MCP servers, custom agents, skills, BYOK/custom providers, and infinite-session compaction are all first-class configuration surfaces rather than external wrappers around the SDK.[^5][^6]

A real consumer—`Attache`—uses the SDK exactly this way: it creates and resumes persistent sessions, defines tools with `defineTool`, and streams `assistant.message_delta` plus `tool.execution_complete` into its UI loop.[^7][^8]

## Architecture / System Overview

At a high level, the TypeScript SDK is a process-and-protocol wrapper around Copilot CLI, not a direct model API client. By default the client spawns a bundled/local Copilot CLI process, connects over stdio or TCP, verifies protocol compatibility, and then issues JSON-RPC requests such as `session.create`, `session.resume`, `session.send`, `session.list`, and `session.delete`.[^2][^3][^9][^14][^15]

```text
Your app
  |
  |  CopilotClient.start()
  v
CopilotClient
  |-- spawn bundled Copilot CLI (default) OR connect to cliUrl
  |-- verify protocol version
  |
  |  JSON-RPC
  v
Copilot CLI server
  |-- creates/resumes session workspace
  |-- runs model turns
  |-- requests permissions / tool execution / user input
  |
  v
CopilotSession
  |-- dispatches events
  |-- invokes tool handlers
  |-- invokes permission handler
  |-- invokes hooks / user-input handler
  v
Your UI / tool code / telemetry
```

Two design choices matter operationally. First, `autoStart` defaults to `true`, so `createSession()` and `resumeSession()` will bring up the underlying CLI automatically when the client is disconnected. Second, when you point the client at an external server via `cliUrl`, the SDK rejects local auth knobs like `githubToken` and `useLoggedInUser`, explicitly treating authentication as the external server's concern.[^3][^12]

## Core Package Shape and Runtime Constraints

The package is published as `@github/copilot-sdk`, ships ESM entrypoints, and exposes both the main package export and a secondary `./extension` export.[^1]

The getting-started flow expects Copilot CLI to be installed and authenticated before you run SDK code, and the documented TypeScript bootstrap still starts with `npm install @github/copilot-sdk tsx` in a new project.[^10]

One caveat: the current getting-started guide says Node.js 18+, but the TypeScript package metadata at the repository head declares `node >=20.0.0`, and the `0.1.26` artifact pinned by `Attache` also declares `node >=20.0.0`. Treat the package metadata as the safer source of truth when you choose a runtime floor.[^1][^10][^11]

## CopilotClient

`CopilotClient` is the transport/process orchestrator. Its constructor validates mutually exclusive connection options, parses `cliUrl` for remote-server mode, defaults to the bundled CLI path when `cliUrl` is absent, defaults `useStdio` to `true`, defaults `autoStart` to `true`, and defaults `useLoggedInUser` to `false` only when a `githubToken` is supplied.[^3][^12]

`start()` either launches the CLI server or connects to an external server, then establishes the JSON-RPC connection and verifies protocol compatibility. `stop()` performs graceful teardown by disconnecting active sessions, closing the transport, and terminating the CLI process if this client spawned it, while explicitly preserving on-disk session state unless the caller deletes it first.[^9]

The model-discovery path is intentionally cached. `listModels()` serializes concurrent callers with a promise lock, caches the first successful result to avoid repeated backend calls, and lets applications replace CLI-backed discovery with a custom `onListModels` implementation.[^13]

`createSession()` and `resumeSession()` are the most important client APIs. Both require `onPermissionRequest`, eagerly create/register a `CopilotSession` before issuing the RPC so early events are not lost, and send a large session configuration object that can include tools, system-message policy, provider/BYOK config, hooks, user-input handling, working directory, streaming, MCP servers, custom agents, skills, infinite-session settings, and early `onEvent` registration.[^5][^14]

The session-administration APIs are thin JSON-RPC wrappers: `deleteSession()` calls `session.delete` and removes the session from the local map, while `listSessions()` calls `session.list` and supports filtered enumeration.[^15]

## CopilotSession

`CopilotSession` is the conversation/runtime object. `send()` issues `session.send` with a prompt, optional attachments, and an optional delivery mode; `sendAndWait()` layers on top by subscribing to session events, then resolving on `session.idle` with the last `assistant.message`, or rejecting on `session.error` / timeout.[^4]

That implementation detail matters because it tells you how to integrate the SDK correctly: even when you use `sendAndWait()`, all session events are still flowing through your handlers, so `sendAndWait()` is a convenience fence rather than a separate non-streaming path.[^4]

Event subscription is flexible. `session.on("event.type", handler)` gives typed subscriptions, while `session.on(handler)` gives wildcard access to every event; both forms return an unsubscribe function.[^16]

Cleanup is explicit. `disconnect()` sends `session.destroy` and clears in-memory handlers, while `destroy()` is now just a deprecated alias; the class also supports `Symbol.asyncDispose`, so `await using` can manage cleanup automatically.[^17]

Internally, session objects are the bridge between Copilot CLI broadcasts and your app code. When the CLI emits an external tool request, the session looks up the registered tool handler, passes through `traceparent`/`tracestate`, normalizes the handler result, and answers via `tools.handlePendingToolCall`. Permission broadcasts are handled similarly through `permissions.handlePendingPermissionRequest`.[^18]

The session also stores the handlers that make advanced integrations work: `registerTools`, `registerPermissionHandler`, `registerUserInputHandler`, and `registerHooks` attach your callbacks, while `_handleHooksInvoke()` maps wire-level hook names to the TypeScript hook object members (`onPreToolUse`, `onPostToolUse`, `onUserPromptSubmitted`, `onSessionStart`, `onSessionEnd`, `onErrorOccurred`). The same block also contains the v2 compatibility adapter for permission requests, which is a good reminder that protocol compatibility is still an active concern in the SDK.[^19]

## Type System and Extension Points

`types.ts` is effectively the contract surface for the TypeScript SDK. `SessionConfig` includes the model, reasoning effort, config directory, custom tools, system-message policy, allow/deny tool lists, BYOK provider config, permission and user-input handlers, hook callbacks, working directory, streaming toggle, MCP servers, custom agents, skills, infinite-session config, and early `onEvent` subscription.[^5]

`MessageOptions` supports plain prompts plus file/directory/selection attachments and a delivery `mode` of `"enqueue"` or `"immediate"`.[^6]

Tool integration is intentionally lightweight. `defineTool()` is a tiny helper that takes a name, optional description, optional Zod/JSON-schema parameters, and a handler, returning a `Tool<T>` descriptor. Permission control is likewise small but explicit: the SDK defines a `PermissionRequest` union keyed by request kind and ships `approveAll` as a built-in handler that always returns `{ kind: "approved" }`.[^20]

Two advanced config groups are worth calling out:

| Surface | What it configures | Key TypeScript contract |
|---|---|---|
| MCP | External tool providers exposed over stdio/local or HTTP/SSE | `MCPLocalServerConfig`, `MCPRemoteServerConfig`, `MCPServerConfig`[^6] |
| Custom agents | Sub-agent personas with their own prompt/tool scopes and optional MCP | `CustomAgentConfig` with `name`, `prompt`, `tools?`, `mcpServers?`, `infer?`[^6] |

The SDK's persistence model is also part of the type surface now. `InfiniteSessionConfig` exposes `enabled`, `backgroundCompactionThreshold` (default `0.80`), and `bufferExhaustionThreshold` (default `0.95`), and `SessionConfig` notes that infinite sessions are enabled by default to manage context limits and persistent workspaces.[^5][^6]

## Streaming Event Model

The streaming documentation is one of the clearest parts of the SDK. When `streaming: true` is enabled, the session emits both ephemeral real-time events and persisted milestone events under a common event envelope.[^21]

The important mental model is simple:

- `assistant.message_delta` is the incremental text stream.
- `assistant.message` is the final assembled assistant message.
- `tool.execution_*` events trace tool lifecycle.
- `session.idle` is the "the turn is done" signal.[^21][^22]

The payload contracts are rich enough to drive serious apps. `assistant.message_delta` carries `messageId`, `deltaContent`, and `parentToolCallId?`; `tool.execution_complete` carries `toolCallId`, `success`, `result?`, `error?`, telemetry, and `parentToolCallId?`; `session.idle` can expose background-task metadata.[^22]

The event reference explicitly distinguishes ephemeral events from persisted ones: ephemeral events are streamed live but not replayed on session resume.[^21]

The README and getting-started tutorial both show the intended TypeScript pattern: enable `streaming`, subscribe to `assistant.message_delta` and `session.idle`, send a prompt, and use `send()` / `sendAndWait()` only as the trigger, not as the display mechanism.[^23][^24]

`Attache` follows exactly that pattern in application code: it subscribes to `tool.execution_complete` and `assistant.message_delta`, keeps a running buffer of output, and then uses `sendAndWait()` as the completion fence.[^8]

## Hooks, Permissions, and User Input

Hooks are first-class session configuration. The hooks guide documents six callback points: `onSessionStart`, `onUserPromptSubmitted`, `onPreToolUse`, `onPostToolUse`, `onSessionEnd`, and `onErrorOccurred`. Each is optional, and returning `null` preserves default behavior.[^25]

The guide also shows that hooks are configured directly on session creation/resume, alongside `onPermissionRequest`.[^25]

The source reinforces two important facts. First, `onPermissionRequest` is mandatory today: both `createSession()` and `resumeSession()` throw if it is missing, and the unit tests have dedicated cases asserting that behavior.[^14][^26]

Second, `onUserInputRequest` is the switch that enables ask-user flows. The Node README calls out that it enables the `ask_user` tool, while the session source routes those requests through `registerUserInputHandler()` and `_handleUserInputRequest()`.[^19][^27]

The hook best-practices section is operationally sensible and worth following as-is: keep hooks fast because they run inline, return `null` when unchanged, be explicit about permission decisions, and never swallow critical errors without logging or alerting.[^28]

## Custom Agents, Skills, and MCP

The SDK's agentic composition model lives in the session config, not in a separate orchestration service. The custom-agents guide describes per-session agent definitions with their own prompt, tool scope, and optional MCP configuration; the runtime can infer which agent to delegate to based on the user's intent, and that delegation runs in an isolated sub-agent context while lifecycle events stream back to the parent session.[^29]

You can also preselect a custom agent at session creation via the top-level `agent` field, and you can disable automatic inference by setting `infer: false` on specific agents.[^6][^29]

MCP is equally first-class. The type surface distinguishes local/stdio servers (command, args, env, cwd) from remote HTTP/SSE servers (url, headers), and both variants support per-server tool allowlists plus timeouts.[^6]

Because `mcpServers` appears on both `SessionConfig` and `CustomAgentConfig`, you can attach tool servers either at the whole-session level or inside a single sub-agent definition.[^5][^6]

Skills are slightly less richly typed in the TypeScript layer, but they are still explicit configuration: `skillDirectories` tells the runtime where to load skills from and `disabledSkills` lets you suppress specific skill names. `Attache` uses both of these session surfaces in its persistent orchestrator session, which is good evidence that the feature is meant for real app composition rather than demos.[^5][^7]

## BYOK / Custom Providers

The BYOK story is configuration-driven rather than subclass-driven. The TypeScript provider model accepts `type` (`openai`, `azure`, `anthropic`), `baseUrl`, `apiKey`, `bearerToken`, `wireApi`, and Azure-specific API-version options.[^5][^30]

The README is clear that when you use a custom provider, you must specify `model` explicitly, and it gives examples for Ollama, generic OpenAI-compatible APIs, and Azure OpenAI.[^30]

This means the TypeScript SDK is not locked to GitHub-hosted Copilot inference even though the normal path is "Copilot CLI + GitHub auth." The same session surface can pivot to external provider endpoints while still composing with tools, hooks, streaming, and infinite sessions.[^5][^30]

## Observability and Trace Context

Telemetry is now a real platform feature, not just optional gloss. `TelemetryConfig` in the TypeScript types exposes `otlpEndpoint`, `filePath`, `exporterType`, `sourceName`, and `captureContent`, while the client maps those fields into CLI environment variables like `OTEL_EXPORTER_OTLP_ENDPOINT`, `COPILOT_OTEL_FILE_EXPORTER_PATH`, and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` before spawning the CLI.[^31][^32]

The observability guide adds the higher-level contract: give the client a `telemetry` object to instrument the CLI, and optionally provide `onGetTraceContext` in Node.js if you want your app's own OpenTelemetry spans joined into the same distributed trace as the CLI's spans.[^33]

The inbound half matters for tool authors. The observability guide says Node.js receives raw `traceparent` and `tracestate` strings on the tool invocation object, and the session implementation confirms that those fields are extracted from broadcast events and passed to tool handlers.[^18][^33]

Recent repository history shows this telemetry surface is still evolving: a March 2026 commit added OpenTelemetry support across all SDKs, including the callback-based Node trace-context integration model.[^34]

## Infinite Sessions and Persistence

The SDK treats persistence as a default behavior, not a niche add-on. The Node README says infinite sessions are on by default, automatically manage context pressure via background compaction, and persist session state to a workspace path exposed as `session.workspacePath` (for example, `~/.copilot/session-state/{sessionId}/`).[^35]

The TypeScript `SessionConfig` and `InfiniteSessionConfig` types line up with that description, including the compaction thresholds and the ability to disable the feature.[^5][^6]

On the implementation side, `createSession()` captures the `workspacePath` returned by the `session.create` RPC response and stores it on the session object, so workspace persistence is not just a documentation claim—it is part of the actual creation path.[^14]

`Attache` uses the persistence story heavily: it stores session IDs, calls `resumeSession()` when possible, and falls back to `createSession()` with `configDir`, `streaming`, `skillDirectories`, `mcpServers`, and `infiniteSessions` when it has to rebuild the orchestrator session.[^7]

## Real-World Consumer Example: `Attache`

`Attache` is a useful TypeScript consumer example because it uses the SDK as an application platform rather than as a toy script. Its setup flow creates a `CopilotClient` with `autoStart: true`, calls `start()`, and uses `listModels()` to populate a user-facing model picker filtered for enabled, non-internal models.[^36]

Its tool layer uses `defineTool()` to construct application-specific tools and starts worker sessions via `createSession()` with `workingDirectory`, `configDir`, and `approveAll` permission handling.[^7]

The persistent orchestrator path is even more illustrative: it tries `resumeSession()` first, passing model, config dir, streaming, system message, tools, MCP servers, skill directories, and infinite-session configuration, then falls back to `createSession()` with the same surface and persists the new session ID for future restarts.[^7]

For output rendering, it consumes `tool.execution_complete` and `assistant.message_delta` exactly the way the SDK docs imply: tool completions affect presentation state, while deltas are accumulated into the live assistant transcript.[^8]

## Important Adoption Caveats (Docs vs. Code)

Two source-level mismatches are worth knowing before you build on this SDK.

1. The current quick-start docs are missing a requirement the code and tests enforce. The getting-started guide and the Node README show `createSession({ model: ... })` examples with no `onPermissionRequest`, but the TypeScript source throws if `onPermissionRequest` is omitted, and the test suite has dedicated cases asserting that both `createSession()` and `resumeSession()` reject without it.[^10][^14][^26][^38]
2. The tutorial docs say Node 18+, but the TypeScript package metadata at the repository head—and the `0.1.26` artifact consumed by `Attache`—declare `node >=20.0.0`. If you are deploying this today, verify the package metadata for the exact version you install rather than relying on tutorial prose.[^1][^10][^11]

A minimal, source-aligned bootstrap looks more like this than the current quick-start snippets.[^4][^14][^20]

```typescript
import { CopilotClient, approveAll, defineTool } from "@github/copilot-sdk";
import { z } from "zod";

const echo = defineTool("echo", {
  description: "Echo text back",
  parameters: z.object({ text: z.string() }),
  handler: async ({ text }) => text,
});

const client = new CopilotClient({ autoStart: true });

const session = await client.createSession({
  model: "gpt-5",
  tools: [echo],
  streaming: true,
  onPermissionRequest: approveAll,
});

session.on("assistant.message_delta", (event) => {
  process.stdout.write(event.data.deltaContent);
});

await session.sendAndWait({ prompt: "Use the echo tool on 'hello'" });
await session.disconnect();
await client.stop();
```

## Key Repositories Summary

| Repository | Role | Key files |
|---|---|---|
| [github/copilot-sdk](https://github.com/github/copilot-sdk) | Official SDK repo; the TypeScript implementation lives under `nodejs/` and documents transport, sessions, events, hooks, providers, MCP, custom agents, and telemetry.[^1][^2][^14][^21][^25][^29][^33] | `nodejs/src/client.ts`, `nodejs/src/session.ts`, `nodejs/src/types.ts`, `docs/features/streaming-events.md`, `docs/features/hooks.md`, `docs/features/custom-agents.md`, `docs/observability/opentelemetry.md` |
| [burkeholland/attache](https://github.com/burkeholland/attache) | Real consumer example that exercises model listing, persistent session resume/create, `defineTool`, `approveAll`, skills, MCP, streaming deltas, and long-lived orchestrator state.[^7][^8][^11][^36] | `src/setup.ts`, `src/copilot/tools.ts`, `src/copilot/orchestrator.ts`, `package-lock.json` |

## Confidence Assessment

High confidence on the SDK's architecture, TypeScript surface area, and runtime data flow: those findings come straight from the current TypeScript source (`client.ts`, `session.ts`, `types.ts`) plus the feature/reference docs in the same repository.[^3][^4][^5][^18][^21][^25][^29][^33]

Medium confidence on tutorial/setup ergonomics, because the public docs currently lag the source in at least two places: permission-handler requirements and Node runtime minimum. I intentionally treated source code and tests as the authority whenever docs and implementation disagreed.[^10][^11][^14][^26][^38]

High confidence that the SDK is evolving rapidly rather than being frozen: the repository still labels it technical preview, recent commits added cross-SDK telemetry and reasoning-effort support, and the session implementation still contains explicit protocol-v2 compatibility handling.[^2][^19][^34][^37]

## Footnotes

[^1]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/package.json:1-21,68-70` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^2]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/README.md:1-5` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^3]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/src/client.ts:214-264` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^4]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/src/session.ts:131-210` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^5]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/src/types.ts:708-847` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^6]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/src/types.ts:586-701,929-967` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^7]: [burkeholland/attache](https://github.com/burkeholland/attache) `src/copilot/orchestrator.ts:173-220`; `src/copilot/tools.ts:54-90`.
[^8]: [burkeholland/attache](https://github.com/burkeholland/attache) `src/copilot/orchestrator.ts:274-290`.
[^9]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/src/client.ts:302-366` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^10]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `docs/getting-started.md:17-47` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^11]: [burkeholland/attache](https://github.com/burkeholland/attache) `package-lock.json:556-568`.
[^12]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/test/client.test.ts:282-345` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^13]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/src/client.ts:815-853` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^14]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/src/client.ts:553-705` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^15]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/src/client.ts:938-980` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^16]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/src/session.ts:242-296` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^17]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/src/session.ts:663-688` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^18]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/src/session.ts:340-435` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^19]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/src/session.ts:459-607` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^20]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/src/types.ts:251-328` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^21]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `docs/features/streaming-events.md:1-45` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^22]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `docs/features/streaming-events.md:267-390,752-763` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^23]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/README.md:323-372` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^24]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `docs/getting-started.md:248-266` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^25]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `docs/features/hooks.md:1-55` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^26]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/test/client.test.ts:1-26` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^27]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/README.md:104-118` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^28]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `docs/features/hooks.md:960-966` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^29]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `docs/features/custom-agents.md:1-45,217-230,320-330` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^30]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/README.md:544-602` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^31]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/src/types.ts:38-49` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^32]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/src/client.ts:1147-1192` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^33]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `docs/observability/opentelemetry.md:1-125` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^34]: [github/copilot-sdk](https://github.com/github/copilot-sdk) commit `f2d21a0b4aaf04745f347d8e194600bb5bc115c5` ("feat: add OpenTelemetry support across all SDKs").
[^35]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/README.md:470-508` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
[^36]: [burkeholland/attache](https://github.com/burkeholland/attache) `src/setup.ts:19-37`.
[^37]: [github/copilot-sdk](https://github.com/github/copilot-sdk) commit `ea90f076091371810c66d05590f65e2863f79bdf` ("Add reasoningEffort to setModel/session.model.switchTo across all SDKs (#712)").
[^38]: [github/copilot-sdk](https://github.com/github/copilot-sdk) `nodejs/README.md:26-56` @ `ea90f076091371810c66d05590f65e2863f79bdf`.
