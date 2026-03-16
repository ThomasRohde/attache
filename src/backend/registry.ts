import type { BackendClient } from "./types.js";
import { CopilotBackendClient } from "./providers/copilot/index.js";
import { ClaudeBackendClient } from "./providers/claude/index.js";

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
    // Phase 4: codex
    default:
      throw new Error(`Unknown backend: '${backendName}'. Supported: copilot, claude`);
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
