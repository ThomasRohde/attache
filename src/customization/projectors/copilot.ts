/**
 * CopilotProjector — maps an EffectiveBundle to Copilot SDK SessionConfig.
 *
 * Copilot supports native skillDirectories, mcpServers, tools, and
 * system message in append or replace mode. No skill syncing needed.
 */

import type { BackendProjector, EffectiveBundle, ProjectedConfig, ResolutionContext } from "../types.js";
import type { SessionConfig } from "../../backend/types.js";
import { getAttacheAppendInstructions, getOrchestratorSystemMessage } from "../../copilot/system-message.js";
import { getSkillContentForSystemMessage } from "../../copilot/skills.js";

export class CopilotProjector implements BackendProjector {
  async project(bundle: EffectiveBundle, context: ResolutionContext): Promise<ProjectedConfig> {
    const isOrchestrator = context.role === "orchestrator";

    // Collect unique skill directories
    const skillDirectories = [...new Set(bundle.skills.map((s) => {
      // Return the parent directory, not the skill's own directory
      const parts = s.directory.split(/[\\/]/);
      parts.pop();
      return parts.join("/");
    }))];

    const sessionConfig: Partial<SessionConfig> = {
      mcpServers: bundle.mcpServers,
      skillDirectories,
    };

    if (isOrchestrator) {
      // Copilot orchestrator uses full system message replacement
      // (the Copilot SDK's default prompt is minimal and doesn't conflict)
      sessionConfig.systemMessage = getOrchestratorSystemMessage(
        context.memorySummary,
        {
          selfEditEnabled: false, // Set by orchestrator at runtime
          backendName: context.backendName,
        },
      );
      sessionConfig.infiniteSessions = {
        enabled: true,
        backgroundCompactionThreshold: 0.80,
        bufferExhaustionThreshold: 0.95,
      };
    }

    return { sessionConfig };
  }
}
