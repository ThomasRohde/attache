/**
 * CodexProjector — maps an EffectiveBundle to Codex SessionConfig.
 *
 * Codex uses baseInstructions/developerInstructions via thread/start RPC,
 * dynamicTools for custom tools, and native skill scanning from ~/.agents/skills/.
 */

import { join } from "path";
import { homedir } from "os";
import type { BackendProjector, EffectiveBundle, ProjectedConfig, ResolutionContext } from "../types.js";
import type { SessionConfig } from "../../backend/types.js";
import { getAttacheAppendInstructions } from "../../copilot/system-message.js";
import { syncSkillsToDirectory } from "../skill-sync.js";

const AGENTS_SKILLS_DIR = join(homedir(), ".agents", "skills");

export class CodexProjector implements BackendProjector {
  async project(bundle: EffectiveBundle, context: ResolutionContext): Promise<ProjectedConfig> {
    const isOrchestrator = context.role === "orchestrator";

    const sessionConfig: Partial<SessionConfig> = {
      mcpServers: bundle.mcpServers,
    };

    if (isOrchestrator) {
      // Codex uses appendInstructions which maps to baseInstructions in thread/start
      sessionConfig.appendInstructions = getAttacheAppendInstructions(
        context.memorySummary,
        {
          backendName: context.backendName,
          includeToolDocs: context.backendCapabilities.customTools,
        },
      );
    }

    // Sync skills to ~/.agents/skills/ for native Codex discovery
    const sideEffects = async () => {
      if (bundle.skills.length > 0) {
        await syncSkillsToDirectory(bundle.skills, AGENTS_SKILLS_DIR);
      }
    };

    return { sessionConfig, sideEffects };
  }
}
