import { z } from "zod";
import { defineTool } from "../backend/providers/copilot/tool-bridge.js";
import type { Tool } from "../backend/providers/copilot/tool-bridge.js";
import type { BackendClient, BackendSession, SessionConfig } from "../backend/types.js";
import { getDb, addMemory, searchMemories, removeMemory, logSkillUsage, getSkillStats } from "../store/db.js";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, sep, resolve } from "path";
import { homedir } from "os";
import { listSkills, createSkill, removeSkill, updateSkill, readSkill } from "./skills.js";
import { config, persistModel } from "../config.js";
import { SESSIONS_DIR } from "../paths.js";
import { getCurrentSourceChannel } from "./orchestrator.js";
import { createCronJob as dbCreateCronJob, getCronJobs, updateCronJob, deleteCronJob } from "../store/db.js";
import { validateCronExpression, rescheduleJob, unscheduleJob } from "../cron/scheduler.js";
import { DefaultResolver } from "../customization/resolver.js";
import { createProjector } from "../customization/projectors/index.js";
import { LOG_PREFIX } from "../identity.js";

export const TOOL_REGISTRY: { name: string; description: string; category: string }[] = [
  { name: "create_worker_session", description: "Create a new worker session in a specific directory", category: "workers" },
  { name: "send_to_worker", description: "Send a prompt to an existing worker session and wait for its response", category: "workers" },
  { name: "list_sessions", description: "List all active worker sessions with their name, status, and working directory", category: "workers" },
  { name: "check_session_status", description: "Get detailed status of a specific worker session", category: "workers" },
  { name: "kill_session", description: "Terminate a worker session and free its resources", category: "workers" },
  { name: "list_machine_sessions", description: "List all Copilot CLI sessions on this machine", category: "sessions" },
  { name: "attach_machine_session", description: "Attach to an existing Copilot CLI session on this machine", category: "sessions" },
  { name: "list_skills", description: "List all available skills", category: "skills" },
  { name: "learn_skill", description: "Teach Attache a new skill by creating a SKILL.md instruction file", category: "skills" },
  { name: "uninstall_skill", description: "Remove a skill from the local skills directory", category: "skills" },
  { name: "improve_skill", description: "Update a local skill's instructions based on usage experience", category: "skills" },
  { name: "log_skill_usage", description: "Log the outcome of using a skill", category: "skills" },
  { name: "get_skill_stats", description: "Get usage statistics for skills", category: "skills" },
  { name: "list_models", description: "List all available models", category: "models" },
  { name: "switch_model", description: "Switch the model for conversations", category: "models" },
  { name: "remember", description: "Save something to long-term memory", category: "memory" },
  { name: "recall", description: "Search long-term memory for stored information", category: "memory" },
  { name: "forget", description: "Remove a specific memory from long-term storage", category: "memory" },
  { name: "restart_attache", description: "Restart the Attache daemon process", category: "system" },
  { name: "get_current_time", description: "Get the current date and time in Europe/Copenhagen timezone", category: "system" },
  { name: "schedule_task", description: "Create a recurring scheduled task", category: "cron" },
  { name: "list_schedules", description: "List all scheduled tasks with status", category: "cron" },
  { name: "update_schedule", description: "Modify an existing scheduled task", category: "cron" },
  { name: "remove_schedule", description: "Delete a scheduled task", category: "cron" },
];

function isTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed?\s*out/i.test(msg);
}

function formatWorkerError(workerName: string, startedAt: number, timeoutMs: number, err: unknown): string {
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const limit = Math.round(timeoutMs / 1000);
  const msg = err instanceof Error ? err.message : String(err);

  if (isTimeoutError(err)) {
    return `Worker '${workerName}' timed out after ${elapsed}s (limit: ${limit}s). The task was still running but had to be stopped. To allow more time, set WORKER_TIMEOUT=${timeoutMs * 2} in ~/.attache/.env.`;
  }
  return `Worker '${workerName}' failed after ${elapsed}s: ${msg}`;
}

function persistWorkerOutput(worker: WorkerInfo, output: string): void {
  worker.lastOutput = output;
  const db = getDb();
  db.prepare(
    `UPDATE worker_sessions SET last_output = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`,
  ).run(output, worker.name);
}

export const BLOCKED_WORKER_DIRS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".config/gcloud",
  ".kube", ".docker", ".npmrc", ".pypirc", ".attache",
];

export const MAX_CONCURRENT_WORKERS = 5;

export interface WorkerInfo {
  name: string;
  session: BackendSession;
  workingDir: string;
  status: "idle" | "running" | "error";
  lastOutput?: string;
  /** Timestamp (ms) when the worker started its current task. */
  startedAt?: number;
  /** Channel that created this worker — completions route back here. */
  originChannel?: "telegram" | "tui";
  /** True when the worker was explicitly cancelled and should not emit completion notifications. */
  cancelled?: boolean;
  /** When true, the worker is automatically destroyed after its task completes. */
  autoDestroy?: boolean;
}

export interface ToolDeps {
  client: BackendClient;
  workers: Map<string, WorkerInfo>;
  onWorkerComplete: (name: string, result: string) => void;
}

/** Destroy a worker session and remove it from the map and database. */
export function destroyWorker(workers: Map<string, WorkerInfo>, name: string): void {
  const worker = workers.get(name);
  if (!worker) return;
  try { worker.session.destroy(); } catch { /* session may already be gone */ }
  workers.delete(name);
  const db = getDb();
  db.prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(name);
}

/** Resolve a SessionConfig for a worker using the customization pipeline. */
async function resolveWorkerConfig(opts: {
  client: BackendClient;
  workingDir: string;
  profile?: string;
}): Promise<SessionConfig> {
  const { client, workingDir, profile } = opts;

  try {
    const resolver = new DefaultResolver();
    const context = {
      role: "worker" as const,
      workingDirectory: workingDir,
      backendName: client.name,
      backendCapabilities: client.capabilities,
      profile,
    };

    const bundle = await resolver.resolve(context);
    const projector = createProjector(client.name);
    const projected = await projector.project(bundle, context);

    // Run side effects (e.g., skill syncing)
    if (projected.sideEffects) {
      try { await projected.sideEffects(); } catch { /* non-fatal */ }
    }

    return {
      model: config.copilotModel,
      configDir: SESSIONS_DIR,
      workingDirectory: workingDir,
      ...projected.sessionConfig,
      // Workers never get custom tools — they use the backend's native tools
      tools: undefined,
    };
  } catch (err) {
    console.log(`${LOG_PREFIX} Worker customization resolution failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    // Fallback to minimal config
    return {
      model: config.copilotModel,
      configDir: SESSIONS_DIR,
      workingDirectory: workingDir,
    };
  }
}

export function createTools(deps: ToolDeps): Tool<any>[] {
  const tools: Tool<any>[] = [
    defineTool("create_worker_session", {
      description:
        "Create a new worker session in a specific directory. " +
        "Use for coding tasks, debugging, file operations. " +
        "Returns confirmation with session name.",
      parameters: z.object({
        name: z.string().describe("Short descriptive name for the session, e.g. 'auth-fix'"),
        working_dir: z.string().optional().describe("Absolute path to the directory to work in (defaults to daemon working directory)"),
        initial_prompt: z.string().optional().describe("Optional initial prompt to send to the worker"),
        profile: z.string().optional().describe("Optional customization profile name for the worker (loads specific skills/MCP/instructions)"),
      }),
      handler: async (args) => {
        if (deps.workers.has(args.name)) {
          return `Worker '${args.name}' already exists. Use send_to_worker to interact with it.`;
        }

        const workingDir = args.working_dir || process.cwd();
        const home = homedir();
        const resolvedDir = resolve(workingDir);
        for (const blocked of BLOCKED_WORKER_DIRS) {
          const blockedPath = join(home, blocked);
          if (resolvedDir === blockedPath || resolvedDir.startsWith(blockedPath + sep)) {
            return `Refused: '${workingDir}' is a sensitive directory. Workers cannot operate in ${blocked}.`;
          }
        }

        if (deps.workers.size >= MAX_CONCURRENT_WORKERS) {
          const names = Array.from(deps.workers.keys()).join(", ");
          return `Worker limit reached (${MAX_CONCURRENT_WORKERS}). Active: ${names}. Kill a session first.`;
        }

        // Resolve worker customizations via the resolver+projector pipeline
        const workerSessionConfig = await resolveWorkerConfig({
          client: deps.client,
          workingDir,
          profile: args.profile,
        });

        const session = await deps.client.createSession(workerSessionConfig);

        const worker: WorkerInfo = {
          name: args.name,
          session,
          workingDir,
          status: "idle",
          originChannel: getCurrentSourceChannel(),
        };
        deps.workers.set(args.name, worker);

        // Persist to SQLite
        const db = getDb();
        db.prepare(
          `INSERT OR REPLACE INTO worker_sessions (name, copilot_session_id, working_dir, status)
           VALUES (?, ?, ?, 'idle')`
        ).run(args.name, session.sessionId, workingDir);

        if (args.initial_prompt) {
          worker.autoDestroy = true;
          worker.status = "running";
          worker.startedAt = Date.now();
          db.prepare(
            `UPDATE worker_sessions SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE name = ?`
          ).run(args.name);

          const timeoutMs = config.workerTimeoutMs;
          let streamedOutput = "";
          const unsubDelta = session.on("assistant.message_delta", (data) => {
            if (worker.cancelled) return;
            streamedOutput += data.deltaContent;
            persistWorkerOutput(worker, streamedOutput);
          });

          // Non-blocking: dispatch work and return immediately
          session.sendAndWait(
            `Working directory: ${workingDir}\n\n${args.initial_prompt}`,
            timeoutMs,
          ).then((result) => {
            if (worker.cancelled) {
              return;
            }
            unsubDelta();
            worker.status = "idle";
            persistWorkerOutput(worker, result.content || streamedOutput || "No response");
            db.prepare(`UPDATE worker_sessions SET status = 'idle', updated_at = CURRENT_TIMESTAMP WHERE name = ?`).run(args.name);
            deps.onWorkerComplete(args.name, worker.lastOutput ?? "No response");
            if (worker.autoDestroy) destroyWorker(deps.workers, args.name);
          }).catch((err) => {
            unsubDelta();
            if (worker.cancelled) {
              return;
            }
            worker.status = "error";
            const errMsg = formatWorkerError(args.name, worker.startedAt!, timeoutMs, err);
            persistWorkerOutput(worker, errMsg);
            db.prepare(`UPDATE worker_sessions SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE name = ?`).run(args.name);
            deps.onWorkerComplete(args.name, worker.lastOutput ?? errMsg);
            if (worker.autoDestroy) destroyWorker(deps.workers, args.name);
          });

          return `Worker '${args.name}' created in ${workingDir}. Task dispatched — I'll notify you when it's done.`;
        }

        return `Worker '${args.name}' created in ${workingDir}. Use send_to_worker to send it prompts.`;
      },
    }),

    defineTool("send_to_worker", {
      description:
        "Send a prompt to an existing worker session and wait for its response. " +
        "Use for follow-up instructions or questions about ongoing work.",
      parameters: z.object({
        name: z.string().describe("Name of the worker session"),
        prompt: z.string().describe("The prompt to send"),
      }),
      handler: async (args) => {
        const worker = deps.workers.get(args.name);
        if (!worker) {
          return `No worker named '${args.name}'. Use list_sessions to see available workers.`;
        }
        if (worker.status === "running") {
          return `Worker '${args.name}' is currently busy. Wait for it to finish or kill it.`;
        }

        worker.status = "running";
        worker.startedAt = Date.now();
        const db = getDb();
        db.prepare(`UPDATE worker_sessions SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE name = ?`).run(
          args.name
        );

        const timeoutMs = config.workerTimeoutMs;
        let streamedOutput = "";
        const unsubDelta = worker.session.on("assistant.message_delta", (data) => {
          if (worker.cancelled) return;
          streamedOutput += data.deltaContent;
          persistWorkerOutput(worker, streamedOutput);
        });

        // Non-blocking: dispatch work and return immediately
        worker.session.sendAndWait(args.prompt, timeoutMs).then((result) => {
          unsubDelta();
          if (worker.cancelled) {
            return;
          }
          worker.status = "idle";
          persistWorkerOutput(worker, result.content || streamedOutput || "No response");
          db.prepare(`UPDATE worker_sessions SET status = 'idle', updated_at = CURRENT_TIMESTAMP WHERE name = ?`).run(args.name);
          deps.onWorkerComplete(args.name, worker.lastOutput ?? "No response");
          if (worker.autoDestroy) destroyWorker(deps.workers, args.name);
        }).catch((err) => {
          unsubDelta();
          if (worker.cancelled) {
            return;
          }
          worker.status = "error";
          const errMsg = formatWorkerError(args.name, worker.startedAt!, timeoutMs, err);
          persistWorkerOutput(worker, errMsg);
          db.prepare(`UPDATE worker_sessions SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE name = ?`).run(args.name);
          deps.onWorkerComplete(args.name, worker.lastOutput ?? errMsg);
          if (worker.autoDestroy) destroyWorker(deps.workers, args.name);
        });

        return `Task dispatched to worker '${args.name}'. I'll notify you when it's done.`;
      },
    }),

    defineTool("list_sessions", {
      description: "List all active worker sessions with their name, status, and working directory.",
      parameters: z.object({}),
      handler: async () => {
        if (deps.workers.size === 0) {
          return "No active worker sessions.";
        }
        const lines = Array.from(deps.workers.values()).map(
          (w) => `• ${w.name} (${w.workingDir}) — ${w.status}`
        );
        return `Active sessions:\n${lines.join("\n")}`;
      },
    }),

    defineTool("check_session_status", {
      description: "Get detailed status of a specific worker session, including its last output.",
      parameters: z.object({
        name: z.string().describe("Name of the worker session"),
      }),
      handler: async (args) => {
        const worker = deps.workers.get(args.name);
        if (!worker) {
          return `No worker named '${args.name}'.`;
        }
        const output = worker.lastOutput
          ? `\n\nLast output:\n${worker.lastOutput.slice(0, 2000)}`
          : "";
        return `Worker '${args.name}'\nDirectory: ${worker.workingDir}\nStatus: ${worker.status}${output}`;
      },
    }),

    defineTool("kill_session", {
      description: "Terminate a worker session and free its resources.",
      parameters: z.object({
        name: z.string().describe("Name of the worker session to kill"),
      }),
      handler: async (args) => {
        const worker = deps.workers.get(args.name);
        if (!worker) {
          return `No worker named '${args.name}'.`;
        }
        worker.cancelled = true;
        try {
          await worker.session.destroy();
        } catch {
          // Session may already be gone
        }
        deps.workers.delete(args.name);

        const db = getDb();
        db.prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(args.name);

        return `Worker '${args.name}' terminated.`;
      },
    }),

    defineTool("list_skills", {
      description:
        "List all available skills Attache knows. Skills are instruction documents that teach the assistant " +
        "how to use external tools and services (e.g. Gmail, browser automation, YouTube transcripts). " +
        "Shows skill name, description, and whether it's a local or global skill.",
      parameters: z.object({}),
      handler: async () => {
        const skills = listSkills();
        if (skills.length === 0) {
          return "No skills installed yet. Use learn_skill to teach me something new.";
        }
        const lines = skills.map(
          (s) => `• ${s.name} (${s.source}) — ${s.description}`
        );
        return `Available skills (${skills.length}):\n${lines.join("\n")}`;
      },
    }),

    defineTool("learn_skill", {
      description:
        "Teach Attache a new skill by creating a SKILL.md instruction file. Use this when the user asks the assistant " +
        "to do something it doesn't know how to do yet (e.g. 'check my email', 'search the web'). " +
        "First, use a worker session to research what CLI tools are available on the system (run 'which', " +
        "'--help', etc.), then create the skill with the instructions you've learned. " +
        "The skill becomes available on the next message (no restart needed).",
      parameters: z.object({
        slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).describe("Short kebab-case identifier for the skill, e.g. 'gmail', 'web-search'"),
        name: z.string().refine(s => !s.includes('\n'), "must be single-line").describe("Human-readable name for the skill, e.g. 'Gmail', 'Web Search'"),
        description: z.string().refine(s => !s.includes('\n'), "must be single-line").describe("One-line description of when to use this skill"),
        instructions: z.string().describe(
          "Markdown instructions for how to use the skill. Include: what CLI tool to use, " +
          "common commands with examples, authentication steps if needed, tips and gotchas. " +
          "This becomes the SKILL.md content body."
        ),
      }),
      handler: async (args) => {
        return createSkill(args.slug, args.name, args.description, args.instructions);
      },
    }),

    defineTool("uninstall_skill", {
      description:
        "Remove a skill from Attache's local skills directory (~/.attache/skills/). " +
        "The skill will no longer be available on the next message. " +
        "Only works for local skills — bundled and global skills cannot be removed this way.",
      parameters: z.object({
        slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).describe("The kebab-case slug of the skill to remove, e.g. 'gmail', 'web-search'"),
      }),
      handler: async (args) => {
        const result = removeSkill(args.slug);
        return result.message;
      },
    }),

    defineTool("improve_skill", {
      description:
        "Update a local skill's instructions based on usage experience. Use this when you've discovered " +
        "better approaches, missing steps, or corrections after using a skill. Only works for local skills " +
        "(~/.attache/skills) — bundled and global skills cannot be modified.",
      parameters: z.object({
        slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).describe("The kebab-case slug of the skill to update"),
        name: z.string().refine(s => !s.includes('\n'), "must be single-line").optional().describe("Updated name (optional, keeps existing if omitted)"),
        description: z.string().refine(s => !s.includes('\n'), "must be single-line").optional().describe("Updated description (optional, keeps existing if omitted)"),
        instructions: z.string().describe("The complete updated instructions for the skill (replaces existing body)"),
      }),
      handler: async (args) => {
        const result = updateSkill(args.slug, {
          name: args.name,
          description: args.description,
          instructions: args.instructions,
        });
        return result.message;
      },
    }),

    defineTool("log_skill_usage", {
      description:
        "Log the outcome after using a skill. Call this after every skill-driven task to track " +
        "success/failure patterns over time. This data informs when skills need improvement.",
      parameters: z.object({
        slug: z.string().describe("The slug of the skill that was used"),
        outcome: z.enum(["success", "failure", "partial"]).describe("How the task went: success, failure, or partial"),
        notes: z.string().optional().describe("Optional notes about what worked, what failed, or what could be improved"),
      }),
      handler: async (args) => {
        const id = logSkillUsage(args.slug, args.outcome, args.notes);
        return `Logged ${args.outcome} for skill '${args.slug}' (#${id}).`;
      },
    }),

    defineTool("get_skill_stats", {
      description:
        "Get usage statistics for skills — total uses, success/failure/partial counts, last used date, " +
        "and recent notes. Use this to check for failure patterns before deciding to improve a skill.",
      parameters: z.object({
        slug: z.string().optional().describe("Optional: filter stats to a specific skill slug"),
      }),
      handler: async (args) => {
        const stats = getSkillStats(args.slug);
        if (stats.length === 0) {
          return args.slug
            ? `No usage data for skill '${args.slug}'.`
            : "No skill usage data recorded yet.";
        }
        const lines = stats.map((s) => {
          const rate = s.total > 0 ? Math.round((s.successes / s.total) * 100) : 0;
          let line = `• ${s.slug}: ${s.total} uses (${rate}% success) — ${s.successes} ok, ${s.failures} fail, ${s.partials} partial. Last: ${s.lastUsed}`;
          if (s.recentNotes.length > 0) {
            line += `\n  Notes: ${s.recentNotes.join("; ")}`;
          }
          return line;
        });
        return `Skill usage stats:\n${lines.join("\n")}`;
      },
    }),

    defineTool("list_models", {
      description:
        "List all available models. Shows model id, name, and billing tier. " +
        "Marks the currently active model. Use when the user asks what models are available " +
        "or wants to know which model is in use.",
      parameters: z.object({}),
      handler: async () => {
        if (!deps.client.capabilities.modelListing) {
          return `Model listing is not supported by the ${deps.client.name} backend.`;
        }
        try {
          const models = await deps.client.listModels();
          if (models.length === 0) {
            return "No models available.";
          }
          const current = config.copilotModel;
          const lines = models.map((m) => {
            const active = m.id === current ? " ← active" : "";
            const billing = m.multiplier ? ` (${m.multiplier}x)` : "";
            return `• ${m.id}${billing}${active}`;
          });
          return `Available models (${models.length}):\n${lines.join("\n")}\n\nCurrent: ${current}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Failed to list models: ${msg}`;
        }
      },
    }),

    defineTool("switch_model", {
      description:
        "Switch the model for conversations. Takes effect on the next message. " +
        "The change is persisted across restarts. Use when the user asks to change or switch models.",
      parameters: z.object({
        model_id: z.string().describe("The model id to switch to (from list_models)"),
      }),
      handler: async (args) => {
        try {
          if (deps.client.capabilities.modelListing) {
            const models = await deps.client.listModels();
            const match = models.find((m) => m.id === args.model_id);
            if (!match) {
              const suggestions = models
                .filter((m) => m.id.includes(args.model_id) || m.id.toLowerCase().includes(args.model_id.toLowerCase()))
                .map((m) => m.id);
              const hint = suggestions.length > 0
                ? ` Did you mean: ${suggestions.join(", ")}?`
                : " Use list_models to see available options.";
              return `Model '${args.model_id}' not found.${hint}`;
            }
          }

          const previous = config.copilotModel;
          config.copilotModel = args.model_id;
          persistModel(args.model_id);

          // Reset orchestrator session so the new model takes effect immediately
          const { resetForModelSwitch } = await import("./orchestrator.js");
          resetForModelSwitch();

          return `Switched model from '${previous}' to '${args.model_id}'. Takes effect on next message.`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Failed to switch model: ${msg}`;
        }
      },
    }),

    defineTool("remember", {
      description:
        "Save something to Attache's long-term memory. Use when the user says 'remember that...', " +
        "states a preference, shares a fact about themselves, or mentions something important " +
        "that should be remembered across conversations. Also use proactively when you detect " +
        "important information worth persisting.",
      parameters: z.object({
        category: z.enum(["preference", "fact", "project", "person", "routine"])
          .describe("Category: preference (likes/dislikes/settings), fact (general knowledge), project (codebase/repo info), person (people info), routine (schedules/habits)"),
        content: z.string().describe("The thing to remember — a concise, self-contained statement"),
        source: z.enum(["user", "auto"]).optional().describe("'user' if explicitly asked to remember, 'auto' if Attache detected it (default: 'user')"),
      }),
      handler: async (args) => {
        const id = addMemory(args.category, args.content, args.source || "user");
        return `Remembered (#${id}, ${args.category}): "${args.content}"`;
      },
    }),

    defineTool("recall", {
      description:
        "Search Attache's long-term memory for stored facts, preferences, or information. " +
        "Uses full-text search with relevance ranking — supports prefix matching, boolean " +
        "operators (AND, OR, NOT), and quoted phrases. " +
        "Use when you need to look up something the user told you before, or when the user " +
        "asks 'do you remember...?' or 'what do you know about...?'",
      parameters: z.object({
        keyword: z.string().optional().describe(
          "Full-text search query. Supports prefix matching (auto-applied), " +
          "boolean operators (AND, OR, NOT), and quoted phrases for exact match."
        ),
        category: z.enum(["preference", "fact", "project", "person", "routine"]).optional()
          .describe("Optional: filter by category"),
      }),
      handler: async (args) => {
        const results = searchMemories(args.keyword, args.category);
        if (results.length === 0) {
          return "No matching memories found.";
        }
        const lines = results.map(
          (m) => `• #${m.id} [${m.category}] ${m.content} (${m.source}, ${m.created_at})`
        );
        return `Found ${results.length} memory/memories:\n${lines.join("\n")}`;
      },
    }),

    defineTool("forget", {
      description:
        "Remove a specific memory from Attache's long-term storage. Use when the user asks " +
        "to forget something, or when a memory is outdated/incorrect. Requires the memory ID " +
        "(use recall to find it first).",
      parameters: z.object({
        memory_id: z.number().int().describe("The memory ID to remove (from recall results)"),
      }),
      handler: async (args) => {
        const removed = removeMemory(args.memory_id);
        return removed
          ? `Memory #${args.memory_id} forgotten.`
          : `Memory #${args.memory_id} not found — it may have already been removed.`;
      },
    }),

    defineTool("schedule_task", {
      description:
        "Create a recurring scheduled task that runs on a cron schedule. " +
        "Use when the user wants something to happen periodically (daily reports, hourly checks, etc.). " +
        "The current backend is recorded with the job. If the backend changes, the job will be skipped at execution time.",
      parameters: z.object({
        name: z.string().describe("Short descriptive name for the task, e.g. 'morning-report'"),
        prompt: z.string().describe("The prompt to send to the orchestrator when the task fires"),
        cron_expression: z.string().describe("Standard cron expression (5 fields: minute hour day month weekday)"),
        notify_telegram: z.boolean().optional().describe("Whether to send results to Telegram (default: false)"),
      }),
      handler: async (args) => {
        if (!validateCronExpression(args.cron_expression)) {
          return `Invalid cron expression: "${args.cron_expression}". Use 5-field format: minute hour day month weekday. Examples: "0 8 * * *" (daily at 8am), "0 * * * *" (every hour), "*/15 * * * *" (every 15 minutes).`;
        }
        const { getBackendName } = await import("../backend/registry.js");
        const backend = getBackendName();
        const id = dbCreateCronJob(args.name, args.prompt, args.cron_expression, args.notify_telegram, backend);
        rescheduleJob(id);
        // Broadcast SSE event
        const { broadcastCronEvent } = await import("../api/server.js");
        broadcastCronEvent("cron.job.created", { id, name: args.name, cron_expression: args.cron_expression, enabled: true, backend });
        return `Scheduled task "${args.name}" created (#${id}). It will run on schedule: ${args.cron_expression} (backend: ${backend})`;
      },
    }),

    defineTool("list_schedules", {
      description: "List all scheduled tasks with their status, last run time, and cron expression.",
      parameters: z.object({}),
      handler: async () => {
        const jobs = getCronJobs();
        if (jobs.length === 0) {
          return "No scheduled tasks. Use schedule_task to create one.";
        }
        const lines = jobs.map((j) => {
          const status = j.enabled ? "enabled" : "disabled";
          const lastRun = j.last_run_at ? `last run: ${j.last_run_at}` : "never run";
          const lastResult = j.last_status ? ` (${j.last_status})` : "";
          const backendTag = j.backend ? ` [${j.backend}]` : "";
          return `• #${j.id} "${j.name}" [${status}]${backendTag} — ${j.cron_expression} — ${lastRun}${lastResult} — ${j.run_count} runs`;
        });
        return `Scheduled tasks (${jobs.length}):\n${lines.join("\n")}`;
      },
    }),

    defineTool("update_schedule", {
      description: "Modify an existing scheduled task. Can change its name, prompt, schedule, or enabled state.",
      parameters: z.object({
        job_id: z.number().int().describe("The job ID to update"),
        name: z.string().optional().describe("New name"),
        prompt: z.string().optional().describe("New prompt"),
        cron_expression: z.string().optional().describe("New cron expression"),
        enabled: z.boolean().optional().describe("Enable or disable the job"),
        notify_telegram: z.boolean().optional().describe("Enable or disable Telegram notifications"),
      }),
      handler: async (args) => {
        const { getCronJob: getJob } = await import("../store/db.js");
        const job = getJob(args.job_id);
        if (!job) return `No scheduled task with ID #${args.job_id}.`;

        if (args.cron_expression && !validateCronExpression(args.cron_expression)) {
          return `Invalid cron expression: "${args.cron_expression}".`;
        }

        updateCronJob(args.job_id, {
          name: args.name,
          prompt: args.prompt,
          cron_expression: args.cron_expression,
          enabled: args.enabled,
          notify_telegram: args.notify_telegram,
        });
        rescheduleJob(args.job_id);
        const { broadcastCronEvent } = await import("../api/server.js");
        broadcastCronEvent("cron.job.updated", { id: args.job_id, name: args.name ?? job.name });
        return `Scheduled task #${args.job_id} "${args.name ?? job.name}" updated.`;
      },
    }),

    defineTool("remove_schedule", {
      description: "Delete a scheduled task permanently.",
      parameters: z.object({
        job_id: z.number().int().describe("The job ID to remove"),
      }),
      handler: async (args) => {
        const { getCronJob: getJob } = await import("../store/db.js");
        const job = getJob(args.job_id);
        if (!job) return `No scheduled task with ID #${args.job_id}.`;

        unscheduleJob(args.job_id);
        deleteCronJob(args.job_id);
        const { broadcastCronEvent } = await import("../api/server.js");
        broadcastCronEvent("cron.job.deleted", { id: args.job_id, name: job.name });
        return `Scheduled task #${args.job_id} "${job.name}" deleted.`;
      },
    }),

    defineTool("restart_attache", {
      description:
        "Restart the Attache daemon process. Use when the user asks Attache to restart, " +
        "or when a restart is needed to pick up configuration changes. " +
        "Spawns a new process and exits the current one.",
      parameters: z.object({
        reason: z.string().optional().describe("Optional reason for the restart"),
      }),
      handler: async (args) => {
        const reason = args.reason ? ` (${args.reason})` : "";
        // Dynamic import to avoid circular dependency
        const { restartDaemon } = await import("../daemon.js");
        // Schedule restart after returning the response
        setTimeout(() => {
          restartDaemon().catch((err) => {
            console.error("[attache] Restart failed:", err);
          });
        }, 1000);
        return `Restarting Attache${reason}. I'll be back in a few seconds.`;
      },
    }),

    defineTool("get_current_time", {
      description:
        "Get the current date and time in Europe/Copenhagen timezone. " +
        "Use when the user asks what time or date it is, or when you need to know the current time.",
      parameters: z.object({}),
      handler: async () => {
        const now = new Date();
        const formatted = now.toLocaleString('en-GB', {
          timeZone: 'Europe/Copenhagen',
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZoneName: 'short',
        });
        return `Current time: ${formatted}`;
      },
    }),
  ];

  // Gate Copilot-specific tools on capabilities
  if (deps.client.capabilities.machineSessionDiscovery) {
    tools.push(
      defineTool("list_machine_sessions", {
        description:
          "List ALL Copilot CLI sessions on this machine — including sessions started from VS Code, " +
          "the terminal, or other tools. Shows session ID, summary, working directory. " +
          "Use this when the user asks about existing sessions running on the machine. " +
          "By default shows the 20 most recently active sessions.",
        parameters: z.object({
          cwd_filter: z.string().optional().describe("Optional: only show sessions whose working directory contains this string"),
          limit: z.number().int().min(1).max(100).optional().describe("Maximum sessions to return (default 20)"),
        }),
        handler: async (args) => {
          const sessionStateDir = join(homedir(), ".copilot", "session-state");
          const limit = args.limit || 20;

          let entries: { id: string; cwd: string; summary: string; updatedAt: Date }[] = [];

          try {
            const dirs = readdirSync(sessionStateDir);
            for (const dir of dirs) {
              const yamlPath = join(sessionStateDir, dir, "workspace.yaml");
              try {
                const content = readFileSync(yamlPath, "utf-8");
                const parsed = parseSimpleYaml(content);
                if (args.cwd_filter && !parsed.cwd?.includes(args.cwd_filter)) continue;
                entries.push({
                  id: parsed.id || dir,
                  cwd: parsed.cwd || "unknown",
                  summary: parsed.summary || "",
                  updatedAt: parsed.updated_at ? new Date(parsed.updated_at) : new Date(0),
                });
              } catch {
                // Skip dirs without valid workspace.yaml
              }
            }
          } catch (err: unknown) {
            if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
              return "No Copilot sessions found on this machine (session state directory does not exist yet).";
            }
            return "Could not read session state directory.";
          }

          // Sort by most recently updated
          entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
          entries = entries.slice(0, limit);

          if (entries.length === 0) {
            return "No Copilot sessions found on this machine.";
          }

          const lines = entries.map((s) => {
            const age = formatAge(s.updatedAt);
            const summary = s.summary ? ` — ${s.summary}` : "";
            return `• ID: ${s.id}\n  ${s.cwd} (${age})${summary}`;
          });

          return `Found ${entries.length} session(s) (most recent first):\n${lines.join("\n")}`;
        },
      }),

      defineTool("attach_machine_session", {
        description:
          "Attach to an existing Copilot CLI session on this machine (e.g. one started from VS Code or terminal). " +
          "Resumes the session and adds it as a managed worker so you can send prompts to it.",
        parameters: z.object({
          session_id: z.string().describe("The session ID to attach to (from list_machine_sessions)"),
          name: z.string().describe("A short name to reference this session by, e.g. 'vscode-main'"),
        }),
        handler: async (args) => {
          if (deps.workers.has(args.name)) {
            return `A worker named '${args.name}' already exists. Choose a different name.`;
          }

          try {
            const session = await deps.client.resumeSession(args.session_id, {
              model: config.copilotModel,
            });

            const worker: WorkerInfo = {
              name: args.name,
              session,
              workingDir: "(attached)",
              status: "idle",
              originChannel: getCurrentSourceChannel(),
            };
            deps.workers.set(args.name, worker);

            const db = getDb();
            db.prepare(
              `INSERT OR REPLACE INTO worker_sessions (name, copilot_session_id, working_dir, status)
               VALUES (?, ?, '(attached)', 'idle')`
            ).run(args.name, args.session_id);

            return `Attached to session ${args.session_id.slice(0, 8)}… as worker '${args.name}'. You can now send_to_worker to interact with it.`;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Failed to attach to session: ${msg}`;
          }
        },
      }),
    );
  }

  return tools;
}

function formatAge(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const idx = line.indexOf(": ");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 2).trim();
      result[key] = value;
    }
  }
  return result;
}
