/**
 * ProjectorFactory — creates the right projector for a backend.
 */

import type { BackendProjector } from "../types.js";
import { CopilotProjector } from "./copilot.js";
import { ClaudeProjector } from "./claude.js";
import { CodexProjector } from "./codex.js";

export function createProjector(backendName: string): BackendProjector {
  switch (backendName) {
    case "copilot":
      return new CopilotProjector();
    case "claude":
      return new ClaudeProjector();
    case "codex":
      return new CodexProjector();
    default:
      throw new Error(`No projector for backend: ${backendName}`);
  }
}
