/**
 * Abstract backend interfaces for multi-agent support.
 *
 * Attache can run on Copilot SDK, Claude Agent SDK, or OpenAI Codex SDK.
 * These interfaces define the common surface used by the orchestrator
 * and workers.
 */

export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

export interface ModelInfo {
  id: string;
  name: string;
  multiplier: number;
  enabled: boolean;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SessionConfig {
  model: string;
  systemMessage?: string;
  streaming?: boolean;
  workingDirectory?: string;
  configDir?: string;
  tools?: unknown[];
  mcpServers?: Record<string, McpServerConfig>;
  skillDirectories?: string[];
  infiniteSessions?: {
    enabled: boolean;
    backgroundCompactionThreshold: number;
    bufferExhaustionThreshold: number;
  };
}

export interface SessionEvents {
  "assistant.message_delta": { deltaContent: string };
  "tool.execution_start": { toolCallId: string; toolName: string };
  "tool.execution_complete": { toolCallId: string; result: { content: string } };
}
export type SessionEventName = keyof SessionEvents;
export type UnsubscribeFn = () => void;

export interface SendResult {
  content: string;
}

export interface BackendSession {
  readonly sessionId: string;
  sendAndWait(prompt: string, timeoutMs?: number): Promise<SendResult>;
  on<E extends SessionEventName>(event: E, handler: (data: SessionEvents[E]) => void): UnsubscribeFn;
  abort(): Promise<void>;
  destroy(): Promise<void>;
}

export interface BackendCapabilities {
  customTools: boolean;
  sessionResume: boolean;
  infiniteSessions: boolean;
  persistentClient: boolean;
  modelListing: boolean;
  skillDirectories: boolean;
  structuredOutput: boolean;
  machineSessionDiscovery: boolean;
}

export interface BackendClient {
  readonly name: string;
  readonly capabilities: BackendCapabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): ConnectionState;
  listModels(): Promise<ModelInfo[]>;
  createSession(config: SessionConfig): Promise<BackendSession>;
  resumeSession(sessionId: string, config: SessionConfig): Promise<BackendSession>;
}
