import { config, DEFAULT_ASSISTANT_DISPLAY_NAME } from "./config.js";
import { PRIMARY_COMMAND, PRODUCT_NAME } from "./update.js";

export const TECHNICAL_PRODUCT_NAME = PRODUCT_NAME;
export const LOG_PREFIX = `[${PRODUCT_NAME.toLowerCase()}]`;

export const PRIMARY_RUNTIME_ENV = {
  apiUrl: "ATTACHE_API_URL",
  tuiDebug: "ATTACHE_TUI_DEBUG",
  restarted: "ATTACHE_RESTARTED",
} as const;

export function resolveAssistantDisplayName(name?: string): string {
  const trimmed = name?.trim();
  return trimmed || DEFAULT_ASSISTANT_DISPLAY_NAME;
}

export function getEffectiveIdentity(opts?: { assistantDisplayName?: string }) {
  const assistantDisplayName = resolveAssistantDisplayName(
    opts?.assistantDisplayName ?? config.assistantDisplayName,
  );

  return {
    productName: TECHNICAL_PRODUCT_NAME,
    assistantDisplayName,
    primaryCommand: PRIMARY_COMMAND,
    logPrefix: LOG_PREFIX,
    env: {
      apiUrl: PRIMARY_RUNTIME_ENV.apiUrl,
      tuiDebug: PRIMARY_RUNTIME_ENV.tuiDebug,
      restarted: PRIMARY_RUNTIME_ENV.restarted,
    },
  };
}

export function formatAssistantHandle(name?: string): string {
  const assistantDisplayName = resolveAssistantDisplayName(name);
  return assistantDisplayName === TECHNICAL_PRODUCT_NAME
    ? TECHNICAL_PRODUCT_NAME
    : `${TECHNICAL_PRODUCT_NAME} · ${assistantDisplayName}`;
}
