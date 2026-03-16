import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  BackendSession,
  SendResult,
  SessionEventName,
  SessionEvents,
  UnsubscribeFn,
} from "../../types.js";
import { LOG_PREFIX } from "../../../identity.js";

export interface ClaudeQueryOptions {
  model: string;
  systemPrompt?: string;
  cwd?: string;
  allowedTools: string[];
  permissionMode: string;
  allowDangerouslySkipPermissions: boolean;
  maxTurns: number;
  mcpServers?: Record<string, any>;
  includePartialMessages: boolean;
  env?: Record<string, string | undefined>;
  stderr?: (data: string) => void;
  /** Called when the SDK reports available models (opportunistic cache update). */
  onModelsDiscovered?: (models: { value: string; displayName: string }[]) => void;
}

/**
 * Adapts the Claude Agent SDK `query()` async generator to the BackendSession interface.
 *
 * Each `sendAndWait()` call spawns a new Claude Code subprocess that either starts
 * a fresh session (first call) or resumes the existing one (subsequent calls).
 */
export class ClaudeBackendSession implements BackendSession {
  private _sessionId: string;
  private readonly _isResuming: boolean;
  private _queryCount = 0;
  private _destroyed = false;
  private _activeAbortController: AbortController | undefined;
  private _activeQuery: ReturnType<typeof query> | undefined;
  private readonly _handlers = new Map<string, Set<Function>>();

  constructor(
    private readonly options: ClaudeQueryOptions,
    resumeSessionId?: string,
  ) {
    this._sessionId = resumeSessionId || crypto.randomUUID();
    this._isResuming = !!resumeSessionId;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  async sendAndWait(prompt: string, timeoutMs?: number): Promise<SendResult> {
    if (this._destroyed) throw new Error("Session is destroyed");

    const ac = new AbortController();
    this._activeAbortController = ac;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timeoutId = setTimeout(() => ac.abort(), timeoutMs);
    }

    const queryOpts: Record<string, any> = { ...this.options, abortController: ac };

    // First call on a new session: assign our pre-generated sessionId.
    // Subsequent calls (or resumed sessions): use `resume` to continue.
    if (this._isResuming || this._queryCount > 0) {
      queryOpts.resume = this._sessionId;
    } else {
      queryOpts.sessionId = this._sessionId;
    }
    this._queryCount++;

    let resultText = "";

    try {
      const q = query({ prompt, options: queryOpts });
      this._activeQuery = q;

      for await (const msg of q) {
        if (this._destroyed) break;

        switch ((msg as any).type) {
          case "system": {
            const sysMsg = msg as any;
            if (sysMsg.subtype === "init" && sysMsg.session_id) {
              this._sessionId = sysMsg.session_id;
              // Opportunistically fetch available models from the running process
              if (this.options.onModelsDiscovered && this._queryCount === 1) {
                q.supportedModels()
                  .then((models) => {
                    if (models?.length) this.options.onModelsDiscovered!(models);
                  })
                  .catch(() => { /* best-effort */ });
              }
            }
            break;
          }

          case "stream_event": {
            // SDKPartialAssistantMessage — streaming text deltas
            const event = (msg as any).event;
            if (
              event?.type === "content_block_delta" &&
              event?.delta?.type === "text_delta"
            ) {
              this.emit("assistant.message_delta", {
                deltaContent: event.delta.text,
              });
            }
            break;
          }

          case "assistant": {
            // SDKAssistantMessage — extract tool_use content blocks
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "tool_use") {
                  this.emit("tool.execution_start", {
                    toolCallId: block.id,
                    toolName: block.name,
                  });
                }
              }
            }
            break;
          }

          case "user": {
            // SDKUserMessage — extract tool_result content blocks
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "tool_result") {
                  const text =
                    typeof block.content === "string"
                      ? block.content
                      : Array.isArray(block.content)
                        ? block.content
                            .filter((c: any) => c.type === "text")
                            .map((c: any) => c.text)
                            .join("\n")
                        : "";
                  this.emit("tool.execution_complete", {
                    toolCallId: block.tool_use_id,
                    result: { content: text },
                  });
                }
              }
            }
            break;
          }

          case "result": {
            // SDKResultMessage — final result
            const result = msg as any;
            if (result.session_id) this._sessionId = result.session_id;
            if (result.total_cost_usd) {
              console.log(
                `${LOG_PREFIX} Claude query cost: $${result.total_cost_usd.toFixed(4)}`,
              );
            }
            // Error results should throw so the orchestrator can recover
            if (result.is_error || (result.subtype && result.subtype !== "success")) {
              const errorText = result.errors?.join("; ") || result.result || "Unknown error";
              throw new Error(`Claude Code error: ${errorText}`);
            }
            resultText = result.result || "";
            break;
          }
        }
      }

      return { content: resultText };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this._activeAbortController = undefined;
      this._activeQuery = undefined;
    }
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
    this._activeAbortController?.abort();
    try {
      this._activeQuery?.close();
    } catch {
      /* best-effort */
    }
  }

  async destroy(): Promise<void> {
    this._destroyed = true;
    await this.abort();
    this._handlers.clear();
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
