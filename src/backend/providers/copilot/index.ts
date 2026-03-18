import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type {
  BackendClient,
  BackendCapabilities,
  BackendSession,
  ConnectionState,
  ModelInfo,
  SessionConfig,
} from "../../types.js";
import { CopilotBackendSession } from "./session.js";

/**
 * Copilot SDK backend — wraps CopilotClient into the abstract BackendClient interface.
 */
export class CopilotBackendClient implements BackendClient {
  readonly name = "copilot";
  readonly capabilities: BackendCapabilities = {
    customTools: true,
    sessionResume: true,
    infiniteSessions: true,
    persistentClient: true,
    modelListing: true,
    skillDirectories: true,
    structuredOutput: false,
    machineSessionDiscovery: true,
    vision: true,
  };

  private client: CopilotClient | undefined;

  async start(): Promise<void> {
    if (!this.client) {
      this.client = new CopilotClient({
        autoStart: true,
        autoRestart: true,
      });
      await this.client.start();
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.stop();
      this.client = undefined;
    }
  }

  getState(): ConnectionState {
    if (!this.client) return "disconnected";
    const state = this.client.getState();
    // Map Copilot SDK states to our abstract states
    if (state === "connected") return "connected";
    if (state === "connecting") return "connecting";
    if (state === "error") return "error";
    return "disconnected";
  }

  async listModels(): Promise<ModelInfo[]> {
    const client = this.ensureClient();
    const models = await client.listModels();
    return models
      .filter((m: any) => m.policy?.state === "enabled" && !m.name?.includes("(Internal only)"))
      .map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        multiplier: m.billing?.multiplier ?? 0,
        enabled: true,
      }));
  }

  async createSession(config: SessionConfig): Promise<BackendSession> {
    const client = this.ensureClient();
    const sdkConfig = this.toSdkConfig(config);
    const session = await client.createSession(sdkConfig);
    return new CopilotBackendSession(session);
  }

  async resumeSession(sessionId: string, config: SessionConfig): Promise<BackendSession> {
    const client = this.ensureClient();
    const sdkConfig = this.toSdkConfig(config);
    const session = await client.resumeSession(sessionId, sdkConfig);
    return new CopilotBackendSession(session);
  }

  /** Reset the underlying client (e.g. after connection loss). */
  async reset(): Promise<void> {
    if (this.client) {
      try { await this.client.stop(); } catch { /* best-effort */ }
      this.client = undefined;
    }
    await this.start();
  }

  private ensureClient(): CopilotClient {
    if (!this.client) {
      throw new Error("CopilotBackendClient not started — call start() first");
    }
    return this.client;
  }

  private toSdkConfig(config: SessionConfig): Record<string, any> {
    // Security model: Attache is a personal daemon running as the local user.
    // All actions are auto-approved because the bearer-token-authenticated API
    // surface is the trust boundary, not individual tool invocations.
    const sdkConfig: Record<string, any> = {
      model: config.model,
      onPermissionRequest: approveAll,
    };

    if (config.systemMessage !== undefined) {
      sdkConfig.systemMessage = { mode: "replace", content: config.systemMessage };
    }
    if (config.streaming !== undefined) {
      sdkConfig.streaming = config.streaming;
    }
    if (config.workingDirectory !== undefined) {
      sdkConfig.workingDirectory = config.workingDirectory;
    }
    if (config.configDir !== undefined) {
      sdkConfig.configDir = config.configDir;
    }
    if (config.tools !== undefined) {
      sdkConfig.tools = config.tools;
    }
    if (config.mcpServers !== undefined) {
      sdkConfig.mcpServers = config.mcpServers;
    }
    if (config.skillDirectories !== undefined) {
      sdkConfig.skillDirectories = config.skillDirectories;
    }
    if (config.infiniteSessions !== undefined) {
      sdkConfig.infiniteSessions = config.infiniteSessions;
    }

    return sdkConfig;
  }
}
