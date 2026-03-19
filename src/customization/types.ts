/**
 * Core types for the unified customization architecture.
 *
 * The customization system has four artifact types:
 * - Instructions: stable policy/conventions, always-on or scoped
 * - Skills: reusable workflow playbooks (SKILL.md)
 * - MCP bindings: tool/resource server connections
 * - Profiles: named bundles selecting subsets of the above
 */

import type { BackendCapabilities, McpServerConfig, SessionConfig } from "../backend/types.js";

/** Scope precedence: bundled < global < user < repo < path */
export type Scope = "bundled" | "global" | "user" | "repo" | "path";

export interface Instruction {
  id: string;
  content: string;
  scope: Scope;
  tags?: string[];
  source: string;
}

export interface ResolvedSkill {
  slug: string;
  name: string;
  description: string;
  content: string;
  source: Scope;
  directory: string;
}

export interface McpBinding {
  name: string;
  config: McpServerConfig;
  scope: Scope;
}

export interface Profile {
  name: string;
  description?: string;
  skills?: {
    include?: string[];
    exclude?: string[];
  };
  mcp?: {
    include?: string[];
    exclude?: string[];
  };
  instructions?: {
    include_tags?: string[];
    exclude_tags?: string[];
  };
}

export interface EffectiveBundle {
  skills: ResolvedSkill[];
  instructions: Instruction[];
  mcpServers: Record<string, McpServerConfig>;
  toolDefinitions: unknown[];
  profile?: Profile;
  metadata: {
    role: "orchestrator" | "worker";
    backendName: string;
    resolvedAt: Date;
  };
}

export interface ResolutionContext {
  role: "orchestrator" | "worker";
  workingDirectory?: string;
  profile?: string;
  backendName: string;
  backendCapabilities: BackendCapabilities;
  memorySummary?: string;
}

export interface CustomizationResolver {
  resolve(context: ResolutionContext): Promise<EffectiveBundle>;
}

export interface ProjectedConfig {
  sessionConfig: Partial<SessionConfig>;
  sideEffects?: () => Promise<void>;
}

export interface BackendProjector {
  project(bundle: EffectiveBundle, context: ResolutionContext): Promise<ProjectedConfig>;
}
