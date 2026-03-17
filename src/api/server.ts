import express from "express";
import type { Request, Response, NextFunction } from "express";
import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { randomBytes } from "crypto";
import { execSync } from "child_process";
import { sendToOrchestrator, getWorkers, cancelCurrentMessage, getActiveModel, feedBackgroundResult, resetSession } from "../copilot/orchestrator.js";
import { sendPhoto } from "../telegram/bot.js";
import { config, persistEnvVar, prepareConfigUpdate, persistConfigUpdate, validateAndSwitchModel } from "../config.js";
import { getDb, searchMemories, logConversation, addMemory, removeMemory, clearConversationLog, logSkillUsage, getSkillStats, getSkillUsageHistory, getCronJobs, getCronJob, createCronJob, updateCronJob, deleteCronJob, getCronExecutions } from "../store/db.js";
import { listSkills, removeSkill, updateSkill, readSkill } from "../copilot/skills.js";
import { restartDaemon } from "../daemon.js";
import { getEffectiveIdentity, LOG_PREFIX } from "../identity.js";
import { API_TOKEN_PATH, SESSIONS_DIR, ensureAttacheHome } from "../paths.js";
import { join, sep, resolve } from "path";
import { homedir } from "os";
import { TOOL_REGISTRY, BLOCKED_WORKER_DIRS, MAX_CONCURRENT_WORKERS, type WorkerInfo } from "../copilot/tools.js";
import { DAEMON_VERSION } from "../update.js";
import { getBackendClient, getBackendName, getStaticModels } from "../backend/registry.js";
import { getCurrentSourceChannel } from "../copilot/orchestrator.js";
import {
  API_EVENT_SCHEMA_VERSION,
  createCancelledEvent,
  createCompleteEvent,
  createConnectedEvent,
  createDeltaEvent,
  createClearedEvent,
  createTranscriptEvent,
  createCronJobEvent,
  createCronExecutionEvent,
  encodeSseEvent,
} from "./events.js";
import { validateCronExpression, rescheduleJob, unscheduleJob } from "../cron/scheduler.js";

// Ensure token file exists (generate on first run)
let apiToken: string | null = null;
try {
  if (existsSync(API_TOKEN_PATH)) {
    apiToken = readFileSync(API_TOKEN_PATH, "utf-8").trim();
  } else {
    ensureAttacheHome();
    apiToken = randomBytes(32).toString("hex");
    writeFileSync(API_TOKEN_PATH, apiToken, { mode: 0o600 });
  }
} catch (err) {
  console.error(`[auth] Failed to load/generate API token: ${err}`);
  process.exit(1);
}

const app = express();
app.use(express.json());

// Bearer token authentication middleware (skip /status health check)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!apiToken || req.path === "/status") return next();
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${apiToken}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

// Active SSE connections
const sseClients = new Map<string, Response>();
let connectionCounter = 0;

function getWorkerIdParam(req: Request): string {
  return Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
}

function summarizeWorker(worker: ReturnType<typeof getWorkers> extends Map<string, infer T> ? T : never) {
  return {
    id: worker.name,
    name: worker.name,
    workingDir: worker.workingDir,
    status: worker.status,
    originChannel: worker.originChannel ?? null,
    startedAt: worker.startedAt ?? null,
    elapsedMs: worker.startedAt ? Date.now() - worker.startedAt : null,
    lastOutput: worker.lastOutput?.slice(0, 500) ?? null,
    hasLastOutput: typeof worker.lastOutput === "string" && worker.lastOutput.length > 0,
  };
}

function findWorker(id: string) {
  return getWorkers().get(id);
}

async function cancelWorker(id: string): Promise<boolean> {
  const worker = findWorker(id);
  if (!worker) {
    return false;
  }

  worker.cancelled = true;
  worker.status = "error";
  worker.lastOutput = worker.lastOutput ?? "Worker cancelled via API.";

  try {
    await worker.session.destroy();
  } catch {
    // Best effort — the session may already be gone.
  }

  getWorkers().delete(id);
  getDb().prepare("DELETE FROM worker_sessions WHERE name = ?").run(id);
  return true;
}

// Health check
app.get("/status", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    workers: Array.from(getWorkers().values()).map((w) => ({
      name: w.name,
      workingDir: w.workingDir,
      status: w.status,
    })),
  });
});

app.get("/config/effective", (_req: Request, res: Response) => {
  const identity = getEffectiveIdentity();
  res.json({
    ...identity,
    apiPort: config.apiPort,
    apiBaseUrl: `http://127.0.0.1:${config.apiPort}`,
    currentModel: config.copilotModel,
    backend: getBackendName(),
    telegramEnabled: config.telegramEnabled,
  });
});

// List worker sessions
app.get("/sessions", (_req: Request, res: Response) => {
  const workers = Array.from(getWorkers().values()).map(summarizeWorker);
  res.json(workers);
});

app.get("/workers/:id", (req: Request, res: Response) => {
  const workerId = getWorkerIdParam(req);
  const worker = findWorker(workerId);
  if (!worker) {
    res.status(404).json({ error: `No worker named '${workerId}'.` });
    return;
  }

  res.json({
    worker: summarizeWorker(worker),
  });
});

app.get("/workers/:id/logs", (req: Request, res: Response) => {
  const workerId = getWorkerIdParam(req);
  const worker = findWorker(workerId);
  if (!worker) {
    res.status(404).json({ error: `No worker named '${workerId}'.` });
    return;
  }

  const requestedTail = Number.parseInt(String(req.query.tail ?? "200"), 10);
  const tail = Number.isFinite(requestedTail) ? Math.max(1, Math.min(requestedTail, 1000)) : 200;
  const logs = worker.lastOutput ?? "";
  const lines = logs.length > 0 ? logs.split(/\r?\n/) : [];

  res.json({
    worker: summarizeWorker(worker),
    tail,
    lineCount: lines.length,
    logs,
    tailLines: tail > 0 ? lines.slice(-tail) : [],
  });
});

app.post("/workers/:id/cancel", async (req: Request, res: Response) => {
  const workerId = getWorkerIdParam(req);
  const worker = findWorker(workerId);
  if (!worker) {
    res.status(404).json({ error: `No worker named '${workerId}'.` });
    return;
  }

  const workerSnapshot = summarizeWorker(worker);
  const cancelled = await cancelWorker(workerId);

  res.json({
    status: "ok",
    cancelled,
    worker: workerSnapshot,
  });
});

// Create a worker session (for Claude backend — agent calls via curl)
app.post("/workers", async (req: Request, res: Response) => {
  const { name, working_dir, initial_prompt } = req.body as {
    name?: string;
    working_dir?: string;
    initial_prompt?: string;
  };

  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "Missing 'name' in request body" });
    return;
  }

  const workers = getWorkers();
  if (workers.has(name)) {
    res.status(409).json({ error: `Worker '${name}' already exists.` });
    return;
  }

  const workingDir = working_dir || process.cwd();
  const home = homedir();
  const resolvedDir = resolve(workingDir);
  for (const blocked of BLOCKED_WORKER_DIRS) {
    const blockedPath = join(home, blocked);
    if (resolvedDir === blockedPath || resolvedDir.startsWith(blockedPath + sep)) {
      res.status(403).json({ error: `Refused: '${workingDir}' is a sensitive directory.` });
      return;
    }
  }

  if (workers.size >= MAX_CONCURRENT_WORKERS) {
    const names = Array.from(workers.keys()).join(", ");
    res.status(429).json({ error: `Worker limit reached (${MAX_CONCURRENT_WORKERS}). Active: ${names}.` });
    return;
  }

  try {
    const client = getBackendClient();
    const session = await client.createSession({
      model: config.copilotModel,
      configDir: SESSIONS_DIR,
      workingDirectory: workingDir,
    });

    const worker: WorkerInfo = {
      name,
      session,
      workingDir,
      status: "idle",
      originChannel: getCurrentSourceChannel(),
    };
    workers.set(name, worker);

    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO worker_sessions (name, copilot_session_id, working_dir, status) VALUES (?, ?, ?, 'idle')`,
    ).run(name, session.sessionId, workingDir);

    if (initial_prompt) {
      worker.status = "running";
      worker.startedAt = Date.now();
      db.prepare(
        `UPDATE worker_sessions SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE name = ?`,
      ).run(name);

      const timeoutMs = config.workerTimeoutMs;
      session.sendAndWait(`Working directory: ${workingDir}\n\n${initial_prompt}`, timeoutMs)
        .then((result) => {
          if (worker.cancelled) return;
          worker.lastOutput = result.content || "No response";
          feedBackgroundResult(name, worker.lastOutput);
        })
        .catch((err) => {
          if (worker.cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          worker.lastOutput = `Worker '${name}' failed: ${msg}`;
          feedBackgroundResult(name, worker.lastOutput);
        })
        .finally(() => {
          session.destroy().catch(() => {});
          workers.delete(name);
          getDb().prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(name);
        });

      res.json({ status: "dispatched", name, workingDir });
      return;
    }

    res.json({ status: "created", name, workingDir, sessionId: session.sessionId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to create worker: ${msg}` });
  }
});

// Send prompt to a worker (for Claude backend — agent calls via curl)
app.post("/workers/:id/prompt", async (req: Request, res: Response) => {
  const workerId = getWorkerIdParam(req);
  const { prompt } = req.body as { prompt?: string };

  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "Missing 'prompt' in request body" });
    return;
  }

  const worker = findWorker(workerId);
  if (!worker) {
    res.status(404).json({ error: `No worker named '${workerId}'.` });
    return;
  }
  if (worker.status === "running") {
    res.status(409).json({ error: `Worker '${workerId}' is currently busy.` });
    return;
  }

  worker.status = "running";
  worker.startedAt = Date.now();
  worker.originChannel ??= getCurrentSourceChannel();
  const db = getDb();
  db.prepare(
    `UPDATE worker_sessions SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE name = ?`,
  ).run(workerId);

  const timeoutMs = config.workerTimeoutMs;
  worker.session.sendAndWait(prompt, timeoutMs)
    .then((result) => {
      if (worker.cancelled) return;
      worker.lastOutput = result.content || "No response";
      feedBackgroundResult(workerId, worker.lastOutput);
    })
    .catch((err) => {
      if (worker.cancelled) return;
      const msg = err instanceof Error ? err.message : String(err);
      worker.lastOutput = `Worker '${workerId}' failed: ${msg}`;
      feedBackgroundResult(workerId, worker.lastOutput);
    })
    .finally(() => {
      worker.session.destroy().catch(() => {});
      getWorkers().delete(workerId);
      getDb().prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(workerId);
    });

  res.json({ status: "dispatched", name: workerId });
});

app.get("/diagnostics", (_req: Request, res: Response) => {
  const workers = Array.from(getWorkers().values()).map(summarizeWorker);
  const identity = getEffectiveIdentity();

  res.json({
    status: "ok",
    schemaVersion: API_EVENT_SCHEMA_VERSION,
    api: {
      port: config.apiPort,
      activeSseConnections: sseClients.size,
    },
    process: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      platform: process.platform,
      nodeVersion: process.version,
      memoryUsage: process.memoryUsage(),
    },
    identity: {
      productName: identity.productName,
      assistantDisplayName: identity.assistantDisplayName,
    },
    backend: {
      name: getBackendName(),
    },
    model: {
      current: config.copilotModel,
      active: getActiveModel(),
    },
    workers: {
      count: workers.length,
      running: workers.filter((worker) => worker.status === "running").length,
      items: workers,
    },
  });
});

// Get conversation transcript from database
app.get("/transcript", (req: Request, res: Response) => {
  const requestedLimit = Number.parseInt(String(req.query.limit ?? "50"), 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 50;

  const db = getDb();
  const rows = db.prepare(
    `SELECT id, role, content, source, ts FROM conversation_log ORDER BY id DESC LIMIT ?`
  ).all(limit) as { id: number; role: string; content: string; source: string; ts: string }[];

  // Reverse to chronological order
  rows.reverse();

  res.json(rows);
});

// SSE stream for real-time responses
app.get("/stream", (req: Request, res: Response) => {
  const connectionId = `tui-${++connectionCounter}`;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(encodeSseEvent(createConnectedEvent(connectionId)));

  sseClients.set(connectionId, res);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(`:ping\n\n`);
  }, 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(connectionId);
  });
});

// Built-in slash command interception
async function handleBuiltInCommand(prompt: string): Promise<{ handled: boolean; result?: string }> {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/")) return { handled: false };

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(" ").trim();

  switch (cmd) {
    case "/model": {
      if (!args) {
        return { handled: true, result: `Current model: ${config.copilotModel}` };
      }
      const switchResult = await validateAndSwitchModel(args, getBackendClient());
      if (!switchResult.ok) {
        return { handled: true, result: switchResult.error };
      }
      const { resetForModelSwitch } = await import("../copilot/orchestrator.js");
      resetForModelSwitch();
      return { handled: true, result: `Switched model from ${switchResult.previous} to ${args}` };
    }

    case "/provider": {
      if (!args) {
        return { handled: true, result: `Current provider: ${getBackendName()}` };
      }
      const supported = ["copilot", "claude", "codex"];
      if (!supported.includes(args)) {
        return { handled: true, result: `Unknown provider '${args}'. Supported: ${supported.join(", ")}` };
      }
      const prevBackend = getBackendName();
      if (args === prevBackend) {
        return { handled: true, result: `Already using provider: ${args}` };
      }
      persistEnvVar("ATTACHE_BACKEND", args);
      setTimeout(() => {
        restartDaemon().catch((err) => {
          console.error(`${LOG_PREFIX} Restart failed:`, err);
        });
      }, 1000);
      return { handled: true, result: `Switching provider from ${prevBackend} to ${args}. Restarting...` };
    }

    case "/workers": {
      const workers = Array.from(getWorkers().values());
      if (workers.length === 0) {
        return { handled: true, result: "No active workers" };
      }
      const lines = workers.map(
        (w) => `- ${w.name} (${w.workingDir}) — ${w.status}`
      );
      return { handled: true, result: `Active workers (${workers.length}):\n${lines.join("\n")}` };
    }

    case "/restart": {
      setTimeout(() => {
        restartDaemon().catch((err) => {
          console.error(`${LOG_PREFIX} Restart failed:`, err);
        });
      }, 1000);
      return { handled: true, result: "Restarting..." };
    }

    case "/clear":
    case "/new": {
      await cancelCurrentMessage();
      await resetSession();
      clearConversationLog();
      broadcastClearedEvent();
      return { handled: true, result: "Session cleared. Starting fresh." };
    }

    default:
      return { handled: false };
  }
}

// Send a message to the orchestrator
app.post("/message", (req: Request, res: Response) => {
  const { prompt, connectionId } = req.body as { prompt?: string; connectionId?: string };

  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "Missing 'prompt' in request body" });
    return;
  }

  if (!connectionId || !sseClients.has(connectionId)) {
    res.status(400).json({ error: "Missing or invalid 'connectionId'. Connect to /stream first." });
    return;
  }

  // Intercept built-in slash commands
  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt.startsWith("/")) {
    handleBuiltInCommand(trimmedPrompt).then((builtIn) => {
        if (builtIn.handled) {
          const sseRes = sseClients.get(connectionId);
          if (sseRes) {
            sseRes.write(encodeSseEvent(createCompleteEvent(builtIn.result!)));
          }
          logConversation("user", trimmedPrompt, "tui");
          logConversation("assistant", builtIn.result!, "tui");
          broadcastTranscriptEntry("user", trimmedPrompt, "tui", connectionId);
          broadcastTranscriptEntry("assistant", builtIn.result!, "tui", connectionId);
          res.json({ status: "executed", builtIn: true });
          return;
        }
      // Not a built-in command — pass through to orchestrator
      dispatchToOrchestrator(prompt, connectionId, res);
    }).catch(() => {
      dispatchToOrchestrator(prompt, connectionId, res);
    });
    return;
  }

  dispatchToOrchestrator(prompt, connectionId, res);
});

function dispatchToOrchestrator(prompt: string, connectionId: string, res: Response) {
  broadcastTranscriptEntry("user", prompt, "tui", connectionId);

  sendToOrchestrator(
    prompt,
    { type: "tui", connectionId },
    (text: string, done: boolean) => {
      if (done) {
        const sseRes = sseClients.get(connectionId);
        if (sseRes) {
          sseRes.write(encodeSseEvent(createCompleteEvent(text)));
        }
        broadcastTranscriptEntry("assistant", text, "tui", connectionId);
      } else {
        // Send deltas only to the originating connection
        const sseRes = sseClients.get(connectionId);
        if (sseRes) {
          sseRes.write(encodeSseEvent(createDeltaEvent(text)));
        }
      }
    }
  );

  res.json({ status: "queued" });
}

// Cancel the current in-flight message
app.post("/cancel", async (_req: Request, res: Response) => {
  const cancelled = await cancelCurrentMessage();
  // Notify all SSE clients that the message was cancelled
  for (const [, sseRes] of sseClients) {
    sseRes.write(encodeSseEvent(createCancelledEvent()));
  }
  res.json({ status: "ok", cancelled });
});

// List available models
app.get("/models", async (req: Request, res: Response) => {
  const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;
  try {
    let models;
    if (provider && provider !== getBackendName()) {
      // Requested a different provider than active — return hardcoded list
      models = getStaticModels(provider);
    } else {
      // Active backend — use live listing (may be dynamic or cached)
      const client = getBackendClient();
      models = await client.listModels();
    }
    const list = models.map((m) => ({
      id: m.id,
      name: m.name,
      multiplier: m.multiplier,
    }));
    res.json(list);
  } catch {
    res.json([]);
  }
});

// Get or switch model
app.get("/model", (_req: Request, res: Response) => {
  res.json({ model: config.copilotModel });
});
app.post("/model", async (req: Request, res: Response) => {
  const { model } = req.body as { model?: string };
  if (!model || typeof model !== "string") {
    res.status(400).json({ error: "Missing 'model' in request body" });
    return;
  }
  const switchResult = await validateAndSwitchModel(model, getBackendClient());
  if (!switchResult.ok) {
    res.status(400).json({ error: switchResult.error });
    return;
  }
  const { resetForModelSwitch } = await import("../copilot/orchestrator.js");
  resetForModelSwitch();
  res.json({ previous: switchResult.previous, current: model });
});

// Get current backend provider
app.get("/backend", (_req: Request, res: Response) => {
  const client = getBackendClient();
  res.json({
    name: getBackendName(),
    capabilities: client.capabilities,
    supported: ["copilot", "claude", "codex"],
  });
});

// Switch backend provider (requires daemon restart)
app.post("/backend", (req: Request, res: Response) => {
  const { name } = req.body as { name?: string };
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "Missing 'name' in request body" });
    return;
  }
  const supported = ["copilot", "claude", "codex"];
  if (!supported.includes(name)) {
    res.status(400).json({ error: `Unknown backend '${name}'. Supported: ${supported.join(", ")}` });
    return;
  }
  const previous = getBackendName();
  persistEnvVar("ATTACHE_BACKEND", name);
  res.json({ previous, current: name, restartRequired: true });
});

// List memories
app.get("/memory", (req: Request, res: Response) => {
  const keyword = typeof req.query.keyword === "string" ? req.query.keyword : undefined;
  const category = typeof req.query.category === "string" ? req.query.category : undefined;
  const memories = searchMemories(keyword, category, 100);
  res.json(memories);
});

// Add a memory (for Claude backend — agent calls via curl)
app.post("/memory", (req: Request, res: Response) => {
  const { category, content, source } = req.body as {
    category?: string;
    content?: string;
    source?: string;
  };
  const validCategories = ["preference", "fact", "project", "person", "routine"];
  if (!category || !validCategories.includes(category)) {
    res.status(400).json({ error: `Invalid category. Must be one of: ${validCategories.join(", ")}` });
    return;
  }
  if (!content || typeof content !== "string") {
    res.status(400).json({ error: "Missing 'content' in request body" });
    return;
  }
  const memSource = source === "auto" ? "auto" : "user";
  try {
    const id = addMemory(
      category as "preference" | "fact" | "project" | "person" | "routine",
      content,
      memSource,
    );
    res.json({ id, category, content, source: memSource });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

// Remove a memory by ID (for Claude backend — agent calls via curl)
app.delete("/memory/:id", (req: Request, res: Response) => {
  const memId = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!Number.isFinite(memId) || memId <= 0) {
    res.status(400).json({ error: "Invalid memory ID" });
    return;
  }
  const removed = removeMemory(memId);
  if (!removed) {
    res.status(404).json({ error: `Memory #${memId} not found` });
    return;
  }
  res.json({ ok: true, id: memId });
});

// List skills
app.get("/skills", (_req: Request, res: Response) => {
  const skills = listSkills();
  res.json(skills);
});

// Skill usage stats (must be before /skills/:slug to avoid being shadowed)
app.get("/skills/stats", (req: Request, res: Response) => {
  const slug = typeof req.query.slug === "string" ? req.query.slug : undefined;
  const stats = getSkillStats(slug);
  res.json(stats);
});

// Read a skill's content
app.get("/skills/:slug/content", (req: Request, res: Response) => {
  const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const result = readSkill(slug);
  if (!result.ok) {
    res.status(404).json({ error: result.message });
    return;
  }
  res.json({ slug, source: result.source, content: result.content });
});

// Update a local skill
app.put("/skills/:slug", (req: Request, res: Response) => {
  const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const { name, description, instructions } = req.body as {
    name?: string;
    description?: string;
    instructions?: string;
  };
  if (!instructions || typeof instructions !== "string") {
    res.status(400).json({ error: "Missing 'instructions' in request body" });
    return;
  }
  const result = updateSkill(slug, { name, description, instructions });
  if (!result.ok) {
    res.status(400).json({ error: result.message });
    return;
  }
  res.json({ ok: true, message: result.message });
});

// Log skill usage
app.post("/skills/:slug/usage", (req: Request, res: Response) => {
  const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const { outcome, notes } = req.body as { outcome?: string; notes?: string };
  const validOutcomes = ["success", "failure", "partial"];
  if (!outcome || !validOutcomes.includes(outcome)) {
    res.status(400).json({ error: `Invalid outcome. Must be one of: ${validOutcomes.join(", ")}` });
    return;
  }
  const id = logSkillUsage(slug, outcome as "success" | "failure" | "partial", notes);
  res.json({ id, slug, outcome, notes: notes ?? null });
});

// Get skill usage history
app.get("/skills/:slug/usage", (req: Request, res: Response) => {
  const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const requestedLimit = Number.parseInt(String(req.query.limit ?? "20"), 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 20;
  const history = getSkillUsageHistory(slug, limit);
  res.json(history);
});

// Remove a local skill
app.delete("/skills/:slug", (req: Request, res: Response) => {
  const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const result = removeSkill(slug);
  if (!result.ok) {
    res.status(400).json({ error: result.message });
  } else {
    res.json({ ok: true, message: result.message });
  }
});

// ── Cron Job Endpoints ────────────────────────────────────────

// List all cron jobs
app.get("/cron", (_req: Request, res: Response) => {
  const jobs = getCronJobs();
  res.json(jobs);
});

// Get execution history (all jobs) — must be before /cron/:id
app.get("/cron/history", (req: Request, res: Response) => {
  const requestedLimit = Number.parseInt(String(req.query.limit ?? "50"), 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 50;
  const executions = getCronExecutions(undefined, limit);
  res.json(executions);
});

// Get a single cron job
app.get("/cron/:id", (req: Request, res: Response) => {
  const id = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid job ID" });
    return;
  }
  const job = getCronJob(id);
  if (!job) {
    res.status(404).json({ error: `Cron job #${id} not found` });
    return;
  }
  res.json(job);
});

// Create a cron job
app.post("/cron", (req: Request, res: Response) => {
  const { name, prompt, cron_expression, notify_telegram } = req.body as {
    name?: string;
    prompt?: string;
    cron_expression?: string;
    notify_telegram?: boolean;
  };

  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "Missing 'name'" });
    return;
  }
  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "Missing 'prompt'" });
    return;
  }
  if (!cron_expression || typeof cron_expression !== "string") {
    res.status(400).json({ error: "Missing 'cron_expression'" });
    return;
  }
  if (!validateCronExpression(cron_expression)) {
    res.status(400).json({ error: `Invalid cron expression: "${cron_expression}"` });
    return;
  }

  const id = createCronJob(name, prompt, cron_expression, notify_telegram ?? false);
  rescheduleJob(id);
  const job = getCronJob(id);
  broadcastCronEvent("cron.job.created", { ...(job ?? { id, name }) });
  res.json(job ?? { id, name });
});

// Update a cron job
app.put("/cron/:id", (req: Request, res: Response) => {
  const id = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid job ID" });
    return;
  }
  const job = getCronJob(id);
  if (!job) {
    res.status(404).json({ error: `Cron job #${id} not found` });
    return;
  }

  const { name, prompt, cron_expression, enabled, notify_telegram } = req.body as {
    name?: string;
    prompt?: string;
    cron_expression?: string;
    enabled?: boolean;
    notify_telegram?: boolean;
  };

  if (cron_expression && !validateCronExpression(cron_expression)) {
    res.status(400).json({ error: `Invalid cron expression: "${cron_expression}"` });
    return;
  }

  updateCronJob(id, { name, prompt, cron_expression, enabled, notify_telegram });
  rescheduleJob(id);
  const updated = getCronJob(id);
  broadcastCronEvent("cron.job.updated", { ...(updated ?? { id }) });
  res.json(updated);
});

// Delete a cron job
app.delete("/cron/:id", (req: Request, res: Response) => {
  const id = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid job ID" });
    return;
  }
  const job = getCronJob(id);
  if (!job) {
    res.status(404).json({ error: `Cron job #${id} not found` });
    return;
  }
  unscheduleJob(id);
  deleteCronJob(id);
  broadcastCronEvent("cron.job.deleted", { id, name: job.name });
  res.json({ ok: true, id });
});

// Toggle a cron job enabled/disabled
app.post("/cron/:id/toggle", (req: Request, res: Response) => {
  const id = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid job ID" });
    return;
  }
  const job = getCronJob(id);
  if (!job) {
    res.status(404).json({ error: `Cron job #${id} not found` });
    return;
  }
  const newEnabled = !job.enabled;
  updateCronJob(id, { enabled: newEnabled });
  rescheduleJob(id);
  const updated = getCronJob(id);
  broadcastCronEvent("cron.job.updated", { ...(updated ?? { id }) });
  res.json(updated);
});

// Get execution history for a specific job
app.get("/cron/:id/history", (req: Request, res: Response) => {
  const id = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid job ID" });
    return;
  }
  const requestedLimit = Number.parseInt(String(req.query.limit ?? "50"), 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 50;
  const executions = getCronExecutions(id, limit);
  res.json(executions);
});

// Capabilities manifest (fetched once on connect)
app.get("/capabilities", (_req: Request, res: Response) => {
  const identity = getEffectiveIdentity();
  const skills = listSkills();

  const slashCommands: {
    command: string;
    name: string;
    description: string;
    type: "builtIn" | "skill";
    usage?: string;
    source?: string;
  }[] = [
    { command: "/model", name: "Switch model", description: "Show or switch the active model", type: "builtIn", usage: "/model [name]" },
    { command: "/provider", name: "Provider", description: "Show or switch the backend provider", type: "builtIn", usage: "/provider [copilot|claude|codex]" },
    { command: "/workers", name: "List workers", description: "Show active worker sessions", type: "builtIn" },
    { command: "/clear", name: "Clear", description: "Clear conversation and start a new session", type: "builtIn" },
    { command: "/new", name: "New session", description: "Clear conversation and start a new session", type: "builtIn" },
    { command: "/restart", name: "Restart", description: "Restart the daemon", type: "builtIn" },
    { command: "/cron", name: "Schedule task", description: "Schedule a recurring task", type: "builtIn", usage: "/cron <natural language schedule + task>" },
  ];

  // Add skill-based slash commands
  for (const skill of skills) {
    slashCommands.push({
      command: `/${skill.slug}`,
      name: skill.name,
      description: skill.description,
      type: "skill",
      source: skill.source,
    });
  }

  const client = getBackendClient();
  res.json({
    version: DAEMON_VERSION,
    schemaVersion: API_EVENT_SCHEMA_VERSION,
    identity: {
      productName: identity.productName,
      assistantDisplayName: identity.assistantDisplayName,
    },
    backend: {
      name: getBackendName(),
      capabilities: client.capabilities,
    },
    slashCommands,
    tools: TOOL_REGISTRY,
    model: {
      current: config.copilotModel,
    },
    features: {
      telegram: config.telegramEnabled,
      selfEdit: config.selfEditEnabled,
    },
  });
});

// Get workfolder info
app.get("/workfolder", (_req: Request, res: Response) => {
  const cwd = process.cwd();
  let gitBranch: string | null = null;
  let gitRoot: string | null = null;

  try {
    gitBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8", windowsHide: true }).trim();
    gitRoot = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8", windowsHide: true }).trim();
  } catch {
    // Not a git repo
  }

  res.json({ path: cwd, gitBranch, gitRoot });
});

// Change workfolder
app.post("/workfolder", (req: Request, res: Response) => {
  const { path: newPath } = req.body as { path?: string };
  if (!newPath || typeof newPath !== "string") {
    res.status(400).json({ error: "Missing 'path' in request body" });
    return;
  }

  try {
    const stat = statSync(newPath);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: `'${newPath}' is not a directory` });
      return;
    }
  } catch {
    res.status(400).json({ error: `Path '${newPath}' does not exist` });
    return;
  }

  persistEnvVar("ATTACHE_WORKFOLDER", newPath);
  res.json({ status: "ok", restartRequired: true });

  // Trigger restart so daemon picks up new workfolder
  setTimeout(() => {
    restartDaemon().catch((err) => {
      console.error(`${LOG_PREFIX} Restart after workfolder change failed:`, err);
    });
  }, 500);
});

// Update .env config values
app.post("/config", async (req: Request, res: Response) => {
  const values = req.body as Record<string, string>;
  if (!values || typeof values !== "object") {
    res.status(400).json({ error: "Body must be a JSON object of key-value pairs" });
    return;
  }

  // Allowlist of configurable keys
  const allowedKeys = new Set([
    "TELEGRAM_BOT_TOKEN",
    "AUTHORIZED_USER_ID",
    "API_PORT",
    "COPILOT_MODEL",
    "WORKER_TIMEOUT",
    "ASSISTANT_DISPLAY_NAME",
    "ATTACHE_WORKFOLDER",
    "ATTACHE_BACKEND",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ]);

  const updates = [];
  for (const [key, value] of Object.entries(values)) {
    if (!allowedKeys.has(key)) {
      res.status(400).json({ error: `Key '${key}' is not a configurable setting` });
      return;
    }
    if (typeof value !== "string") {
      res.status(400).json({ error: `Value for '${key}' must be a string` });
      return;
    }
    try {
      updates.push(prepareConfigUpdate(key as Parameters<typeof prepareConfigUpdate>[0], value));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
      return;
    }
  }

  let restartRequired = false;
  for (const update of updates) {
    await persistConfigUpdate(update);
    restartRequired = restartRequired || update.restartRequired;
  }

  res.json({ status: "ok", restartRequired });
});

// Restart daemon
app.post("/restart", (_req: Request, res: Response) => {
  res.json({ status: "restarting" });
  setTimeout(() => {
      restartDaemon().catch((err) => {
        console.error(`${LOG_PREFIX} Restart failed:`, err);
      });
  }, 500);
});

// Send a photo to Telegram (protected by bearer token auth middleware)
app.post("/send-photo", async (req: Request, res: Response) => {
  const { photo, caption } = req.body as { photo?: string; caption?: string };

  if (!photo || typeof photo !== "string") {
    res.status(400).json({ error: "Missing 'photo' (file path or URL) in request body" });
    return;
  }

  // URLs are fine — only validate local file paths
  if (!photo.startsWith("http://") && !photo.startsWith("https://")) {
    const resolvedPhoto = resolve(photo);
    const home = homedir();
    // Block sensitive directories
    for (const blocked of BLOCKED_WORKER_DIRS) {
      const blockedPath = join(home, blocked);
      if (resolvedPhoto === blockedPath || resolvedPhoto.startsWith(blockedPath + sep)) {
        res.status(403).json({ error: `Refused: photo path is in a sensitive directory (${blocked}).` });
        return;
      }
    }
    // Block Attache's own config directory (contains API keys, tokens)
    const attacheHome = join(home, ".attache");
    if (resolvedPhoto.startsWith(attacheHome + sep) || resolvedPhoto === attacheHome) {
      res.status(403).json({ error: "Refused: photo path is in the Attache config directory." });
      return;
    }
  }

  try {
    await sendPhoto(photo, caption);
    res.json({ status: "sent" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export function startApiServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.apiPort, "127.0.0.1", () => {
      console.log(`${LOG_PREFIX} HTTP API listening on http://127.0.0.1:${config.apiPort}`);
      resolve();
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${config.apiPort} is already in use. Is another Attache instance running?`));
      } else {
        reject(err);
      }
    });
  });
}

/** Broadcast a proactive message to all connected SSE clients (for background task completions). */
export function broadcastToSSE(text: string): void {
  for (const [, res] of sseClients) {
    res.write(encodeSseEvent(createCompleteEvent(text)));
  }
}

/** Broadcast a session-cleared event to all connected SSE clients. */
export function broadcastClearedEvent(): void {
  for (const [, res] of sseClients) {
    res.write(encodeSseEvent(createClearedEvent()));
  }
}

/** Broadcast a cron event to all SSE clients. */
export function broadcastCronEvent(
  eventName: "cron.job.created" | "cron.job.updated" | "cron.job.deleted" | "cron.execution.started" | "cron.execution.complete",
  data: Record<string, unknown>,
): void {
  const isJobEvent = eventName.startsWith("cron.job.");
  const event = isJobEvent
    ? createCronJobEvent(eventName as "cron.job.created" | "cron.job.updated" | "cron.job.deleted", data)
    : createCronExecutionEvent(eventName as "cron.execution.started" | "cron.execution.complete", data);
  for (const [, res] of sseClients) {
    res.write(encodeSseEvent(event as any));
  }
}

/** Broadcast a transcript entry to all SSE clients (for cross-channel visibility). */
export function broadcastTranscriptEntry(
  role: string,
  content: string,
  source: string,
  excludeConnectionId?: string,
): void {
  const event = createTranscriptEvent(role, content, source);
  for (const [connectionId, res] of sseClients) {
    if (excludeConnectionId && connectionId === excludeConnectionId) {
      continue;
    }
    res.write(encodeSseEvent(event));
  }
}
