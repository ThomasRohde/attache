import type { Attachment, BackendClient, BackendSession, SessionConfig } from "../backend/types.js";
import { resetBackendClient, getDefaultModelForProvider } from "../backend/registry.js";
import { createTools, TOOL_REGISTRY, type WorkerInfo } from "./tools.js";
import { getOrchestratorSystemMessage, getAttacheAppendInstructions } from "./system-message.js";
import { config, DEFAULT_MODEL } from "../config.js";
import { loadMcpConfig } from "./mcp-config.js";
import { getSkillDirectories, getSkillContentForSystemMessage } from "./skills.js";
import { getDb, logConversation, getState, setState, deleteState, getMemorySummary, getRecentConversation } from "../store/db.js";
import { SESSIONS_DIR } from "../paths.js";
import { LOG_PREFIX } from "../identity.js";
import { DefaultResolver } from "../customization/resolver.js";
import { createProjector } from "../customization/projectors/index.js";
import type { ResolutionContext } from "../customization/types.js";

const MAX_RETRIES = 3;
const RECONNECT_DELAYS_MS = [1_000, 3_000, 10_000];
const HEALTH_CHECK_INTERVAL_MS = 30_000;

const ORCHESTRATOR_SESSION_KEY = "orchestrator_session_id";
const ORCHESTRATOR_BACKEND_KEY = "orchestrator_backend";

export type MessageSource =
  | { type: "telegram"; chatId: number; messageId: number }
  | { type: "tui"; connectionId: string }
  | { type: "background"; originChannel?: "telegram" | "tui" };

export type MessageCallback = (text: string, done: boolean) => void;

type LogFn = (direction: "in" | "out", source: string, text: string) => void;
let logMessage: LogFn = () => {};

export function setMessageLogger(fn: LogFn): void {
  logMessage = fn;
}

// Proactive notification — sends unsolicited messages to the user on a specific channel
type ProactiveNotifyFn = (text: string, channel?: "telegram" | "tui") => void;
let proactiveNotifyFn: ProactiveNotifyFn | undefined;

export function setProactiveNotify(fn: ProactiveNotifyFn): void {
  proactiveNotifyFn = fn;
}

let backendClient: BackendClient | undefined;
const workers = new Map<string, WorkerInfo>();
let healthCheckTimer: ReturnType<typeof setInterval> | undefined;
let sessionStateVersion = 0;

/** The model that will be used for the next session. */
export function getActiveModel(): string {
  return config.copilotModel;
}

/** Reset session state after a manual model switch (e.g. via /model command). */
export function resetForModelSwitch(): void {
  invalidateSessionState();
}

/** Reset the orchestrator session for a /clear command. Destroys the current session if alive. */
export async function resetSession(): Promise<void> {
  const session = orchestratorSession;
  invalidateSessionState();
  await destroySession(session);
}

// Persistent orchestrator session
let orchestratorSession: BackendSession | undefined;
// Coalesces concurrent ensureOrchestratorSession calls
let sessionCreatePromise: Promise<BackendSession> | undefined;

function invalidateSessionState(): void {
  sessionStateVersion++;
  orchestratorSession = undefined;
  sessionCreatePromise = undefined;
  deleteState(ORCHESTRATOR_SESSION_KEY);
}

async function destroySession(session?: BackendSession): Promise<void> {
  if (!session) return;
  try {
    await session.destroy();
  } catch {
    // Best effort — the session may already be gone.
  }
}

// Message queue — serializes access to the single persistent session
type QueuedMessage = {
  prompt: string;
  callback: MessageCallback;
  sourceChannel?: "telegram" | "tui";
  attachments?: Attachment[];
  resolve: (value: string) => void;
  reject: (err: unknown) => void;
};
const messageQueue: QueuedMessage[] = [];
let processing = false;
let currentCallback: MessageCallback | undefined;
/** The channel currently being processed — tools use this to tag new workers. */
let currentSourceChannel: "telegram" | "tui" | undefined;

/** Get the channel that originated the message currently being processed. */
export function getCurrentSourceChannel(): "telegram" | "tui" | undefined {
  return currentSourceChannel;
}

function getTools() {
  return createTools({
    client: backendClient!,
    workers,
    onWorkerComplete: feedBackgroundResult,
  });
}

/** Build a full SessionConfig using the resolver+projector pipeline. */
async function resolveSessionConfig(opts: {
  memorySummary?: string;
}): Promise<{ sessionConfig: SessionConfig; sideEffects?: () => Promise<void> }> {
  const client = backendClient!;
  const resolver = new DefaultResolver();
  const context: ResolutionContext = {
    role: "orchestrator",
    backendName: client.name,
    backendCapabilities: client.capabilities,
    memorySummary: opts.memorySummary,
    profile: config.profile,
  };

  const bundle = await resolver.resolve(context);
  const projector = createProjector(client.name);
  const projected = await projector.project(bundle, context);

  // Tools have runtime dependencies — create them here and merge into projected config
  const tools = getTools();
  const modelToUse = config.copilotModel;

  const sessionConfig: SessionConfig = {
    model: modelToUse,
    configDir: SESSIONS_DIR,
    streaming: true,
    tools: client.capabilities.customTools ? tools : undefined,
    ...projected.sessionConfig,
  };

  // For Copilot, the projector builds systemMessage but doesn't know runtime config.
  // Enrich it with the runtime options.
  if (client.name === "copilot" && !sessionConfig.appendInstructions) {
    const skillContent = client.capabilities.skillDirectories
      ? undefined
      : getSkillContentForSystemMessage() || undefined;
    sessionConfig.systemMessage = getOrchestratorSystemMessage(opts.memorySummary, {
      selfEditEnabled: config.selfEditEnabled,
      assistantDisplayName: config.assistantLabel,
      backendName: client.name,
      apiPort: config.apiPort,
      skillContent,
    });
  } else if (sessionConfig.appendInstructions) {
    // Non-Copilot append mode — enrich with runtime config
    sessionConfig.appendInstructions = getAttacheAppendInstructions(opts.memorySummary, {
      selfEditEnabled: config.selfEditEnabled,
      assistantDisplayName: config.assistantLabel,
      backendName: client.name,
      apiPort: config.apiPort,
      includeToolDocs: client.capabilities.customTools,
    });
  }

  return { sessionConfig, sideEffects: projected.sideEffects };
}

/** Feed a background worker result into the orchestrator as a new turn.
 *  The response is routed to the channel that created the worker (GUI or Telegram),
 *  so it appears inline in the user's conversation — not in a separate tab. */
export function feedBackgroundResult(workerName: string, result: string): void {
  const worker = workers.get(workerName);
  if (!worker || worker.cancelled) {
    return;
  }
  const channel = worker?.originChannel ?? "tui";
  const prompt = `[Background task completed] Worker '${workerName}' finished:\n\n${result}`;
  sendToOrchestrator(
    prompt,
    { type: "background", originChannel: channel },
    (_text, done) => {
      if (done && proactiveNotifyFn) {
        proactiveNotifyFn(_text, channel);
      }
    }
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convert internal tool names to readable labels.
 *  e.g. "mcp__attache__list_skills" → "List Skills"
 *       "create_worker_session" → "Create Worker Session"
 *       "Read" → "Read" */
function formatToolLabel(toolName: string): string {
  // Strip MCP prefix: "mcp__server__tool_name" → "tool_name"
  let name = toolName;
  const mcpMatch = name.match(/^mcp__[^_]+__(.+)$/);
  if (mcpMatch) name = mcpMatch[1];
  // Also handle "mcp:server/tool" format
  const mcpColonMatch = name.match(/^mcp:[^/]+\/(.+)$/);
  if (mcpColonMatch) name = mcpColonMatch[1];
  // Convert snake_case to Title Case
  return name
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Ensure the backend client is connected, resetting if necessary. Coalesces concurrent resets. */
let resetPromise: Promise<BackendClient> | undefined;
async function ensureClient(): Promise<BackendClient> {
  if (backendClient && backendClient.getState() === "connected") {
    return backendClient;
  }
  if (!resetPromise) {
    console.log(`${LOG_PREFIX} Client not connected (state: ${backendClient?.getState() ?? "null"}), resetting…`);
    resetPromise = resetBackendClient().then((c) => {
      console.log(`${LOG_PREFIX} Client reset successful, state: ${c.getState()}`);
      backendClient = c;
      return c;
    }).finally(() => { resetPromise = undefined; });
  }
  return resetPromise;
}

async function clearWorkers(): Promise<void> {
  if (workers.size === 0) return;

  const snapshot = Array.from(workers.values());
  workers.clear();

  await Promise.allSettled(snapshot.map(async (worker) => {
    worker.cancelled = true;
    try {
      await worker.session.destroy();
    } catch {
      // Best effort — sessions may already be gone after a reconnect/reset.
    }
  }));

  const db = getDb();
  const deleteWorker = db.prepare(`DELETE FROM worker_sessions WHERE name = ?`);
  for (const worker of snapshot) {
    deleteWorker.run(worker.name);
  }
}

/** Clear all backend-dependent session state after a reconnect/reset. */
export async function resetForBackendReset(): Promise<void> {
  const session = orchestratorSession;
  invalidateSessionState();
  await Promise.allSettled([
    destroySession(session),
    clearWorkers(),
  ]);
}

/** Start periodic health check that proactively reconnects the client.
 *  Waits for consecutive "disconnected" checks before resetting to avoid
 *  fighting with the SDK's own autoRestart / reconnect logic. */
let healthCheckMisses = 0;
const HEALTH_CHECK_MISS_THRESHOLD = 3; // require 3 consecutive misses (~90s)
function startHealthCheck(): void {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(async () => {
    if (!backendClient) return;
    try {
      const state = backendClient.getState();
      if (state === "connected") {
        healthCheckMisses = 0;
        return;
      }
      // "connecting" means the SDK is already recovering — give it time
      if (state === "connecting") {
        healthCheckMisses = 0;
        return;
      }
      healthCheckMisses++;
      if (healthCheckMisses < HEALTH_CHECK_MISS_THRESHOLD) {
        console.log(`${LOG_PREFIX} Health check: client state is '${state}' (miss ${healthCheckMisses}/${HEALTH_CHECK_MISS_THRESHOLD})`);
        return;
      }
      console.log(`${LOG_PREFIX} Health check: client state is '${state}' for ${healthCheckMisses} checks, resetting…`);
      healthCheckMisses = 0;
      await ensureClient();
    } catch (err) {
      console.error(`${LOG_PREFIX} Health check error:`, err instanceof Error ? err.message : err);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

/** Create or resume the persistent orchestrator session. */
async function ensureOrchestratorSession(): Promise<BackendSession> {
  if (orchestratorSession) return orchestratorSession;
  // Coalesce concurrent callers — wait for an in-flight creation
  if (sessionCreatePromise) return sessionCreatePromise;

  const creationVersion = sessionStateVersion;
  const creationPromise = createOrResumeSession();
  sessionCreatePromise = creationPromise;
  try {
    const session = await creationPromise;
    if (creationVersion !== sessionStateVersion) {
      await destroySession(session);
      throw new Error("Orchestrator session invalidated during creation");
    }
    orchestratorSession = session;
    return session;
  } finally {
    if (sessionCreatePromise === creationPromise) {
      sessionCreatePromise = undefined;
    }
  }
}

/** Internal: actually create or resume a session (not concurrency-safe — use ensureOrchestratorSession). */
async function createOrResumeSession(): Promise<BackendSession> {
  const client = await ensureClient();
  const memorySummary = getMemorySummary();
  const modelToUse = config.copilotModel;

  // Resolve customizations via the resolver+projector pipeline
  const { sessionConfig, sideEffects } = await resolveSessionConfig({
    memorySummary: memorySummary || undefined,
  });

  // Run side effects (e.g., skill syncing to backend-specific directories)
  if (sideEffects) {
    try {
      await sideEffects();
    } catch (err) {
      console.log(`${LOG_PREFIX} Customization side effects failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  // Try to resume a previous session
  const savedSessionId = getState(ORCHESTRATOR_SESSION_KEY);
  if (savedSessionId && client.capabilities.sessionResume) {
    try {
      console.log(`${LOG_PREFIX} Resuming orchestrator session ${savedSessionId.slice(0, 8)} with model ${modelToUse}…`);
      const session = await client.resumeSession(savedSessionId, sessionConfig);
      console.log(`${LOG_PREFIX} Resumed orchestrator session successfully (model: ${modelToUse})`);
      return session;
    } catch (err) {
      console.log(`${LOG_PREFIX} Could not resume session: ${err instanceof Error ? err.message : err}. Creating new.`);
      deleteState(ORCHESTRATOR_SESSION_KEY);
    }
  }

  // Create a fresh session
  console.log(`${LOG_PREFIX} Creating new orchestrator session with model ${modelToUse}`);
  const session = await client.createSession(sessionConfig);

  // Persist the session ID for future restarts
  setState(ORCHESTRATOR_SESSION_KEY, session.sessionId);
  console.log(`${LOG_PREFIX} Created orchestrator session ${session.sessionId.slice(0, 8)}…`);

  // Recover conversation context if available (session was lost, not first run)
  const recentHistory = getRecentConversation(10);
  if (recentHistory) {
    console.log(`${LOG_PREFIX} Injecting recent conversation context into new session`);
    try {
      await session.sendAndWait(
        `[System: Session recovered] Your previous session was lost. Here's the recent conversation for context — do NOT respond to these messages, just absorb the context silently:\n\n${recentHistory}\n\n(End of recovery context. Wait for the next real message.)`,
        60_000,
      );
    } catch (err) {
      console.log(`${LOG_PREFIX} Context recovery injection failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  return session;
}

export async function initOrchestrator(client: BackendClient): Promise<void> {
  backendClient = client;
  const mcpServers = loadMcpConfig();
  const skillDirectories = getSkillDirectories();

  // If the backend changed since last run, clear saved session and reset model
  // to the new provider's default. Sessions are not portable between backends.
  const previousBackend = getState(ORCHESTRATOR_BACKEND_KEY);
  if (previousBackend && previousBackend !== client.name) {
    console.log(`${LOG_PREFIX} Backend changed from '${previousBackend}' to '${client.name}' — resetting session`);
    await resetForBackendReset();

    // Auto-switch to the new provider's default model
    const providerDefault = getDefaultModelForProvider(client.name);
    if (providerDefault) {
      console.log(`${LOG_PREFIX} Switching model to ${client.name} default: ${providerDefault}`);
      config.copilotModel = providerDefault;
    }
  }
  setState(ORCHESTRATOR_BACKEND_KEY, client.name);

  // Validate configured model against available models (if backend supports listing)
  if (client.capabilities.modelListing) {
    try {
      const models = await client.listModels();
      const configured = config.copilotModel;
      const isAvailable = models.some((m) => m.id === configured);
      if (!isAvailable) {
        // Use the first model from the provider's own list, not the global default
        const fallback = getDefaultModelForProvider(client.name) || DEFAULT_MODEL;
        console.log(`${LOG_PREFIX} ⚠️ Configured model '${configured}' is not available on ${client.name}. Falling back to '${fallback}'.`);
        config.copilotModel = fallback;
      }
    } catch (err) {
      console.log(`${LOG_PREFIX} Could not validate model (will use '${config.copilotModel}' as-is): ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`${LOG_PREFIX} Backend: ${client.name}`);
  console.log(`${LOG_PREFIX} System message mode: ${client.name === "copilot" || !client.capabilities.skillDirectories ? "replace" : "append (preset + Attache instructions)"}`);
  console.log(`${LOG_PREFIX} Loading ${Object.keys(mcpServers).length} MCP server(s): ${Object.keys(mcpServers).join(", ") || "(none)"}`);
  console.log(`${LOG_PREFIX} Skill directories: ${skillDirectories.join(", ") || "(none)"}`);
  console.log(`${LOG_PREFIX} Persistent session mode — conversation history maintained by backend`);
  startHealthCheck();

  // Eagerly create/resume the orchestrator session
  try {
    await ensureOrchestratorSession();
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to create initial session (will retry on first message):`, err instanceof Error ? err.message : err);
  }
}

/** Send a prompt on the persistent session, return the response. */
async function executeOnSession(prompt: string, callback: MessageCallback, attachments?: Attachment[]): Promise<string> {
  const session = await ensureOrchestratorSession();
  currentCallback = callback;

  let accumulated = "";
  let toolCallExecuted = false;
  const internalToolNames = new Set(TOOL_REGISTRY.map((t) => t.name));
  // Track external tool calls so we can inject their results into the stream
  const pendingToolCalls = new Map<string, string>(); // toolCallId → toolName

  const unsubToolStart = session.on("tool.execution_start", (data) => {
    const { toolCallId, toolName } = data;
    if (!internalToolNames.has(toolName)) {
      pendingToolCalls.set(toolCallId, toolName);
      const label = formatToolLabel(toolName);
      if (accumulated.length > 0 && !accumulated.endsWith("\n")) {
        accumulated += "\n";
      }
      accumulated += `\n<details open class="tool-trace"><summary class="tool-running">${escapeHtml(label)}</summary><div class="tool-output">Running\u2026</div></details>\n`;
      callback(accumulated, false);
    }
  });
  const unsubToolDone = session.on("tool.execution_complete", (data) => {
    toolCallExecuted = true;
    const toolName = pendingToolCalls.get(data.toolCallId);
    if (toolName) {
      pendingToolCalls.delete(data.toolCallId);
      const label = formatToolLabel(toolName);
      const content = data.result?.content || "(no output)";
      // Replace the "running" indicator with the completed result
      const runningPattern = `<details open class="tool-trace"><summary class="tool-running">${escapeHtml(label)}</summary><div class="tool-output">Running\u2026</div></details>`;
      const completedBlock = `<details class="tool-trace"><summary class="tool-done">${escapeHtml(label)}</summary><div class="tool-output"><pre>${escapeHtml(content)}</pre></div></details>`;
      if (accumulated.includes(runningPattern)) {
        accumulated = accumulated.replace(runningPattern, completedBlock);
      } else {
        if (accumulated.length > 0 && !accumulated.endsWith("\n")) {
          accumulated += "\n";
        }
        accumulated += `\n${completedBlock}\n`;
      }
      callback(accumulated, false);
    }
  });
  const unsubDelta = session.on("assistant.message_delta", (data) => {
    // After a tool call completes, ensure a line break separates the text blocks
    // so they don't visually run together in the TUI.
    if (toolCallExecuted && accumulated.length > 0 && !accumulated.endsWith("\n")) {
      accumulated += "\n";
    }
    toolCallExecuted = false;
    accumulated += data.deltaContent;
    callback(accumulated, false);
  });

  try {
    const result = await session.sendAndWait(prompt, 300_000, attachments);
    // Prefer accumulated content (includes tool traces as collapsible boxes)
    // over result.content (SDK's plain-text response without traces).
    const finalContent = accumulated || result.content || "(No response)";
    return finalContent;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isRecoverableError(err)) {
      console.log(`${LOG_PREFIX} Session error, invalidating cached session: ${msg}`);
      await destroySession(orchestratorSession);
      invalidateSessionState();
    }
    throw err;
  } finally {
    unsubDelta();
    unsubToolStart();
    unsubToolDone();
    currentCallback = undefined;
  }
}

/** Process the message queue one at a time. */
async function processQueue(): Promise<void> {
  if (processing) {
    if (messageQueue.length > 0) {
      console.log(`${LOG_PREFIX} Message queued (${messageQueue.length} waiting — orchestrator is busy)`);
    }
    return;
  }
  processing = true;

  while (messageQueue.length > 0) {
    const item = messageQueue.shift()!;
    currentSourceChannel = item.sourceChannel;
    try {
      const result = await executeOnSession(item.prompt, item.callback, item.attachments);
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    }
    currentSourceChannel = undefined;
  }

  processing = false;
}

function isRecoverableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|disconnect|connection refused|connection reset|connection closed|connection error|EPIPE|ECONNRESET|ECONNREFUSED|ENOENT|socket hang up|socket closed|channel closed|spawn.*not found|no conversation found|session expired|session not found|stale/i.test(msg);
}

export async function sendToOrchestrator(
  prompt: string,
  source: MessageSource,
  callback: MessageCallback,
  attachments?: Attachment[]
): Promise<void> {
  // Background messages route to the channel that created the worker,
  // so responses appear inline in the user's conversation.
  const sourceLabel =
    source.type === "telegram" ? "telegram" :
    source.type === "tui" ? "tui" :
    source.originChannel ?? "tui"; // background → origin channel (default tui)
  logMessage("in", sourceLabel, prompt);

  // Tag the prompt with its source channel
  const taggedPrompt = source.type === "background"
    ? prompt
    : `[via ${sourceLabel}] ${prompt}`;

  // Log role: background events are "system", user messages are "user"
  const logRole = source.type === "background" ? "system" : "user";

  // Determine the source channel for worker origin tracking
  const sourceChannel: "telegram" | "tui" | undefined =
    source.type === "telegram" ? "telegram" :
    source.type === "tui" ? "tui" : undefined;

  // Enqueue and process
  void (async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const finalContent = await new Promise<string>((resolve, reject) => {
          messageQueue.push({ prompt: taggedPrompt, callback, sourceChannel, attachments, resolve, reject });
          processQueue();
        });
        // Deliver response to user FIRST, then log best-effort
        callback(finalContent, true);
        try { logMessage("out", sourceLabel, finalContent); } catch { /* best-effort */ }
        // Log both sides of the conversation after delivery
        try { logConversation(logRole, prompt, sourceLabel); } catch { /* best-effort */ }
        try { logConversation("assistant", finalContent, sourceLabel); } catch { /* best-effort */ }
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // Don't retry cancelled messages
        if (/cancelled|abort/i.test(msg)) {
          return;
        }

        if (isRecoverableError(err) && attempt < MAX_RETRIES) {
          const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
          console.error(`${LOG_PREFIX} Recoverable error: ${msg}. Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms…`);
          invalidateSessionState();
          await sleep(delay);
          // Reset client before retry in case the connection is stale
          try { await ensureClient(); } catch { /* will fail again on next attempt */ }
          continue;
        }

        console.error(`${LOG_PREFIX} Error processing message: ${msg}`);
        callback(`Error: ${msg}`, true);
        return;
      }
    }
  })();
}

/** Cancel the in-flight foreground message and drain foreground items from the queue.
 *  Background messages (cron, worker completions) are preserved so they don't strand. */
export async function cancelCurrentMessage(): Promise<boolean> {
  // Only drain foreground (non-background) queued messages
  const preserved: QueuedMessage[] = [];
  let cancelledCount = 0;
  while (messageQueue.length > 0) {
    const item = messageQueue.shift()!;
    if (item.sourceChannel === undefined) {
      // Background message — keep it in the queue
      preserved.push(item);
    } else {
      item.reject(new Error("Cancelled"));
      cancelledCount++;
    }
  }
  // Re-queue preserved background messages
  for (const item of preserved) {
    messageQueue.push(item);
  }

  // Abort the active session request only if it's a foreground message
  if (orchestratorSession && currentCallback && currentSourceChannel !== undefined) {
    try {
      await orchestratorSession.abort();
      console.log(`${LOG_PREFIX} Aborted in-flight request`);
      return true;
    } catch (err) {
      console.error(`${LOG_PREFIX} Abort failed:`, err instanceof Error ? err.message : err);
    }
  }

  return cancelledCount > 0;
}

export function getWorkers(): Map<string, WorkerInfo> {
  return workers;
}
