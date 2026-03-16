/**
 * Re-exports Copilot SDK tool utilities for use by tools.ts.
 *
 * This indirection lets the rest of the codebase import tool helpers
 * from the backend layer rather than directly from @github/copilot-sdk.
 */
export { defineTool, approveAll } from "@github/copilot-sdk";
export type { Tool } from "@github/copilot-sdk";
