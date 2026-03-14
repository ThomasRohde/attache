import * as http from "http";
import * as https from "https";
import { existsSync, readFileSync } from "fs";
import { API_TOKEN_PATH } from "../../paths.js";
import { getEffectiveIdentity, PRIMARY_RUNTIME_ENV } from "../../identity.js";
import { resolveLegacyEventType } from "../../api/events.js";
import type { RoutePayload } from "../../api/events.js";

export interface EffectiveConfigResponse {
  productName: string;
  assistantDisplayName: string;
  primaryCommand: string;
  apiBaseUrl?: string;
  currentModel?: string;
  telegramEnabled?: boolean;
}

export interface WorkerSummary {
  id: string;
  name: string;
  workingDir: string;
  status: "idle" | "running" | "error" | string;
  originChannel?: "telegram" | "tui" | string | null;
  startedAt?: number | null;
  elapsedMs?: number | null;
  lastOutput?: string | null;
  hasLastOutput?: boolean;
}

export interface DiagnosticsResponse {
  status: string;
  schemaVersion: number;
  api: {
    port: number;
    activeSseConnections: number;
  };
  process: {
    pid: number;
    uptimeSeconds: number;
    platform: string;
    nodeVersion: string;
    memoryUsage: Record<string, number>;
  };
  identity: {
    productName: string;
    assistantDisplayName: string;
  };
  routing: {
    currentModel: string;
    autoRouting: {
      enabled: boolean;
      tierModels?: Record<string, string>;
      cooldownMessages?: number;
    };
    lastRoute: RoutePayload | null;
  };
  workers: {
    count: number;
    running: number;
    items: WorkerSummary[];
  };
}

export interface StreamEventPayload {
  schemaVersion?: number;
  eventName?: string;
  type?: string;
  connectionId?: string;
  content?: string;
  route?: RoutePayload;
}

export interface ResolvedDaemonClientConfig {
  apiBase: string;
  token: string | null;
  identity: ReturnType<typeof getEffectiveIdentity>;
}

export interface OpenEventStreamHandlers {
  onConnected?: (connectionId: string) => void;
  onEvent?: (legacyType: "connected" | "delta" | "message" | "cancelled", event: StreamEventPayload) => void;
  onEnd?: () => void;
  onError?: (error: Error, retryable?: boolean) => void;
}

function readApiToken(): string | null {
  try {
    if (existsSync(API_TOKEN_PATH)) {
      return readFileSync(API_TOKEN_PATH, "utf-8").trim() || null;
    }
  } catch {
    return null;
  }

  return null;
}

export function resolveDaemonClientConfig(): ResolvedDaemonClientConfig {
  const identity = getEffectiveIdentity();
  const apiBase = process.env[PRIMARY_RUNTIME_ENV.apiUrl] || "http://127.0.0.1:7777";

  return {
    apiBase,
    token: readApiToken(),
    identity,
  };
}

function authHeaders(config: ResolvedDaemonClientConfig): Record<string, string> {
  return config.token ? { Authorization: `Bearer ${config.token}` } : {};
}

function getTransport(url: URL): typeof http | typeof https {
  return url.protocol === "https:" ? https : http;
}

function requestJson<T>(
  config: ResolvedDaemonClientConfig,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const url = new URL(path, config.apiBase);
    const payload = body ? JSON.stringify(body) : undefined;
    const transport = getTransport(url);

    const req = transport.request(
      url,
      {
        method,
        headers: {
          ...(payload ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload).toString(),
          } : {}),
          ...authHeaders(config),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          const ok = (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300;
          if (!ok) {
            reject(new Error(raw || `Request failed with status ${res.statusCode ?? "unknown"}`));
            return;
          }

          try {
            resolve((raw ? JSON.parse(raw) : {}) as T);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );

    req.on("error", (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });

    if (payload) {
      req.write(payload);
    }

    req.end();
  });
}

export function createDaemonClient(config = resolveDaemonClientConfig()) {
  return {
    config,
    getJson<T>(path: string): Promise<T> {
      return requestJson<T>(config, "GET", path);
    },
    postJson<T>(path: string, body?: Record<string, unknown>): Promise<T> {
      return requestJson<T>(config, "POST", path, body);
    },
    openEventStream(handlers: OpenEventStreamHandlers): { close: () => void } {
      const url = new URL("/stream", config.apiBase);
      let response: http.IncomingMessage | undefined;
      const transport = getTransport(url);

      const req = transport.get(url, { headers: authHeaders(config) }, (res) => {
        response = res;
        const ok = (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300;
        if (!ok) {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            raw += chunk;
          });
          res.on("end", () => {
            const retryable = res.statusCode !== 401 && res.statusCode !== 403;
            const detail = raw.trim() || `status ${res.statusCode ?? "unknown"}`;
            handlers.onError?.(
              new Error(`SSE request failed: ${detail}`),
              retryable,
            );
          });
          return;
        }

        let buffer = "";
        res.setEncoding("utf8");

        res.on("data", (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) {
              continue;
            }

            try {
              const event = JSON.parse(line.slice(6)) as StreamEventPayload;
              const legacyType = resolveLegacyEventType(event);
              if (!legacyType) {
                continue;
              }

              handlers.onEvent?.(legacyType, event);
              if (legacyType === "connected" && typeof event.connectionId === "string") {
                handlers.onConnected?.(event.connectionId);
              }
            } catch (error) {
              handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
            }
          }
        });

        res.on("end", () => {
          handlers.onEnd?.();
        });

        res.on("error", (error) => {
          handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
      });

      req.on("error", (error) => {
        handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
      });

      return {
        close() {
          response?.destroy();
          req.destroy();
        },
      };
    },
  };
}
