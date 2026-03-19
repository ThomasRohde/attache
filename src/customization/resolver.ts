/**
 * CustomizationResolver — scans scopes, deduplicates, applies profiles,
 * and produces an EffectiveBundle.
 *
 * This wraps the existing skills, MCP, and tool functions to provide a
 * single entrypoint for customization resolution.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { listSkills, readSkill } from "../copilot/skills.js";
import { loadMcpConfig } from "../copilot/mcp-config.js";
import { loadProfile } from "./profiles.js";
import type { McpServerConfig } from "../backend/types.js";
import type {
  CustomizationResolver,
  EffectiveBundle,
  Instruction,
  Profile,
  ResolutionContext,
  ResolvedSkill,
  Scope,
} from "./types.js";

/**
 * Walk up from `dir` looking for a `.git/` directory or file (worktrees use a file).
 * Returns the git root path, or undefined if none found.
 */
function findGitRoot(dir: string): string | undefined {
  let current = resolve(dir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined; // reached filesystem root
    current = parent;
  }
}

/**
 * Scan a directory for SKILL.md sub-directories and return ResolvedSkill entries.
 */
function scanSkillDirectory(dir: string, source: Scope): ResolvedSkill[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const skills: ResolvedSkill[] = [];
  for (const entry of entries) {
    const skillDir = join(dir, entry);
    const skillMd = join(skillDir, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    try {
      const raw = readFileSync(skillMd, "utf-8");
      const { name, description } = parseFrontmatterFields(raw);
      const content = stripFrontmatter(raw);
      skills.push({
        slug: entry,
        name: name || entry,
        description: description || "(no description)",
        content,
        source,
        directory: skillDir,
      });
    } catch {
      skills.push({
        slug: entry,
        name: entry,
        description: "(could not read SKILL.md)",
        content: "",
        source,
        directory: skillDir,
      });
    }
  }
  return skills;
}

/**
 * Parse name/description from YAML frontmatter.
 */
function parseFrontmatterFields(content: string): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: "", description: "" };
  let name = "";
  let description = "";
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(": ");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 2).trim();
    if (key === "name") name = value;
    if (key === "description") description = value;
  }
  return { name, description };
}

/**
 * Load an MCP config file (JSON with { mcpServers: { ... } } shape).
 * Returns an empty record on any failure.
 */
function loadMcpConfigFile(filePath: string): Record<string, McpServerConfig> {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
      return parsed.mcpServers as Record<string, McpServerConfig>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Parse instruction files from a directory.
 * Each file is named *.instructions.md and may contain YAML frontmatter with an `applyTo` glob.
 */
function scanInstructionDirectory(dir: string): Instruction[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const instructions: Instruction[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".instructions.md")) continue;
    const filePath = join(dir, entry);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const content = stripFrontmatter(raw);
      const applyTo = parseApplyTo(raw);
      const id = `repo:${entry.replace(/\.instructions\.md$/, "")}`;
      const tags: string[] = [];
      if (applyTo) tags.push(`applyTo:${applyTo}`);
      const scope: Scope = applyTo ? "path" : "repo";
      instructions.push({ id, content, scope, tags, source: filePath });
    } catch {
      // Skip unreadable instruction files
    }
  }
  return instructions;
}

/**
 * Extract the `applyTo` field from YAML frontmatter.
 */
function parseApplyTo(content: string): string | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return undefined;
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(": ");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 2).trim();
    if (key === "applyTo") return value.replace(/^["']|["']$/g, "");
  }
  return undefined;
}

/** Map the existing skill source names to our Scope type. */
function mapSkillSource(source: "bundled" | "local" | "global"): Scope {
  if (source === "local") return "user";
  return source;
}

/** Default resolver — wraps existing scanning functions. */
export class DefaultResolver implements CustomizationResolver {
  async resolve(context: ResolutionContext): Promise<EffectiveBundle> {
    // 1. Resolve skills
    const rawSkills = listSkills();
    const skillMap = new Map<string, ResolvedSkill>();

    // Process in precedence order: bundled first, then global, then user.
    // Higher precedence (later) overwrites lower.
    const precedenceOrder: Array<"bundled" | "local" | "global"> = ["bundled", "global", "local"];
    for (const source of precedenceOrder) {
      for (const skill of rawSkills.filter((s) => s.source === source)) {
        const read = readSkill(skill.slug);
        const content = read.ok && read.content ? stripFrontmatter(read.content) : "";
        skillMap.set(skill.slug, {
          slug: skill.slug,
          name: skill.name,
          description: skill.description,
          content,
          source: mapSkillSource(skill.source),
          directory: skill.directory,
        });
      }
    }

    // Repo scope: scan <gitRoot>/.attache/skills/ if a working directory is set
    const gitRoot = context.workingDirectory
      ? findGitRoot(context.workingDirectory)
      : undefined;

    if (gitRoot) {
      const repoSkillsDir = join(gitRoot, ".attache", "skills");
      for (const skill of scanSkillDirectory(repoSkillsDir, "repo")) {
        skillMap.set(skill.slug, skill);
      }
    }

    let skills = Array.from(skillMap.values());

    // 2. Resolve MCP servers
    const mcpRaw = loadMcpConfig();
    let mcpServers = { ...mcpRaw };

    // Merge repo-scoped MCP servers (repo overrides user/global)
    if (gitRoot) {
      const repoMcpPath = join(gitRoot, ".attache", "mcp.json");
      const repoMcp = loadMcpConfigFile(repoMcpPath);
      Object.assign(mcpServers, repoMcp);
    }

    // 3. Resolve tools (orchestrator only)
    // Tools are NOT resolved here — they're created by the orchestrator with
    // runtime dependencies (BackendClient, workers map, callbacks).
    // The resolver passes them through from the caller.
    const toolDefinitions: unknown[] = [];

    // 4. Build instructions
    const instructions: Instruction[] = [
      {
        id: "bundled:attache-system",
        content: "", // Actual content is generated by projectors using system-message.ts
        scope: "bundled" as Scope,
        source: "src/copilot/system-message.ts",
      },
    ];

    // Scan repo-scoped instruction files (<gitRoot>/.attache/instructions/*.instructions.md)
    if (gitRoot) {
      const instructionsDir = join(gitRoot, ".attache", "instructions");
      const repoInstructions = scanInstructionDirectory(instructionsDir);
      instructions.push(...repoInstructions);
    }

    // 5. Apply profile filtering
    let profile: Profile | undefined;
    if (context.profile) {
      profile = loadProfile(context.profile, context.workingDirectory);
      if (profile) {
        skills = filterSkills(skills, profile);
        mcpServers = filterMcpServers(mcpServers, profile);
      }
    }

    return {
      skills,
      instructions,
      mcpServers,
      toolDefinitions,
      profile,
      metadata: {
        role: context.role,
        backendName: context.backendName,
        resolvedAt: new Date(),
      },
    };
  }
}

/** Strip YAML frontmatter from SKILL.md content. */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

/** Filter skills based on profile include/exclude rules. */
function filterSkills(skills: ResolvedSkill[], profile: Profile): ResolvedSkill[] {
  if (!profile.skills) return skills;

  if (profile.skills.include?.length) {
    const allowed = new Set(profile.skills.include);
    return skills.filter((s) => allowed.has(s.slug));
  }
  if (profile.skills.exclude?.length) {
    const blocked = new Set(profile.skills.exclude);
    return skills.filter((s) => !blocked.has(s.slug));
  }

  return skills;
}

/** Filter MCP servers based on profile include/exclude rules. */
function filterMcpServers(
  servers: Record<string, any>,
  profile: Profile,
): Record<string, any> {
  if (!profile.mcp) return servers;

  if (profile.mcp.include?.length) {
    const allowed = new Set(profile.mcp.include);
    const filtered: Record<string, any> = {};
    for (const [name, config] of Object.entries(servers)) {
      if (allowed.has(name)) filtered[name] = config;
    }
    return filtered;
  }
  if (profile.mcp.exclude?.length) {
    const blocked = new Set(profile.mcp.exclude);
    const filtered: Record<string, any> = {};
    for (const [name, config] of Object.entries(servers)) {
      if (!blocked.has(name)) filtered[name] = config;
    }
    return filtered;
  }

  return servers;
}
