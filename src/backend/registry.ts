import type { BackendClient, ModelInfo } from "./types.js";
import { CopilotBackendClient } from "./providers/copilot/index.js";
import { ClaudeBackendClient } from "./providers/claude/index.js";
import { CodexBackendClient } from "./providers/codex/index.js";
import { COPILOT_MODELS } from "./providers/copilot/models.js";
import { CLAUDE_MODELS } from "./providers/claude/models.js";
import { CODEX_MODELS } from "./providers/codex/models.js";

// ---------------------------------------------------------------------------
// Singleton backend client
// ---------------------------------------------------------------------------

let backendClient: BackendClient | undefined;
let backendName: string = "copilot";

/**
 * Initialize and return the backend client for the given backend name.
 * If already initialized, returns the existing instance.
 */
export async function initBackendClient(name?: string): Promise<BackendClient> {
  if (backendClient) return backendClient;

  backendName = name || "copilot";

  switch (backendName) {
    case "copilot":
      backendClient = new CopilotBackendClient();
      break;
    case "claude":
      backendClient = new ClaudeBackendClient();
      break;
    case "codex":
      backendClient = new CodexBackendClient();
      break;
    default:
      throw new Error(`Unknown backend: '${backendName}'. Supported: copilot, claude, codex`);
  }

  await backendClient.start();
  return backendClient;
}

/**
 * Get the currently initialized backend client.
 * Throws if not yet initialized via initBackendClient().
 */
export function getBackendClient(): BackendClient {
  if (!backendClient) {
    throw new Error("Backend client not initialized — call initBackendClient() first");
  }
  return backendClient;
}

/** Get the name of the active backend. */
export function getBackendName(): string {
  return backendName;
}

/** Get hardcoded models for any provider (used when that provider isn't the active backend). */
export function getStaticModels(provider: string): ModelInfo[] {
  switch (provider) {
    case "copilot": return COPILOT_MODELS;
    case "claude":  return CLAUDE_MODELS;
    case "codex":   return CODEX_MODELS;
    default:        return [];
  }
}

/** Get the default (first) model ID for a given provider. */
export function getDefaultModelForProvider(provider: string): string | undefined {
  const models = getStaticModels(provider);
  return models.length > 0 ? models[0].id : undefined;
}

/** Stop the backend client and clear the singleton. */
export async function stopBackendClient(): Promise<void> {
  if (backendClient) {
    await backendClient.stop();
    backendClient = undefined;
  }
}

/**
 * Reset the backend client (e.g. after connection loss).
 * For Copilot, tears down and restarts the underlying SDK client.
 */
export async function resetBackendClient(): Promise<BackendClient> {
  if (backendClient) {
    if ("reset" in backendClient && typeof (backendClient as any).reset === "function") {
      await (backendClient as any).reset();
    } else {
      await backendClient.stop();
      backendClient = undefined;
      return initBackendClient(backendName);
    }
  }
  return initBackendClient(backendName);
}
