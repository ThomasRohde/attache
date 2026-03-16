# Feature Suggestions for Attache

Inspired by [Hermes Agent](https://github.com/NousResearch/hermes-agent) and gaps in the current architecture.

---

## 1. Cron Scheduler / Scheduled Tasks

**What**: Built-in task scheduling so Attache can run recurring jobs autonomously — daily reports, nightly backups, periodic monitoring, morning briefings.

**Why**: Attache already runs as a 24/7 daemon, making it a natural fit for scheduled automation. Hermes Agent's cron scheduler is one of its most compelling features — it turns the agent from reactive to proactive.

**Implementation sketch**:
- New `schedules` table in SQLite: `id`, `cron_expression`, `prompt`, `channel` (telegram/tui), `enabled`, `last_run`, `next_run`
- New tools: `schedule_task`, `list_schedules`, `remove_schedule`
- A `node-cron` or custom cron evaluator in the daemon loop that fires prompts into `sendToOrchestrator` at the right times
- Results delivered to the specified channel (or all channels)
- API endpoints: `GET /schedules`, `POST /schedules`, `DELETE /schedules/:id`

**Example use cases**:
- "Every morning at 8am, check my GitHub notifications and summarize them on Telegram"
- "Every Friday at 5pm, generate a weekly summary of what we worked on"
- "Every 6 hours, check if the staging server is healthy"

---

## 2. Sub-Agent Spawning (Parallel Workstreams)

**What**: Allow the orchestrator to spawn isolated sub-agents that each get their own conversation context and can work in parallel, then report back.

**Why**: Currently workers are fire-and-forget with a single prompt. A sub-agent pattern would allow multi-turn autonomous workflows — e.g., "research this topic, then write a document based on your findings" — without blocking the orchestrator.

**Implementation sketch**:
- Extend `create_worker_session` to support a `plan` parameter: a list of sequential prompts the worker executes autonomously
- Add a `spawn_subagent` tool that creates an isolated agent with its own system message and goal
- Sub-agents can call tools, make decisions, and return a structured result
- Progress events streamed to the orchestrator via the existing `feedBackgroundResult` mechanism

---

## 3. Autonomous Skill Self-Improvement

**What**: When Attache uses a skill and encounters issues or discovers a better approach, it should be able to update the skill's SKILL.md automatically.

**Why**: Hermes Agent's skills self-improve during use. Attache already has `learn_skill` but learned skills are static after creation.

**Implementation sketch**:
- After a skill-driven task completes, the orchestrator evaluates the outcome
- If the task failed or required workarounds, prompt the orchestrator to update the skill
- Add a `improve_skill` tool that reads the existing SKILL.md, appends lessons learned, and writes it back
- Track skill usage stats in SQLite: `skill_usage` table with `slug`, `used_at`, `outcome` (success/failure/partial)

---

## 4. Enhanced Memory with FTS5 and Summarization

**What**: Upgrade the memory system from simple `LIKE` search to SQLite FTS5 full-text search, and add periodic memory summarization/consolidation.

**Why**: As memories grow, `LIKE` queries become slow and imprecise. Hermes Agent uses FTS5 with LLM summarization for cross-session recall. Attache's memory system is functional but basic.

**Implementation sketch**:
- Create an FTS5 virtual table mirroring the `memories` table
- Replace `searchMemories` LIKE query with FTS5 `MATCH` queries (supports ranking, proximity, boolean operators)
- Add a `consolidate_memories` routine that periodically asks the orchestrator to summarize related memories into higher-level insights
- Add memory categories: `insight` (auto-generated summaries), `context` (project-level context snapshots)

---

## 5. Multi-Platform Messaging (Discord, Slack, Signal)

**What**: Extend beyond Telegram to support Discord, Slack, and potentially Signal/WhatsApp as input channels.

**Why**: Hermes Agent supports 6+ messaging platforms from a single gateway. Many developers live in Slack or Discord rather than Telegram.

**Implementation sketch**:
- Abstract the Telegram bot interface into a `Channel` interface: `sendMessage(text)`, `sendPhoto(path)`, `onMessage(handler)`
- Implement `DiscordChannel` (discord.js), `SlackChannel` (@slack/bolt)
- Each channel gets its own config section in `.env`
- The existing `MessageSource` type already supports extension — add `"discord"`, `"slack"` variants
- Route proactive notifications to all enabled channels (or channel-specific)

---

## 6. Webhook / Event System

**What**: Allow external services to push events into Attache via webhooks, triggering automated responses.

**Why**: This turns Attache into a reactive automation hub — GitHub push hooks, CI/CD notifications, monitoring alerts can all trigger intelligent responses.

**Implementation sketch**:
- New API endpoint: `POST /webhooks/:name` — receives arbitrary JSON payloads
- Configurable webhook handlers in `~/.attache/webhooks/` — each a small YAML/JSON file mapping webhook name → prompt template
- Incoming webhooks inject a system message into the orchestrator: `"[Webhook: github-push] Payload: {...}"`
- Optional: auto-create workers for webhook-triggered tasks

**Example use cases**:
- GitHub push → "Review the latest commit and summarize changes on Telegram"
- CI failure → "Investigate the build failure and suggest a fix"
- Uptime monitor → "The staging server is down — check logs and report"

---

## 7. User Modeling / Personality Adaptation

**What**: Build a persistent user profile that evolves over time — communication style preferences, expertise level, working hours, project context.

**Why**: Hermes Agent uses "Honcho dialectic user modeling" to build a deepening model of the user. Attache has basic memories but no structured user profile.

**Implementation sketch**:
- Auto-maintained `USER.md` file in `~/.attache/` — structured profile updated by the orchestrator
- Sections: communication preferences, expertise areas, active projects, working hours, tool preferences
- Orchestrator system message includes a condensed user profile
- Periodic "nudge" where Attache asks clarifying questions to fill profile gaps
- The `remember` tool already captures preferences — this adds structure and auto-curation

---

## 8. Skill Hub Integration / Skill Marketplace

**What**: Connect to a community skill repository (like Hermes Agent's agentskills.io or skills.sh) for one-click skill installation.

**Why**: Attache already has the `find-skills` bundled skill that searches skills.sh. Making this a first-class feature with browsing, ratings, and one-click install would dramatically expand capabilities.

**Implementation sketch**:
- API endpoint: `GET /skills/hub?query=...` — proxies to skills.sh search
- API endpoint: `POST /skills/hub/install` — downloads and installs a skill from the hub
- GUI integration: skill browser panel with search, preview, install button
- Skill verification: checksum validation, source attribution, security warnings for broad-access skills
- Contribution flow: `POST /skills/hub/publish` for sharing local skills

---

## 9. Docker / Sandboxed Execution Backend

**What**: Run worker sessions inside Docker containers or other sandboxed environments for security isolation.

**Why**: Currently workers run with the same permissions as the daemon. For tasks involving untrusted code, package installations, or destructive operations, sandboxing prevents damage. Hermes Agent supports 6 terminal backends including Docker, SSH, and Singularity.

**Implementation sketch**:
- New config: `WORKER_BACKEND=local|docker|ssh`
- `DockerWorkerBackend`: spins up a container with the working directory mounted, runs the Copilot/Claude CLI inside it
- `SSHWorkerBackend`: executes on a remote machine via SSH
- Workers declare their required isolation level; the orchestrator picks the appropriate backend
- Configurable base images per project (e.g., `node:22`, `python:3.12`)

---

## 10. Web UI (Browser-Based Interface)

**What**: A lightweight web interface accessible from any browser, complementing the desktop Blazor GUI and Telegram.

**Why**: The Blazor GUI requires Windows + .NET 10. A web UI would make Attache accessible from any device — phones, tablets, Linux desktops, remote machines.

**Implementation sketch**:
- Serve static files from the existing Express server (port 7777)
- Simple SPA using vanilla JS or a lightweight framework (Preact, Lit)
- Reuse the existing SSE `/stream` + `/message` endpoints — the protocol is already web-friendly
- Features: chat interface, worker status panel, memory browser, skill manager, settings
- Progressive Web App (PWA) manifest for mobile install

---

## 11. Multi-Model Reasoning / Model Routing

**What**: Use different models for different tasks — a fast model for quick answers, a powerful model for complex coding, a specialized model for code review.

**Why**: Hermes Agent supports switching between 200+ models. Attache has model switching but always uses a single model for everything.

**Implementation sketch**:
- New config: `COPILOT_MODEL_FAST`, `COPILOT_MODEL_HEAVY`, `COPILOT_MODEL_REVIEW`
- The orchestrator uses the fast model by default
- Workers can be created with a specific model: `create_worker_session({model: "heavy"})`
- Add a `model_for_task` heuristic: simple questions → fast, coding tasks → heavy, code review → review
- Cost tracking: log model usage and estimated costs in SQLite

---

## 12. File Watch / Project Monitor

**What**: Watch directories for changes and proactively notify the user or take action.

**Why**: Combined with the cron scheduler, this makes Attache a proactive development assistant that notices when things change.

**Implementation sketch**:
- Use `fs.watch` or `chokidar` to monitor configured directories
- Configurable watch rules in `~/.attache/watches.json`: path pattern → action (notify, run prompt, create worker)
- Debounce rapid changes (file saves, git operations)
- Integration with the webhook system — file changes as internal events

**Example use cases**:
- Watch `package.json` → "Dependencies changed, should I run npm install?"
- Watch `*.test.ts` → "Test file modified, running tests..."
- Watch `.env` → "Environment config changed, restart recommended"

---

## Priority Ranking

| # | Feature | Impact | Effort | Priority |
|---|---------|--------|--------|----------|
| 1 | Cron Scheduler | High | Medium | **P0** |
| 10 | Web UI | High | Medium | **P0** |
| 6 | Webhook System | High | Low | **P1** |
| 4 | FTS5 Memory | Medium | Low | **P1** |
| 2 | Sub-Agent Spawning | High | Medium | **P1** |
| 11 | Multi-Model Routing | Medium | Low | **P1** |
| 5 | Multi-Platform Messaging | Medium | Medium | **P2** |
| 3 | Skill Self-Improvement | Medium | Medium | **P2** |
| 7 | User Modeling | Medium | Medium | **P2** |
| 8 | Skill Hub Integration | Medium | Medium | **P2** |
| 9 | Docker Sandbox | Medium | High | **P3** |
| 12 | File Watch | Low | Medium | **P3** |

---

## Sources

- [Hermes Agent — GitHub](https://github.com/NousResearch/hermes-agent)
- [Hermes Agent — Official Site](https://hermesagent.agency/)
- [Nous Research — Hermes Agent Announcement](https://nousresearch.com/hermes-agent/)
- [Agent Skills Hub](https://agentskills.io)
