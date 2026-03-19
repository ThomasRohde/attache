# PRD: Unified Customization Architecture

## Problem Statement

Attache supports three backends (Copilot SDK, Claude Agent SDK, OpenAI Codex) but uses their customization capabilities inconsistently. Research reveals all three backends support skills, MCP servers, custom tools, and layered instructions natively — but Attache only leverages these features for Copilot. Claude and Codex fall back to lossy system-message injection for skills, lack custom tools entirely, and miss out on each SDK's built-in identity and prompt infrastructure.

## Design Principle

**Unify the control plane, not the runtime.** Skills, instructions, MCP bindings, and profiles are managed centrally by Attache's `CustomizationResolver`. Each backend receives customizations projected into its **native format** via backend-specific projectors — not a lowest-common-denominator injection.

## Artifact Types

| Type | Purpose | Examples |
|---|---|---|
| **Instructions** | Stable policy, coding conventions, always-on guidance | CLAUDE.md, AGENTS.md, copilot-instructions.md |
| **Skills** | Reusable workflow playbooks, invoked on demand | SKILL.md directories |
| **MCP bindings** | Tool/resource transport connections | stdio/http/sse server configs |
| **Profiles** | Named bundles selecting subsets of the above | orchestrator profile, worker profile |

## Scope Resolution Precedence

```
bundled < global (~/.agents/) < user (~/.attache/) < repo (.attache/) < path < session < worker
```

---

## Phase 1: Unlock Native Backend Capabilities

Quick wins — enable features each SDK already supports but Attache doesn't use.

### Claude Backend

- [x] Enable `settingSources: ['user', 'project']` so Claude discovers skills from `~/.claude/skills/` and `.claude/skills/` natively
- [x] Switch system prompt from full string replacement to `{ type: 'preset', preset: 'claude_code', append: '<attache instructions>' }` so Claude keeps its built-in identity, tool descriptions, and safety guardrails
- [x] Use `createSdkMcpServer()` with `tool()` helper to expose Attache's custom tools (workers, memory, cron, etc.) as in-process MCP tools
- [x] Update capability flags to reflect actual SDK capabilities (`customTools: true`, `skillDirectories: true`, `vision: true`)

### Codex Backend

- [x] Set `experimentalApi: true` in the initialize handshake to enable dynamic tools and other experimental features
- [x] Use `baseInstructions` and `developerInstructions` fields on `thread/start` instead of prepending system message as text prefix to first turn
- [x] Expose Attache's custom tools as `dynamicTools` on `thread/start` so the Codex agent can call workers, memory, cron, etc.
- [x] Handle `dynamicToolCall` server requests and respond with `DynamicToolCallResponse`
- [x] Update capability flags (`customTools: true`, `skillDirectories: true`, `vision: true`)

### Copilot Backend

- [x] Support `mode: 'append'` system message when `appendInstructions` is provided (falls back to `mode: 'replace'` via `systemMessage` for backward compat)
- [x] Pass `disabledSkills` from session config if specified
- [x] Pass `customAgents` and `hooks` in SessionConfig passthrough

### Shared

- [x] Update `BackendCapabilities` and `SessionConfig` types (`appendInstructions`, `dynamicTools`, `DynamicToolSpec`)
- [x] Ensure all backends report accurate capabilities after changes
- [x] Build `getAttacheAppendInstructions()` for append-mode system message decomposition
- [ ] Verify skill discovery works end-to-end on each backend (manual test — requires running daemon)

---

## Phase 2: CustomizationResolver & Backend Projectors

Build the central resolver that materializes customization bundles and projects them per-backend.

### Core Types

- [x] Define `Instruction`, `ResolvedSkill`, `McpBinding`, `Profile` types in `src/customization/types.ts`
- [x] Define `EffectiveBundle` type (the resolved output)
- [x] Define `CustomizationResolver` interface and implement default resolver

### Resolver Implementation

- [x] Implement scope scanning: bundled → global → user (repo → path deferred to Phase 4)
- [x] Implement skill resolution with deduplication (higher scope wins)
- [x] Implement instruction resolution with scope metadata
- [x] Implement MCP binding resolution with merge semantics
- [x] Implement profile loading and application (filter skills/MCP/instructions by profile)

### Backend Projectors

- [x] Implement `CopilotProjector` — maps bundle to Copilot SessionConfig (skillDirectories, mcpServers, systemMessage)
- [x] Implement `ClaudeProjector` — maps bundle to Claude config (skill sync, appendInstructions)
- [x] Implement `CodexProjector` — maps bundle to Codex config (skill sync, appendInstructions)

### Skill Syncing

- [x] Implement skill directory syncing for Claude (copy selected skills to `~/.claude/skills/`)
- [x] Implement skill directory syncing for Codex (copy to `~/.agents/skills/`)
- [x] Add cleanup logic to remove stale synced skills (manifest-based)

### Integration

- [x] Replace `getSessionConfig()` and `buildSessionConfig()` with resolver + projector pipeline
- [x] Update orchestrator session creation to use `resolveSessionConfig()`
- [ ] Update worker session creation to use resolver with worker profile (deferred to Phase 3)

---

## Phase 3: Profiles & Worker Customization

- [x] Define orchestrator and worker roles in the resolver (`role: "orchestrator" | "worker"`)
- [x] Add profile selection to `create_worker_session` tool (optional `profile` parameter)
- [x] Workers receive materialized bundles via resolver+projector pipeline (skills, MCP, instructions)
- [x] Workers explicitly exclude custom tools (`tools: undefined`)
- [x] Add `~/.attache/profiles/` directory scanning with YAML parsing
- [x] Profile YAML format with include/exclude filtering for skills, MCP, and instructions

---

## Phase 4: Repo/Path Scoping & Package Discovery

- [x] Add `.attache/` repo-level customization directory support
- [x] Implement `.attache/skills/` repo-scoped skill discovery
- [x] Implement `.attache/instructions/*.instructions.md` path-scoped instructions (with `applyTo` frontmatter stored as `tags: ["applyTo:<glob>"]`)
- [x] Implement `.attache/mcp.json` repo-scoped MCP config (merged over user-scope)
- [x] Implement `.attache/profiles/` repo-scoped profiles (repo overrides user)
- [x] Git root detection via `findGitRoot()` walk
- [x] Resolver precedence: bundled < global < user < repo < path

---

## Backend Capability Reference

### Copilot SDK (@github/copilot-sdk v0.1.26)

- **Skills**: Native `skillDirectories[]` in SessionConfig. Auto-discovers from `.github/skills/`, `~/.copilot/skills/`, `~/.agents/skills/`.
- **Instructions**: 3-tier — global (`~/.copilot/copilot-instructions.md`), repo (`.github/copilot-instructions.md`), path-scoped (`.github/instructions/*.instructions.md`). `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` env var.
- **MCP**: `mcpServers` in SessionConfig (stdio, http, sse). Config at `~/.copilot/mcp-config.json`.
- **Custom tools**: Native `tools[]` with handlers.
- **System message**: `{ mode: 'append' | 'replace', content }`.
- **Extras**: `customAgents[]`, 6 session hooks, `disabledSkills[]`, `availableTools/excludedTools`, `infiniteSessions`, `reasoningEffort`.

### Claude Agent SDK (@anthropic-ai/claude-agent-sdk v0.2.76)

- **Skills**: Via `settingSources: ['user', 'project']` → loads `~/.claude/skills/` and `.claude/skills/`.
- **Instructions**: CLAUDE.md via `settingSources`. System prompt as string (replace) or `{ type: 'preset', preset: 'claude_code', append }`.
- **MCP**: `mcpServers` (stdio, sse, http, in-process SDK via `createSdkMcpServer()`). Runtime management via `setMcpServers()`.
- **Custom tools**: Via `createSdkMcpServer()` + `tool()` helper. Tools registered as `mcp__<server>__<tool>`.
- **Extras**: `plugins[]`, `agents` (subagents), hooks, structured output, thinking config, effort levels, sandbox.

### Codex CLI (@openai/codex v0.114.0)

- **Skills**: Native scan from `~/.agents/skills`, `.agents/skills`, system, admin scopes. SKILL.md format. `skills/list` RPC.
- **Instructions**: AGENTS.md (global `~/.codex/AGENTS.md`, project walks git root to cwd). `baseInstructions` + `developerInstructions` on `thread/start`.
- **MCP**: Via `config.toml` (stdio, streamable HTTP, OAuth). RPC: `mcpServerStatus/list`, `config/mcpServer/reload`.
- **Custom tools**: `dynamicTools[]` on `thread/start` (requires `experimentalApi: true`). Server sends `dynamicToolCall` request, client responds with `DynamicToolCallResponse`.
- **Extras**: profiles, web search, thread fork/rollback/compact, feature flags (memories, multi_agent, plugins).
