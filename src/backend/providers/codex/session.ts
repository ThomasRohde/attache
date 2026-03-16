import type { CodexBackendClient, NotificationHandler } from "./index.js";
import type {
  BackendSession,
  SendResult,
  SessionConfig,
  SessionEventName,
  SessionEvents,
  UnsubscribeFn,
} from "../../types.js";
import { LOG_PREFIX } from "../../../identity.js";

/**
 * Adapts a Codex app-server thread to the BackendSession interface.
 *
 * Uses JSON-RPC over WebSocket: thread/start or thread/resume to create the
 * thread, then turn/start for each prompt. Notifications stream back events
 * which are mapped to BackendSession events.
 */
export class CodexBackendSession implements BackendSession {
  private _threadId: string;
  private _threadStarted = false;
  private readonly _isResuming: boolean;
  private _turnCount = 0;
  private _destroyed = false;
  private readonly _handlers = new Map<string, Set<Function>>();

  // Turn state — set during sendAndWait, cleared when turn completes
  private _turnResolve: ((result: SendResult) => void) | undefined;
  private _turnReject: ((err: Error) => void) | undefined;
  private _turnTimeout: ReturnType<typeof setTimeout> | undefined;
  private _resultText = "";

  constructor(
    private readonly client: CodexBackendClient,
    private readonly config: SessionConfig,
    resumeThreadId?: string,
  ) {
    this._threadId = resumeThreadId || crypto.randomUUID();
    this._isResuming = !!resumeThreadId;
  }

  get sessionId(): string {
    return this._threadId;
  }

  async sendAndWait(prompt: string, timeoutMs?: number): Promise<SendResult> {
    if (this._destroyed) throw new Error("Session is destroyed");

    // Start or resume thread on first turn
    if (!this._threadStarted) {
      await this.ensureThread();
    }

    // Prepend system message to first turn's prompt
    let effectivePrompt = prompt;
    if (this._turnCount === 0 && this.config.systemMessage) {
      effectivePrompt = `[System Instructions]\n${this.config.systemMessage}\n[End System Instructions]\n\n${prompt}`;
    }
    this._turnCount++;
    this._resultText = "";

    return new Promise<SendResult>((resolve, reject) => {
      this._turnResolve = resolve;
      this._turnReject = reject;

      if (timeoutMs) {
        this._turnTimeout = setTimeout(() => {
          this.interruptTurn();
          reject(new Error("Turn timed out"));
          this.clearTurnState();
        }, timeoutMs);
      }

      // Send turn/start
      this.client.sendRpc("turn/start", {
        threadId: this._threadId,
        input: [{ type: "text", text: effectivePrompt, text_elements: [] }],
        model: this.config.model,
        approvalPolicy: "never",
        effort: "medium",
      }).catch((err) => {
        reject(err instanceof Error ? err : new Error(String(err)));
        this.clearTurnState();
      });
    });
  }

  on<E extends SessionEventName>(
    event: E,
    handler: (data: SessionEvents[E]) => void,
  ): UnsubscribeFn {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    this._handlers.get(event)!.add(handler);
    return () => {
      this._handlers.get(event)?.delete(handler);
    };
  }

  async abort(): Promise<void> {
    await this.interruptTurn();
  }

  async destroy(): Promise<void> {
    this._destroyed = true;
    await this.abort();
    this._handlers.clear();
    this.client.unregisterThread(this._threadId);
  }

  // -- Internal --

  private async ensureThread(): Promise<void> {
    // Register notification handler before starting the thread
    const handler: NotificationHandler = (method, params) => {
      this.handleNotification(method, params);
    };
    this.client.registerThread(this._threadId, handler);

    if (this._isResuming) {
      const result = await this.client.sendRpc("thread/resume", {
        threadId: this._threadId,
        model: this.config.model,
        cwd: this.config.workingDirectory || undefined,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        persistExtendedHistory: false,
      }) as any;
      if (result?.thread?.id) {
        this.reregisterThread(result.thread.id);
      }
    } else {
      const result = await this.client.sendRpc("thread/start", {
        model: this.config.model,
        cwd: this.config.workingDirectory || undefined,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      }) as any;
      if (result?.thread?.id) {
        this.reregisterThread(result.thread.id);
      }
    }

    this._threadStarted = true;
  }

  /** Update thread ID if the server assigned a different one. */
  private reregisterThread(newId: string): void {
    if (newId !== this._threadId) {
      this.client.unregisterThread(this._threadId);
      this._threadId = newId;
      this.client.registerThread(this._threadId, (method, params) => {
        this.handleNotification(method, params);
      });
    }
  }

  private handleNotification(method: string, params: any): void {
    if (this._destroyed) return;

    switch (method) {
      case "thread/started": {
        const threadId = params?.thread?.id;
        if (threadId) this.reregisterThread(threadId);
        break;
      }

      case "item/agentMessage/delta": {
        const delta = params?.delta;
        if (typeof delta === "string" && delta) {
          this._resultText += delta;
          this.emit("assistant.message_delta", { deltaContent: delta });
        }
        break;
      }

      case "item/started": {
        const item = params?.item;
        if (!item) break;
        if (item.type === "commandExecution") {
          this.emit("tool.execution_start", {
            toolCallId: item.id || crypto.randomUUID(),
            toolName: "command_execution",
          });
        } else if (item.type === "fileChange") {
          this.emit("tool.execution_start", {
            toolCallId: item.id || crypto.randomUUID(),
            toolName: "file_change",
          });
        } else if (item.type === "mcpToolCall") {
          this.emit("tool.execution_start", {
            toolCallId: item.id || crypto.randomUUID(),
            toolName: `mcp:${item.server}/${item.tool}`,
          });
        }
        break;
      }

      case "item/completed": {
        const item = params?.item;
        if (!item) break;
        if (item.type === "commandExecution") {
          this.emit("tool.execution_complete", {
            toolCallId: item.id || "",
            result: { content: item.aggregatedOutput || `exit ${item.exitCode ?? "?"}` },
          });
        } else if (item.type === "fileChange") {
          const summary = Array.isArray(item.changes)
            ? item.changes.map((c: any) => c.path || "file").join(", ")
            : "files updated";
          this.emit("tool.execution_complete", {
            toolCallId: item.id || "",
            result: { content: summary },
          });
        } else if (item.type === "mcpToolCall") {
          this.emit("tool.execution_complete", {
            toolCallId: item.id || "",
            result: { content: item.result?.text || item.error?.message || "done" },
          });
        } else if (item.type === "agentMessage" && typeof item.text === "string") {
          this._resultText = item.text;
        }
        break;
      }

      case "turn/completed": {
        if (this._turnResolve) {
          this._turnResolve({ content: this._resultText });
          this.clearTurnState();
        }
        break;
      }

      case "error": {
        const msg = params?.error?.message || params?.message || "Unknown Codex error";
        console.error(`${LOG_PREFIX} Codex error: ${msg}`);
        if (this._turnReject) {
          this._turnReject(new Error(`Codex error: ${msg}`));
          this.clearTurnState();
        }
        break;
      }

      case "thread/status/changed": {
        const status = params?.status;
        if (status?.type === "systemError" && this._turnReject) {
          this._turnReject(new Error("Codex thread error"));
          this.clearTurnState();
        }
        break;
      }
    }
  }

  private async interruptTurn(): Promise<void> {
    try {
      await this.client.sendRpc("turn/interrupt", { threadId: this._threadId });
    } catch {
      /* best-effort */
    }
  }

  private clearTurnState(): void {
    if (this._turnTimeout) {
      clearTimeout(this._turnTimeout);
      this._turnTimeout = undefined;
    }
    this._turnResolve = undefined;
    this._turnReject = undefined;
  }

  private emit<E extends SessionEventName>(
    event: E,
    data: SessionEvents[E],
  ): void {
    const handlers = this._handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        (handler as (data: SessionEvents[E]) => void)(data);
      } catch {
        /* non-fatal */
      }
    }
  }
}
