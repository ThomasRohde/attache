import { initBackendClient, getBackendClient, stopBackendClient, resetBackendClient } from "../backend/registry.js";
import type { BackendClient } from "../backend/types.js";

/**
 * Get the backend client, initializing if needed.
 * This delegates to the backend registry instead of directly using CopilotClient.
 */
export async function getClient(): Promise<BackendClient> {
  return initBackendClient();
}

/** Tear down the existing client and create a fresh one. */
export async function resetClient(): Promise<BackendClient> {
  return resetBackendClient();
}

export async function stopClient(): Promise<void> {
  await stopBackendClient();
}
