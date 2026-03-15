import express from "express";
import type { Request, Response, NextFunction } from "express";
import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { randomBytes } from "crypto";
import { execSync } from "child_process";
import { sendToOrchestrator, getWorkers, cancelCurrentMessage, getLastRouteResult } from "../copilot/orchestrator.js";
import { sendPhoto } from "../telegram/bot.js";
import { config, persistModel, persistEnvVar } from "../config.js";
import { getRouterConfig, updateRouterConfig } from "../copilot/router.js";
import { getDb, searchMemories, logConversation } from "../store/db.js";
import { listSkills, removeSkill } from "../copilot/skills.js";
import { restartDaemon } from "../daemon.js";
import { getEffectiveIdentity, LOG_PREFIX } from "../identity.js";
import { API_TOKEN_PATH, ensureAttacheHome } from "../paths.js";
import {
  API_EVENT_SCHEMA_VERSION,
  createCancelledEvent,
  createCompleteEvent,
  createConnectedEvent,
  createDeltaEvent,
  createTranscriptEvent,
  encodeSseEvent,
} from "./events.js";

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

app.get("/diagnostics", (_req: Request, res: Response) => {
  const workers = Array.from(getWorkers().values()).map(summarizeWorker);
  const identity = getEffectiveIdentity();
  const lastRoute = getLastRouteResult();

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
    routing: {
      currentModel: config.copilotModel,
      autoRouting: getRouterConfig(),
      lastRoute: lastRoute ?? null,
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

  sendToOrchestrator(
    prompt,
    { type: "tui", connectionId },
    (text: string, done: boolean) => {
      const routeResult = done ? getLastRouteResult() : undefined;
      const route = routeResult ? {
        model: routeResult.model,
        routerMode: routeResult.routerMode,
        tier: routeResult.tier,
        ...(routeResult.overrideName ? { overrideName: routeResult.overrideName } : {}),
      } : undefined;

      if (done) {
        // Broadcast complete event to ALL SSE clients
        const event = createCompleteEvent(text, route);
        for (const [, sseRes] of sseClients) {
          sseRes.write(encodeSseEvent(event));
        }
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
});

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
app.get("/models", async (_req: Request, res: Response) => {
  try {
    const { getClient } = await import("../copilot/client.js");
    const client = await getClient();
    const models = await client.listModels();
    const list = models
      .filter((m) => m.policy?.state === "enabled" && !m.name.includes("(Internal only)"))
      .map((m) => ({
        id: m.id,
        name: m.name,
        multiplier: m.billing?.multiplier ?? 0,
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
  // Validate against available models before persisting
  try {
    const { getClient } = await import("../copilot/client.js");
    const client = await getClient();
    const models = await client.listModels();
    const match = models.find((m) => m.id === model);
    if (!match) {
      const suggestions = models
        .filter((m) => m.id.includes(model) || m.id.toLowerCase().includes(model.toLowerCase()))
        .map((m) => m.id);
      const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
      res.status(400).json({ error: `Model '${model}' not found.${hint}` });
      return;
    }
  } catch {
    // If we can't validate (client not ready), allow the switch — it'll fail on next message if wrong
  }
  const previous = config.copilotModel;
  config.copilotModel = model;
  persistModel(model);
  res.json({ previous, current: model });
});

// Get auto-routing config
app.get("/auto", (_req: Request, res: Response) => {
  const routerConfig = getRouterConfig();
  const lastRoute = getLastRouteResult();
  res.json({
    ...routerConfig,
    currentModel: config.copilotModel,
    lastRoute: lastRoute || null,
  });
});

// Update auto-routing config
app.post("/auto", (req: Request, res: Response) => {
  const body = req.body as Partial<{
    enabled: boolean;
    tierModels: Record<string, string>;
    cooldownMessages: number;
  }>;

  const updated = updateRouterConfig(body);
  console.log(`${LOG_PREFIX} Auto-routing ${updated.enabled ? "enabled" : "disabled"}`);

  res.json(updated);
});

// List memories
app.get("/memory", (_req: Request, res: Response) => {
  const memories = searchMemories(undefined, undefined, 100);
  res.json(memories);
});

// List skills
app.get("/skills", (_req: Request, res: Response) => {
  const skills = listSkills();
  res.json(skills);
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
app.post("/config", (req: Request, res: Response) => {
  const values = req.body as Record<string, string>;
  if (!values || typeof values !== "object") {
    res.status(400).json({ error: "Body must be a JSON object of key-value pairs" });
    return;
  }

  // Allowlist of configurable keys
  const allowedKeys = new Set([
    "TELEGRAM_BOT_TOKEN",
    "AUTHORIZED_USER_ID",
    "COPILOT_MODEL",
    "WORKER_TIMEOUT",
    "ASSISTANT_DISPLAY_NAME",
    "ATTACHE_WORKFOLDER",
  ]);

  let restartRequired = false;
  for (const [key, value] of Object.entries(values)) {
    if (!allowedKeys.has(key)) {
      res.status(400).json({ error: `Key '${key}' is not a configurable setting` });
      return;
    }
    if (typeof value !== "string") {
      res.status(400).json({ error: `Value for '${key}' must be a string` });
      return;
    }
    persistEnvVar(key, value);
    // Telegram settings and workfolder require restart
    if (["TELEGRAM_BOT_TOKEN", "AUTHORIZED_USER_ID", "ATTACHE_WORKFOLDER"].includes(key)) {
      restartRequired = true;
    }
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

/** Broadcast a transcript entry to all SSE clients (for cross-channel visibility). */
export function broadcastTranscriptEntry(role: string, content: string, source: string): void {
  const event = createTranscriptEvent(role, content, source);
  for (const [, res] of sseClients) {
    res.write(encodeSseEvent(event));
  }
}
