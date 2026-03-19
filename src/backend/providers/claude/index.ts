import type {
  BackendClient,
  BackendCapabilities,
  BackendSession,
  ConnectionState,
  ModelInfo,
  SessionConfig,
} from "../../types.js";
import { ClaudeBackendSession, type ClaudeQueryOptions } from "./session.js";
import { bridgeToolsForClaude } from "./tool-bridge.js";
import { CLAUDE_MODELS } from "./models.js";
import { LOG_PREFIX } from "../../../identity.js";
import { ATTACHE_ENV_PATH } from "../../../paths.js";
import { readFileSync } from "fs";

/** Map Claude Code SDK shorthand aliases to full API model IDs. */
const CLAUDE_ALIAS_MAP: Record<string, string> = {
  "sonnet": "claude-sonnet-4-6",
  "opus": "claude-opus-4-6",
  "haiku": "claude-haiku-4-5-20251001",
  "sonnet[1m]": "claude-sonnet-4-6",     // 1M context variant uses same model ID
  "opus[1m]": "claude-opus-4-6",         // 1M context variant uses same model ID
};

const DEFAULT_ALLOWED_TOOLS = [
  "Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "Skill",
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
    customTools: true,        // Via createSdkMcpServer in-process MCP tools
    sessionResume: true,
    infiniteSessions: false,
    persistentClient: false,
    modelListing: true,
    skillDirectories: true,   // SDK supports via settingSources
    structuredOutput: false,
    machineSessionDiscovery: false,
    vision: true,             // SDK supports image reading
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
    // Security model: Attache is a personal daemon running as the local user.
    // Permissions are bypassed because the bearer-token-authenticated API
    // surface is the trust boundary, not individual tool invocations.
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

    // Opportunistic model cache — update when SDK reports available models.
    // The SDK returns shorthand aliases (e.g. "sonnet", "haiku", "sonnet[1m]")
    // which work internally but confuse users and cause issues when persisted.
    // We map known aliases to full API model IDs and skip unknown ones.
    opts.onModelsDiscovered = (models) => {
      const mapped: typeof this.cachedModels & {} = [];
      for (const m of models) {
        const fullId = CLAUDE_ALIAS_MAP[m.value];
        if (fullId) {
          mapped.push({
            id: fullId,
            name: m.displayName || fullId,
            multiplier: -1,
            enabled: true,
          });
        }
        // Skip aliases we can't map — they'd cause confusing model IDs
      }
      // Ensure static fallback models are always included
      for (const fallback of CLAUDE_MODELS) {
        if (!mapped.some((c) => c.id === fallback.id)) {
          mapped.push(fallback);
        }
      }
      this.cachedModels = mapped;
      console.log(`${LOG_PREFIX} Cached ${this.cachedModels.length} models from Claude SDK`);
    };

    opts.settingSources = ['user', 'project'];

    if (sessionConfig.appendInstructions !== undefined) {
      opts.systemPrompt = {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: sessionConfig.appendInstructions,
      };
    } else if (sessionConfig.systemMessage !== undefined) {
      opts.systemPrompt = sessionConfig.systemMessage;
    }
    if (sessionConfig.workingDirectory !== undefined) {
      opts.cwd = sessionConfig.workingDirectory;
    }

    // Start with any configured MCP servers
    const mcpServers: Record<string, any> = sessionConfig.mcpServers
      ? { ...(sessionConfig.mcpServers as Record<string, any>) }
      : {};

    // Bridge Copilot SDK tools into an in-process MCP server
    if (sessionConfig.tools?.length) {
      try {
        const { mcpServer, allowedToolNames } = bridgeToolsForClaude(
          sessionConfig.tools as import("../copilot/tool-bridge.js").Tool<any>[],
        );
        mcpServers[mcpServer.name] = mcpServer;
        opts.allowedTools = [...opts.allowedTools, ...allowedToolNames];
        console.log(`${LOG_PREFIX} Bridged ${allowedToolNames.length} tools to Claude MCP server '${mcpServer.name}'`);
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to bridge tools to Claude MCP: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (Object.keys(mcpServers).length > 0) {
      opts.mcpServers = mcpServers;
    }

    return opts;
  }
}
