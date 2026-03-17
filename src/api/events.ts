export const API_EVENT_SCHEMA_VERSION = 1 as const;

export type ApiEventName =
  | "session.connected"
  | "orchestrator.message.delta"
  | "orchestrator.message.complete"
  | "orchestrator.message.cancelled"
  | "transcript.entry"
  | "session.cleared"
  | "cron.job.created"
  | "cron.job.updated"
  | "cron.job.deleted"
  | "cron.execution.started"
  | "cron.execution.complete";

export type LegacyApiEventType = "connected" | "delta" | "message" | "cancelled" | "transcript" | "cleared" | "cron";

type ConnectedData = { connectionId: string };
type MessageData = { content: string };
type TranscriptData = { role: string; content: string; source: string };
type EmptyData = {};

export type ApiEventEnvelope<TData extends Record<string, unknown>> = {
  schemaVersion: typeof API_EVENT_SCHEMA_VERSION;
  eventName: ApiEventName;
  data: TData;
  type: LegacyApiEventType;
  emittedAt: string;
} & TData;

function withEnvelope<TData extends Record<string, unknown>>(
  eventName: ApiEventName,
  type: LegacyApiEventType,
  data: TData,
): ApiEventEnvelope<TData> {
  return {
    schemaVersion: API_EVENT_SCHEMA_VERSION,
    eventName,
    data,
    type,
    emittedAt: new Date().toISOString(),
    ...data,
  } as ApiEventEnvelope<TData>;
}

export function createConnectedEvent(connectionId: string): ApiEventEnvelope<ConnectedData> {
  return withEnvelope("session.connected", "connected", { connectionId });
}

export function createDeltaEvent(content: string): ApiEventEnvelope<MessageData> {
  return withEnvelope("orchestrator.message.delta", "delta", { content });
}

export function createCompleteEvent(
  content: string,
): ApiEventEnvelope<MessageData> {
  return withEnvelope("orchestrator.message.complete", "message", {
    content,
  });
}

export function createCancelledEvent(): ApiEventEnvelope<EmptyData> {
  return withEnvelope("orchestrator.message.cancelled", "cancelled", {});
}

export function createClearedEvent(): ApiEventEnvelope<EmptyData> {
  return withEnvelope("session.cleared", "cleared", {});
}

export function createTranscriptEvent(role: string, content: string, source: string): ApiEventEnvelope<TranscriptData> {
  return withEnvelope("transcript.entry", "transcript", { role, content, source });
}

type CronJobData = { job: Record<string, unknown> };
type CronExecutionData = { execution: Record<string, unknown> };

export function createCronJobEvent(
  eventName: "cron.job.created" | "cron.job.updated" | "cron.job.deleted",
  job: Record<string, unknown>,
): ApiEventEnvelope<CronJobData> {
  return withEnvelope(eventName, "cron", { job });
}

export function createCronExecutionEvent(
  eventName: "cron.execution.started" | "cron.execution.complete",
  execution: Record<string, unknown>,
): ApiEventEnvelope<CronExecutionData> {
  return withEnvelope(eventName, "cron", { execution });
}

export function encodeSseEvent(event: ApiEventEnvelope<Record<string, unknown>>): string {
  return `event: ${event.eventName}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function resolveLegacyEventType(value: unknown): LegacyApiEventType | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as { type?: unknown; eventName?: unknown };
  if (candidate.type === "connected" || candidate.type === "delta" || candidate.type === "message" || candidate.type === "cancelled") {
    return candidate.type;
  }

  switch (candidate.eventName) {
    case "session.connected":
      return "connected";
    case "orchestrator.message.delta":
      return "delta";
    case "orchestrator.message.complete":
      return "message";
    case "orchestrator.message.cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}
