import type { CopilotSession } from "@github/copilot-sdk";
import type { BackendSession, SendResult, SessionEventName, SessionEvents, UnsubscribeFn } from "../../types.js";

/**
 * Wraps a CopilotSession to implement the abstract BackendSession interface.
 */
export class CopilotBackendSession implements BackendSession {
  readonly sessionId: string;

  constructor(private readonly session: CopilotSession) {
    this.sessionId = session.sessionId;
  }

  async sendAndWait(prompt: string, timeoutMs?: number): Promise<SendResult> {
    const result = await this.session.sendAndWait({ prompt }, timeoutMs);
    return { content: result?.data?.content || "" };
  }

  on<E extends SessionEventName>(
    event: E,
    handler: (data: SessionEvents[E]) => void,
  ): UnsubscribeFn {
    // Copilot SDK events wrap data in event.data — unwrap for the abstract interface
    return this.session.on(event, (sdkEvent: any) => {
      handler(sdkEvent.data);
    });
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  async destroy(): Promise<void> {
    await this.session.destroy();
  }
}
