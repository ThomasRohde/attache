import type {
  BackendClient,
  BackendCapabilities,
  BackendSession,
  ConnectionState,
  ModelInfo,
  SessionConfig,
} from "../../types.js";
import { ClaudeBackendSession, type ClaudeQueryOptions } from "./session.js";
import { CLAUDE_MODELS } from "./models.js";
import { LOG_PREFIX } from "../../../identity.js";
import { ATTACHE_ENV_PATH } from "../../../paths.js";
import { readFileSync } from "fs";

const DEFAULT_ALLOWED_TOOLS = [
  "Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch",
];

/**
 * Claude Agent SDK backend — wraps query() into the abstract BackendClient interface.
 *
 * Unlike the Copilot SDK, there is no persistent client process. Each session call
 * spawns a short-lived Claude Code subprocess. start()/stop() simply validate state.
 */
export class ClaudeBackendClient implements BackendClient {
  readonly name = "claude";
  readonly capabilities: BackendCapabilities = {
    customTools: false,
    sessionResume: true,
    infiniteSessions: false,
    persistentClient: false,
    modelListing: true,
    skillDirectories: false,
    structuredOutput: false,
    machineSessionDiscovery: false,
  };

  private state: ConnectionState = "disconnected";
  private useExplicitApiKey = false;
  private cachedModels: ModelInfo[] | undefined;

  async start(): Promise<void> {
    // Only use ANTHROPIC_API_KEY if it's explicitly in the user's .env file,
    // not inherited from a parent process (e.g. daemon launched from Claude Code CLI).
    try {
      const envContent = readFileSync(ATTACHE_ENV_PATH, "utf-8");
      this.useExplicitApiKey = /^ANTHROPIC_API_KEY\s*=/m.test(envContent);
    } catch {
      this.useExplicitApiKey = false;
    }
    if (this.useExplicitApiKey) {
      console.log(`${LOG_PREFIX} Claude backend: using configured ANTHROPIC_API_KEY`);
    } else {
      console.log(`${LOG_PREFIX} Claude backend: using Claude Code CLI auth (subscription)`);
    }
    this.state = "connected";
    console.log(`${LOG_PREFIX} Claude backend client ready`);
  }

  async stop(): Promise<void> {
    this.state = "disconnected";
  }

  getState(): ConnectionState {
    return this.state;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.cachedModels ?? CLAUDE_MODELS;
  }

  async createSession(config: SessionConfig): Promise<BackendSession> {
    const options = this.toQueryOptions(config);
    return new ClaudeBackendSession(options);
  }

  async resumeSession(
    sessionId: string,
    config: SessionConfig,
  ): Promise<BackendSession> {
    const options = this.toQueryOptions(config);
    return new ClaudeBackendSession(options, sessionId);
  }

  private toQueryOptions(sessionConfig: SessionConfig): ClaudeQueryOptions {
    const opts: ClaudeQueryOptions = {
      model: sessionConfig.model,
      allowedTools: DEFAULT_ALLOWED_TOOLS,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 200,
      includePartialMessages: sessionConfig.streaming ?? true,
    };

    // If not using an explicit API key, strip any inherited ANTHROPIC_API_KEY
    // from the subprocess environment so the SDK uses CLI subscription auth.
    if (!this.useExplicitApiKey && process.env.ANTHROPIC_API_KEY) {
      const env = { ...process.env, ANTHROPIC_API_KEY: undefined };
      opts.env = env as Record<string, string | undefined>;
    }

    // Capture stderr for debugging
    opts.stderr = (data: string) => {
      const trimmed = data.trim();
      if (trimmed) console.error(`${LOG_PREFIX} [claude-sdk] ${trimmed}`);
    };

    // Opportunistic model cache — update when SDK reports available models
    opts.onModelsDiscovered = (models) => {
      this.cachedModels = models.map((m) => ({
        id: m.value,
        name: m.displayName || m.value,
        multiplier: -1,
        enabled: true,
      }));
      console.log(`${LOG_PREFIX} Cached ${this.cachedModels.length} models from Claude SDK`);
    };

    if (sessionConfig.systemMessage !== undefined) {
      opts.systemPrompt = sessionConfig.systemMessage;
    }
    if (sessionConfig.workingDirectory !== undefined) {
      opts.cwd = sessionConfig.workingDirectory;
    }
    if (sessionConfig.mcpServers !== undefined) {
      // Pass MCP configs through as-is — the Claude SDK accepts stdio, http, and sse types
      opts.mcpServers = sessionConfig.mcpServers as Record<string, any>;
    }

    return opts;
  }
}
