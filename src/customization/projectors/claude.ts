/**
 * ClaudeProjector — maps an EffectiveBundle to Claude Agent SDK SessionConfig.
 *
 * Claude uses settingSources for native skill discovery, createSdkMcpServer
 * for custom tools, and preset+append for system messages. Skills may need
 * syncing to ~/.claude/skills/ for the SDK to discover them.
 */

import { join } from "path";
import { homedir } from "os";
import type { BackendProjector, EffectiveBundle, ProjectedConfig, ResolutionContext } from "../types.js";
import type { SessionConfig } from "../../backend/types.js";
import { getAttacheAppendInstructions } from "../../copilot/system-message.js";
import { syncSkillsToDirectory } from "../skill-sync.js";

const CLAUDE_SKILLS_DIR = join(homedir(), ".claude", "skills");

export class ClaudeProjector implements BackendProjector {
  async project(bundle: EffectiveBundle, context: ResolutionContext): Promise<ProjectedConfig> {
    const isOrchestrator = context.role === "orchestrator";

    const sessionConfig: Partial<SessionConfig> = {
      mcpServers: bundle.mcpServers,
    };

    if (isOrchestrator) {
      // Claude uses append mode — let the SDK provide its identity
      sessionConfig.appendInstructions = getAttacheAppendInstructions(
        context.memorySummary,
        {
          backendName: context.backendName,
          includeToolDocs: context.backendCapabilities.customTools,
        },
      );
    }

    // Skill directories are handled by settingSources in the Claude backend
    // but we need to sync skills so the SDK can discover them
    const sideEffects = async () => {
      if (bundle.skills.length > 0) {
        await syncSkillsToDirectory(bundle.skills, CLAUDE_SKILLS_DIR);
      }
    };

    return { sessionConfig, sideEffects };
  }
}
