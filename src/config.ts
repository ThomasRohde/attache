import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { readFileSync, writeFileSync } from "fs";
import { ATTACHE_ENV_PATH, ENV_PATH, ensureAttacheHome } from "./paths.js";

// Load Attache first, then cwd .env for dev compatibility.
// override: true ensures restarted daemons pick up .env changes
// (without it, dotenv skips vars already in process.env from the parent)
loadEnv({ path: ATTACHE_ENV_PATH, override: true });
loadEnv(); // also check cwd for backwards compat

function getEnvValue(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function parseStrictPositiveInteger(
  value: string | undefined,
  key: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${key} must be a positive integer, got: "${value}"`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer, got: "${value}"`);
  }

  return parsed;
}

const configSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  AUTHORIZED_USER_ID: z.string().min(1).optional(),
  API_PORT: z.string().optional(),
  COPILOT_MODEL: z.string().optional(),
  WORKER_TIMEOUT: z.string().optional(),
  ASSISTANT_DISPLAY_NAME: z.string().min(1).optional(),
  SELF_EDIT_ENABLED: z.string().optional(),
  PREVENT_SLEEP: z.string().optional(),
  ATTACHE_WORKFOLDER: z.string().min(1).optional(),
  ATTACHE_BACKEND: z.enum(["copilot", "claude", "codex"]).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
});

const raw = configSchema.parse({
  TELEGRAM_BOT_TOKEN: getEnvValue("TELEGRAM_BOT_TOKEN"),
  AUTHORIZED_USER_ID: getEnvValue("AUTHORIZED_USER_ID"),
  API_PORT: getEnvValue("API_PORT"),
  COPILOT_MODEL: getEnvValue("COPILOT_MODEL"),
  WORKER_TIMEOUT: getEnvValue("WORKER_TIMEOUT"),
  ASSISTANT_DISPLAY_NAME: getEnvValue("ASSISTANT_DISPLAY_NAME"),
  SELF_EDIT_ENABLED: getEnvValue("ATTACHE_SELF_EDIT"),
  PREVENT_SLEEP: getEnvValue("ATTACHE_PREVENT_SLEEP"),
  ATTACHE_WORKFOLDER: getEnvValue("ATTACHE_WORKFOLDER"),
  ATTACHE_BACKEND: getEnvValue("ATTACHE_BACKEND") as "copilot" | "claude" | "codex" | undefined,
  ANTHROPIC_API_KEY: getEnvValue("ANTHROPIC_API_KEY"),
  OPENAI_API_KEY: getEnvValue("OPENAI_API_KEY"),
});

const parsedUserId = parseStrictPositiveInteger(raw.AUTHORIZED_USER_ID, "AUTHORIZED_USER_ID");
const parsedPort = parseStrictPositiveInteger(raw.API_PORT || "7777", "API_PORT");
const parsedDisplayName = raw.ASSISTANT_DISPLAY_NAME?.trim() || undefined;

if (parsedPort === undefined || parsedPort < 1 || parsedPort > 65535) {
  throw new Error(`API_PORT must be 1-65535, got: "${raw.API_PORT}"`);
}

const DEFAULT_WORKER_TIMEOUT_MS = 600_000; // 10 minutes
const parsedWorkerTimeout = raw.WORKER_TIMEOUT
  ? Number(raw.WORKER_TIMEOUT)
  : DEFAULT_WORKER_TIMEOUT_MS;

if (!Number.isInteger(parsedWorkerTimeout) || parsedWorkerTimeout <= 0) {
  throw new Error(`WORKER_TIMEOUT must be a positive integer (ms), got: "${raw.WORKER_TIMEOUT}"`);
}
if (raw.ASSISTANT_DISPLAY_NAME !== undefined && !parsedDisplayName) {
  throw new Error("ASSISTANT_DISPLAY_NAME must not be blank");
}

export const DEFAULT_MODEL = "claude-sonnet-4.6";
export const DEFAULT_ASSISTANT_DISPLAY_NAME = "Attache";

let _copilotModel = raw.COPILOT_MODEL || DEFAULT_MODEL;
let _workerTimeoutMs = parsedWorkerTimeout;
let _assistantDisplayName = parsedDisplayName;

export const config = {
  telegramBotToken: raw.TELEGRAM_BOT_TOKEN,
  authorizedUserId: parsedUserId,
  apiPort: parsedPort,
  get workerTimeoutMs(): number {
    return _workerTimeoutMs;
  },
  set workerTimeoutMs(timeoutMs: number) {
    _workerTimeoutMs = timeoutMs;
  },
  get assistantDisplayName(): string | undefined {
    return _assistantDisplayName;
  },
  set assistantDisplayName(name: string | undefined) {
    _assistantDisplayName = name?.trim() || undefined;
  },
  get assistantLabel(): string {
    return this.assistantDisplayName || DEFAULT_ASSISTANT_DISPLAY_NAME;
  },
  get copilotModel(): string {
    return _copilotModel;
  },
  set copilotModel(model: string) {
    _copilotModel = model;
  },
  get telegramEnabled(): boolean {
    return !!this.telegramBotToken && this.authorizedUserId !== undefined;
  },
  get selfEditEnabled(): boolean {
    return raw.SELF_EDIT_ENABLED === "1";
  },
  get preventSleep(): boolean {
    return raw.PREVENT_SLEEP === "1";
  },
  get workfolder(): string | undefined {
    return raw.ATTACHE_WORKFOLDER || undefined;
  },
  get backend(): string {
    return raw.ATTACHE_BACKEND || "copilot";
  },
  get anthropicApiKey(): string | undefined {
    return raw.ANTHROPIC_API_KEY;
  },
  get openaiApiKey(): string | undefined {
    return raw.OPENAI_API_KEY;
  },
};

function serializeEnvValue(value: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : JSON.stringify(value);
}

/** Update or append an env var in the active Attache .env file. */
export function persistEnvVar(key: string, value: string): void {
  ensureAttacheHome();
  try {
    const content = readFileSync(ENV_PATH, "utf-8");
    const lines = content.split("\n");
    let found = false;
    const updated = lines.map((line) => {
      if (line.startsWith(`${key}=`)) {
        found = true;
        return `${key}=${serializeEnvValue(value)}`;
      }
      return line;
    });
    if (!found) updated.push(`${key}=${serializeEnvValue(value)}`);
    writeFileSync(ENV_PATH, updated.join("\n"));
  } catch {
    // File doesn't exist — create it
    writeFileSync(ENV_PATH, `${key}=${serializeEnvValue(value)}\n`);
  }
}

/** Persist the current model choice to the active Attache .env. */
export function persistModel(model: string): void {
  persistEnvVar("COPILOT_MODEL", model);
}

export type ConfigUpdateKey =
  | "TELEGRAM_BOT_TOKEN"
  | "AUTHORIZED_USER_ID"
  | "API_PORT"
  | "COPILOT_MODEL"
  | "WORKER_TIMEOUT"
  | "ASSISTANT_DISPLAY_NAME"
  | "ATTACHE_WORKFOLDER"
  | "ATTACHE_BACKEND"
  | "ANTHROPIC_API_KEY"
  | "OPENAI_API_KEY";

export interface PreparedConfigUpdate {
  key: ConfigUpdateKey;
  persistedValue: string;
  restartRequired: boolean;
  apply(): Promise<void> | void;
}

function normalizeNonEmptyString(value: string, key: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${key} must not be blank`);
  }
  return trimmed;
}

function parseWorkerTimeout(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`WORKER_TIMEOUT must be a positive integer (ms), got: "${value}"`);
  }
  return parsed;
}

/**
 * Validate a config change before persisting it.
 *
 * `restartRequired` is true when the current process cannot safely apply the
 * change immediately and the caller should restart the daemon after persisting.
 */
export function prepareConfigUpdate(key: ConfigUpdateKey, value: string): PreparedConfigUpdate {
  switch (key) {
    case "ASSISTANT_DISPLAY_NAME": {
      const displayName = normalizeNonEmptyString(value, key);
      return {
        key,
        persistedValue: displayName,
        restartRequired: false,
        apply: () => {
          config.assistantDisplayName = displayName;
        },
      };
    }

    case "WORKER_TIMEOUT": {
      const timeoutMs = parseWorkerTimeout(value);
      return {
        key,
        persistedValue: String(timeoutMs),
        restartRequired: false,
        apply: () => {
          config.workerTimeoutMs = timeoutMs;
        },
      };
    }

    case "COPILOT_MODEL": {
      const modelId = normalizeNonEmptyString(value, key);
      return {
        key,
        persistedValue: modelId,
        restartRequired: false,
        apply: async () => {
          config.copilotModel = modelId;
          const { resetForModelSwitch } = await import("./copilot/orchestrator.js");
          resetForModelSwitch();
        },
      };
    }

    case "AUTHORIZED_USER_ID": {
      const userId = parseStrictPositiveInteger(value, key);
      if (userId === undefined) {
        throw new Error(`${key} must be a positive integer`);
      }
      return {
        key,
        persistedValue: String(userId),
        restartRequired: true,
        apply: () => {},
      };
    }

    case "API_PORT": {
      const apiPort = parseStrictPositiveInteger(value, key);
      if (apiPort === undefined || apiPort < 1 || apiPort > 65535) {
        throw new Error(`API_PORT must be 1-65535, got: "${value}"`);
      }
      return {
        key,
        persistedValue: String(apiPort),
        restartRequired: true,
        apply: () => {},
      };
    }

    case "ATTACHE_BACKEND": {
      const backend = normalizeNonEmptyString(value, key);
      if (!["copilot", "claude", "codex"].includes(backend)) {
        throw new Error(`Unknown backend '${backend}'. Supported: copilot, claude, codex`);
      }
      return {
        key,
        persistedValue: backend,
        restartRequired: true,
        apply: () => {},
      };
    }

    case "ATTACHE_WORKFOLDER": {
      const workfolder = normalizeNonEmptyString(value, key);
      return {
        key,
        persistedValue: workfolder,
        restartRequired: true,
        apply: () => {},
      };
    }

    case "TELEGRAM_BOT_TOKEN":
    case "ANTHROPIC_API_KEY":
    case "OPENAI_API_KEY": {
      const persistedValue = normalizeNonEmptyString(value, key);
      return {
        key,
        persistedValue,
        restartRequired: true,
        apply: () => {},
      };
    }
  }
}

export async function persistConfigUpdate(update: PreparedConfigUpdate): Promise<void> {
  persistEnvVar(update.key, update.persistedValue);
  await update.apply();
}

/** Validate and switch model. Returns previous model on success, or an error message. */
export async function validateAndSwitchModel(
  modelId: string,
  client: { capabilities: { modelListing: boolean }; listModels(): Promise<{ id: string; name: string }[]> },
): Promise<{ ok: true; previous: string } | { ok: false; error: string }> {
  try {
    if (client.capabilities.modelListing) {
      const models = await client.listModels();
      const match = models.find((m) => m.id === modelId);
      if (!match) {
        const suggestions = models
          .filter((m) => m.id.includes(modelId) || m.id.toLowerCase().includes(modelId.toLowerCase()))
          .map((m) => m.id);
        const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
        return { ok: false, error: `Model '${modelId}' not found.${hint}` };
      }
    }
  } catch {
    // If we can't validate (client not ready), allow the switch
  }
  const previous = config.copilotModel;
  config.copilotModel = modelId;
  persistModel(modelId);
  return { ok: true, previous };
}

/** Persist the assistant display name without affecting technical identity. */
export function persistAssistantDisplayName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Assistant display name must not be blank");
  }
  persistEnvVar("ASSISTANT_DISPLAY_NAME", trimmed);
  config.assistantDisplayName = trimmed;
}
