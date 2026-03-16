import type { BackendClient, BackendTierDefaults } from "./types.js";
import { CopilotBackendClient } from "./providers/copilot/index.js";

// ---------------------------------------------------------------------------
// Tier defaults per backend
// ---------------------------------------------------------------------------

const TIER_DEFAULTS: Record<string, BackendTierDefaults> = {
  copilot: {
    fast: "gpt-4.1",
    standard: "claude-sonnet-4.6",
    premium: "claude-opus-4.6",
    classifier: "gpt-4.1",
  },
  claude: {
    fast: "claude-haiku-4-5-20251001",
    standard: "claude-sonnet-4-6",
    premium: "claude-opus-4-6",
    classifier: "claude-haiku-4-5-20251001",
  },
  codex: {
    fast: "gpt-5.3-codex-spark",
    standard: "gpt-5.3-codex",
    premium: "gpt-5.4",
    classifier: "gpt-5.3-codex-spark",
  },
};

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
    // Phase 3: claude
    // Phase 4: codex
    default:
      throw new Error(`Unknown backend: '${backendName}'. Supported: copilot`);
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

/** Get tier defaults for the active backend. */
export function getTierDefaults(): BackendTierDefaults {
  return TIER_DEFAULTS[backendName] || TIER_DEFAULTS.copilot;
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
