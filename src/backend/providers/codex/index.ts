import type {
  BackendClient,
  BackendCapabilities,
  BackendSession,
  ConnectionState,
  ModelInfo,
  SessionConfig,
} from "../../types.js";
import { CodexBackendSession } from "./session.js";
import { bridgeToolsForCodex } from "./tool-bridge.js";
import { CODEX_MODELS } from "./models.js";
import { LOG_PREFIX } from "../../../identity.js";
import { ATTACHE_ENV_PATH } from "../../../paths.js";
import { readFileSync, readdirSync, statSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import { createServer } from "net";
import { dirname, join } from "path";
import { createRequire } from "module";
import WebSocket from "ws";

const require = createRequire(import.meta.url);

// JSON-RPC 2.0 message types
interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}
interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: unknown;
}
type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

/** Notification handler registered by sessions. */
export type NotificationHandler = (method: string, params: any) => void;

/**
 * Codex app-server backend — spawns `codex app-server` as a persistent WebSocket
 * server and communicates via JSON-RPC 2.0.
 *
 * Unlike the SDK approach (which spawns a new CLI process per turn), the app-server
 * is a single long-lived process with native thread/session management.
 */
export class CodexBackendClient implements BackendClient {
  readonly name = "codex";
  readonly capabilities: BackendCapabilities = {
    customTools: true,
    sessionResume: true,
    infiniteSessions: false,
    persistentClient: true,
    modelListing: true,
    skillDirectories: true,
    structuredOutput: false,
    machineSessionDiscovery: false,
    vision: true,
  };

  private state: ConnectionState = "disconnected";
  private serverProcess: ChildProcess | undefined;
  private ws: WebSocket | undefined;
  private port = 0;
  private rpcId = 0;
  private pendingRpc = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private cachedModels: ModelInfo[] | undefined;
  private dynamicToolHandlers = new Map<string, (toolName: string, args: any) => Promise<{ success: boolean; contentItems: Array<{ type: string; text?: string }> }>>();

  async start(): Promise<void> {
    this.state = "connecting";

    // Resolve API key
    const env = { ...process.env };
    try {
      const envContent = readFileSync(ATTACHE_ENV_PATH, "utf-8");
      const match = envContent.match(/^OPENAI_API_KEY\s*=\s*(.+)$/m);
      if (match) {
        env.OPENAI_API_KEY = match[1].trim().replace(/^["']|["']$/g, "");
        console.log(`${LOG_PREFIX} Codex backend: using configured OPENAI_API_KEY`);
      }
    } catch {
      /* no .env file */
    }
    if (!env.OPENAI_API_KEY) {
      console.log(`${LOG_PREFIX} Codex backend: using inherited environment auth`);
    }

    // Find a free port
    this.port = await findFreePort();

    // Find and spawn the codex binary
    const binary = findCodexBinary();
    console.log(`${LOG_PREFIX} Starting codex app-server on ws://127.0.0.1:${this.port}`);
    this.serverProcess = spawn(
      binary,
      ["app-server", "--listen", `ws://127.0.0.1:${this.port}`],
      { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    // Log stderr for diagnostics
    this.serverProcess.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`${LOG_PREFIX} [codex-server] ${text}`);
    });

    this.serverProcess.on("exit", (code) => {
      if (this.state !== "disconnected") {
        console.log(`${LOG_PREFIX} Codex app-server exited (code ${code})`);
        this.state = "error";
      }
    });

    // Wait for the server to become ready
    await this.waitForReady();

    // Connect WebSocket
    await this.connectWebSocket();

    // Send initialize handshake
    await this.sendRpc("initialize", {
      clientInfo: { name: "attache", title: "Attache Daemon", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });

    this.state = "connected";
    console.log(`${LOG_PREFIX} Codex backend client ready (app-server on port ${this.port})`);
  }

  async stop(): Promise<void> {
    this.state = "disconnected";
    this.notificationHandlers.clear();
    this.dynamicToolHandlers.clear();
    for (const { reject } of this.pendingRpc.values()) {
      reject(new Error("Client stopped"));
    }
    this.pendingRpc.clear();
    if (this.ws) {
      try { this.ws.close(); } catch { /* best-effort */ }
      this.ws = undefined;
    }
    if (this.serverProcess) {
      this.serverProcess.kill();
      this.serverProcess = undefined;
    }
  }

  getState(): ConnectionState {
    return this.state;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.cachedModels) return this.cachedModels;
    if (this.state !== "connected") return CODEX_MODELS;

    try {
      const result = await this.sendRpc("model/list", { limit: 50 }) as any;
      if (result?.data?.length > 0) {
        this.cachedModels = result.data.map((m: any) => ({
          id: m.model || m.id,
          name: m.displayName || m.model || m.id,
          multiplier: -1,
          enabled: !m.hidden,
        }));
        const cached = this.cachedModels!;
        console.log(`${LOG_PREFIX} Cached ${cached.length} models from Codex app-server`);
        return cached;
      }
    } catch (err) {
      console.log(`${LOG_PREFIX} Could not list models from app-server: ${err instanceof Error ? err.message : err}`);
    }
    return CODEX_MODELS;
  }

  async createSession(config: SessionConfig): Promise<BackendSession> {
    if (this.state !== "connected") throw new Error("Codex client not connected");
    const { sessionConfig, handler } = this.bridgeTools(config);
    return new CodexBackendSession(this, sessionConfig, undefined, handler);
  }

  async resumeSession(threadId: string, config: SessionConfig): Promise<BackendSession> {
    if (this.state !== "connected") throw new Error("Codex client not connected");
    const { sessionConfig, handler } = this.bridgeTools(config);
    return new CodexBackendSession(this, sessionConfig, threadId, handler);
  }

  /** Convert Copilot SDK tools to Codex dynamicTools and create a handler. */
  private bridgeTools(config: SessionConfig): {
    sessionConfig: SessionConfig;
    handler?: (toolName: string, args: any) => Promise<{ success: boolean; contentItems: Array<{ type: string; text?: string }> }>;
  } {
    if (!config.tools?.length) return { sessionConfig: config };

    const { specs, handler } = bridgeToolsForCodex(config.tools as import("../copilot/tool-bridge.js").Tool<any>[]);
    return {
      sessionConfig: {
        ...config,
        tools: undefined,     // Don't pass Copilot-format tools to Codex
        dynamicTools: specs,  // Pass converted dynamic tools instead
      },
      handler,
    };
  }

  async reset(): Promise<void> {
    await this.stop();
    await this.start();
  }

  // -- RPC interface for sessions --

  /** Send a JSON-RPC request and wait for the response. */
  sendRpc(method: string, params: unknown): Promise<unknown> {
    const id = ++this.rpcId;
    return new Promise((resolve, reject) => {
      this.pendingRpc.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      try {
        this.ws!.send(msg);
      } catch (err) {
        this.pendingRpc.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Register a notification handler for a specific thread. */
  registerThread(threadId: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(threadId, handler);
  }

  /** Unregister a thread's notification handler. */
  unregisterThread(threadId: string): void {
    this.notificationHandlers.delete(threadId);
  }

  /** Register a dynamic tool call handler for a specific thread. */
  registerDynamicToolHandler(threadId: string, handler: (toolName: string, args: any) => Promise<{ success: boolean; contentItems: Array<{ type: string; text?: string }> }>): void {
    this.dynamicToolHandlers.set(threadId, handler);
  }

  /** Unregister a dynamic tool handler. */
  unregisterDynamicToolHandler(threadId: string): void {
    this.dynamicToolHandlers.delete(threadId);
  }

  // -- Internal --

  private async waitForReady(): Promise<void> {
    const url = `http://127.0.0.1:${this.port}/readyz`;
    const maxWaitMs = 30_000;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const resp = await fetch(url);
        if (resp.ok) return;
      } catch {
        /* server not ready yet */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`Codex app-server did not become ready within ${maxWaitMs / 1000}s`);
  }

  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      ws.once("open", () => {
        this.ws = ws;
        resolve();
      });
      ws.once("error", () => {
        reject(new Error(`WebSocket connection failed`));
      });
      ws.on("close", () => {
        if (this.state === "connected") {
          console.log(`${LOG_PREFIX} Codex WebSocket disconnected`);
          this.state = "error";
        }
      });
      ws.on("message", (data) => {
        this.handleMessage(typeof data === "string" ? data : data.toString());
      });
    });
  }

  private handleMessage(raw: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Response to one of our requests
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      const pending = this.pendingRpc.get(msg.id as number);
      if (pending) {
        this.pendingRpc.delete(msg.id as number);
        if ((msg as RpcResponse).error) {
          pending.reject(new Error((msg as RpcResponse).error!.message));
        } else {
          pending.resolve((msg as RpcResponse).result);
        }
      }
      return;
    }

    // Server request (approval, input) — requires a response
    if ("id" in msg && "method" in msg) {
      this.handleServerRequest(msg as RpcRequest);
      return;
    }

    // Notification — route to session by threadId
    if ("method" in msg && !("id" in msg)) {
      const params = (msg as RpcNotification).params as any;
      const threadId = params?.threadId || params?.thread?.id;

      if (threadId) {
        const handler = this.notificationHandlers.get(threadId);
        if (handler) {
          handler((msg as RpcNotification).method, params);
          return;
        }
      }

      // Broadcast to all handlers if no threadId or handler not found
      for (const handler of this.notificationHandlers.values()) {
        handler((msg as RpcNotification).method, params);
      }
      return;
    }
  }

  private handleServerRequest(msg: RpcRequest): void {
    const method = msg.method;
    // Security model: Attache is a personal daemon running as the local user.
    // All actions are auto-approved because the bearer-token-authenticated API
    // surface is the trust boundary, not individual tool invocations.
    if (method.includes("requestApproval") || method === "applyPatchApproval") {
      this.sendResponse(msg.id, { decision: "acceptForSession" });
    } else if (method === "execCommandApproval") {
      this.sendResponse(msg.id, { decision: "acceptForSession" });
    } else if (method.includes("requestUserInput")) {
      // Can't handle interactive input — decline
      this.sendResponse(msg.id, { answers: [] });
    } else if (method === "dynamicToolCall") {
      const params = msg.params as any;
      const threadId = params?.threadId;
      const handler = threadId ? this.dynamicToolHandlers.get(threadId) : undefined;
      if (handler) {
        handler(params.toolName, params.arguments || {})
          .then((result) => this.sendResponse(msg.id, result))
          .catch((err) => this.sendResponse(msg.id, {
            success: false,
            contentItems: [{ type: "inputText", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          }));
      } else {
        this.sendResponse(msg.id, {
          success: false,
          contentItems: [{ type: "inputText", text: `No handler registered for dynamic tool call` }],
        });
      }
    } else {
      // Unknown server request — respond with empty result
      this.sendResponse(msg.id, {});
    }
  }

  private sendResponse(id: number, result: unknown): void {
    try {
      this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch {
      /* best-effort */
    }
  }
}

// -- Utilities --

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function findCodexBinary(): string {
  const key = `${process.platform}-${process.arch}`;
  const pkgMap: Record<string, string> = {
    "win32-x64": "@openai/codex-win32-x64",
    "win32-arm64": "@openai/codex-win32-arm64",
    "darwin-x64": "@openai/codex-darwin-x64",
    "darwin-arm64": "@openai/codex-darwin-arm64",
    "linux-x64": "@openai/codex-linux-x64",
    "linux-arm64": "@openai/codex-linux-arm64",
  };
  const pkg = pkgMap[key];
  if (!pkg) throw new Error(`Codex: unsupported platform ${key}`);

  const pkgDir = dirname(require.resolve(`${pkg}/package.json`));
  const ext = process.platform === "win32" ? ".exe" : "";

  // Walk vendor/ to find the codex binary (depth-limited to avoid runaway recursion)
  function find(dir: string, depth = 0): string | undefined {
    if (depth > 5) return undefined;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          const found = find(full, depth + 1);
          if (found) return found;
        } else if (entry === `codex${ext}`) {
          return full;
        }
      } catch {
        // Skip entries that can't be stat'd (broken symlinks, permission errors)
      }
    }
  }

  const vendorDir = join(pkgDir, "vendor");
  const binary = find(vendorDir);
  if (!binary) throw new Error(`Could not find codex binary in ${vendorDir}`);
  return binary;
}
