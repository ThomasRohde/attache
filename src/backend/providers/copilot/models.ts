import type { ModelInfo } from "../../types.js";

/**
 * Hardcoded fallback model list for the Copilot backend.
 * Used when the active backend is not Copilot (e.g. GUI settings showing models
 * for a provider the daemon isn't currently running). The live list from
 * CopilotClient.listModels() is preferred when available.
 */
export const COPILOT_MODELS: ModelInfo[] = [
  { id: "claude-opus-4.6",   name: "Claude Opus 4.6",   multiplier: 15, enabled: true },
  { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6",  multiplier: 3,  enabled: true },
  { id: "gpt-4.1",           name: "GPT-4.1",            multiplier: 1,  enabled: true },
  { id: "gpt-4.1-mini",      name: "GPT-4.1 Mini",       multiplier: 0.25, enabled: true },
  { id: "o3",                name: "o3",                  multiplier: 15, enabled: true },
  { id: "o4-mini",           name: "o4-mini",             multiplier: 1,  enabled: true },
  { id: "gemini-2.5-pro",    name: "Gemini 2.5 Pro",     multiplier: 3,  enabled: true },
];
