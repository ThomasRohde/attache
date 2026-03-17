import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join, dirname, sep } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { SKILLS_DIR } from "../paths.js";

/** User-local skills directory (~/.attache/skills/) */
const LOCAL_SKILLS_DIR = SKILLS_DIR;

/** Global shared skills directory */
const GLOBAL_SKILLS_DIR = join(homedir(), ".agents", "skills");

/** Skills bundled with the Attache package (e.g. find-skills) */
const BUNDLED_SKILLS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills"
);

/** Returns all skill directories that exist on disk. */
export function getSkillDirectories(): string[] {
  const dirs: string[] = [];
  if (existsSync(BUNDLED_SKILLS_DIR)) dirs.push(BUNDLED_SKILLS_DIR);
  if (existsSync(LOCAL_SKILLS_DIR)) dirs.push(LOCAL_SKILLS_DIR);
  if (existsSync(GLOBAL_SKILLS_DIR)) dirs.push(GLOBAL_SKILLS_DIR);
  return dirs;
}

export interface SkillInfo {
  slug: string;
  name: string;
  description: string;
  directory: string;
  source: "bundled" | "local" | "global";
}

/** Scan all skill directories and return metadata for each skill found. */
export function listSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];

  for (const [dir, source] of [
    [BUNDLED_SKILLS_DIR, "bundled"] as const,
    [LOCAL_SKILLS_DIR, "local"] as const,
    [GLOBAL_SKILLS_DIR, "global"] as const,
  ]) {
    if (!existsSync(dir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const skillDir = join(dir, entry);
      const skillMd = join(skillDir, "SKILL.md");
      if (!existsSync(skillMd)) continue;

      try {
        const content = readFileSync(skillMd, "utf-8");
        const { name, description } = parseFrontmatter(content);
        skills.push({
          slug: entry,
          name: name || entry,
          description: description || "(no description)",
          directory: skillDir,
          source,
        });
      } catch {
        skills.push({
          slug: entry,
          name: entry,
          description: "(could not read SKILL.md)",
          directory: skillDir,
          source,
        });
      }
    }
  }

  return skills;
}

/** Create a new skill in the local skills directory. */
export function createSkill(slug: string, name: string, description: string, instructions: string): string {
  const skillDir = join(LOCAL_SKILLS_DIR, slug);
  // Guard against path traversal
  if (!skillDir.startsWith(LOCAL_SKILLS_DIR + sep)) {
    return `Invalid slug '${slug}': must be a simple kebab-case name without path separators.`;
  }
  if (existsSync(skillDir)) {
    return `Skill '${slug}' already exists at ${skillDir}. Edit it directly or delete it first.`;
  }

  mkdirSync(skillDir, { recursive: true });

  writeFileSync(
    join(skillDir, "_meta.json"),
    JSON.stringify({ slug, version: "1.0.0" }, null, 2) + "\n"
  );

  const skillMd = `---
name: ${name}
description: ${description}
---

${instructions}
`;
  writeFileSync(join(skillDir, "SKILL.md"), skillMd);

  return `Skill '${name}' created at ${skillDir}. It will be available on your next message.`;
}

/** Remove a skill from the local skills directory. */
export function removeSkill(slug: string): { ok: boolean; message: string } {
  const skillDir = join(LOCAL_SKILLS_DIR, slug);
  // Guard against path traversal
  if (!skillDir.startsWith(LOCAL_SKILLS_DIR + sep)) {
    return { ok: false, message: `Invalid slug '${slug}': must be a simple kebab-case name without path separators.` };
  }
  if (!existsSync(skillDir)) {
    return { ok: false, message: `Skill '${slug}' not found in ${LOCAL_SKILLS_DIR}.` };
  }

  rmSync(skillDir, { recursive: true, force: true });
  return { ok: true, message: `Skill '${slug}' removed from ${skillDir}. It will no longer be available on your next message.` };
}

const MAX_SKILL_CONTENT_LENGTH = 50_000;

/** Read a skill's SKILL.md content by slug, scanning all directories. */
export function readSkill(slug: string): { ok: boolean; content?: string; source?: "bundled" | "local" | "global"; message?: string } {
  for (const [dir, source] of [
    [BUNDLED_SKILLS_DIR, "bundled"] as const,
    [LOCAL_SKILLS_DIR, "local"] as const,
    [GLOBAL_SKILLS_DIR, "global"] as const,
  ]) {
    // Guard against path traversal
    const skillDir = join(dir, slug);
    if (!skillDir.startsWith(dir + sep)) {
      return { ok: false, message: `Invalid slug '${slug}'.` };
    }
    const skillMd = join(skillDir, "SKILL.md");
    if (existsSync(skillMd)) {
      try {
        const content = readFileSync(skillMd, "utf-8");
        return { ok: true, content, source };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `Failed to read skill '${slug}': ${msg}` };
      }
    }
  }
  return { ok: false, message: `Skill '${slug}' not found in any skills directory.` };
}

/** Update an existing skill in the local skills directory. Only local skills can be updated. */
export function updateSkill(
  slug: string,
  updates: { name?: string; description?: string; instructions: string },
): { ok: boolean; message: string } {
  const skillDir = join(LOCAL_SKILLS_DIR, slug);
  // Guard against path traversal
  if (!skillDir.startsWith(LOCAL_SKILLS_DIR + sep)) {
    return { ok: false, message: `Invalid slug '${slug}': must be a simple kebab-case name without path separators.` };
  }

  if (updates.instructions.length > MAX_SKILL_CONTENT_LENGTH) {
    return { ok: false, message: `Instructions too long (${updates.instructions.length} chars, max ${MAX_SKILL_CONTENT_LENGTH}).` };
  }

  // Check if skill exists in bundled or global (reject those)
  for (const [dir, source] of [
    [BUNDLED_SKILLS_DIR, "bundled"] as const,
    [GLOBAL_SKILLS_DIR, "global"] as const,
  ]) {
    if (existsSync(join(dir, slug, "SKILL.md"))) {
      return { ok: false, message: `Skill '${slug}' is a ${source} skill and cannot be modified. Only local skills (~/.attache/skills) can be updated.` };
    }
  }

  const skillMdPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    return { ok: false, message: `Skill '${slug}' not found in local skills directory (${LOCAL_SKILLS_DIR}).` };
  }

  // Read existing frontmatter to preserve name/description if not provided
  const existing = readFileSync(skillMdPath, "utf-8");
  const { name: existingName, description: existingDescription } = parseFrontmatter(existing);

  const name = updates.name || existingName || slug;
  const description = updates.description || existingDescription || "(no description)";

  const newContent = `---\nname: ${name}\ndescription: ${description}\n---\n\n${updates.instructions}\n`;
  writeFileSync(skillMdPath, newContent);

  // Update _meta.json with lastUpdated timestamp
  const metaPath = join(skillDir, "_meta.json");
  try {
    const meta = existsSync(metaPath)
      ? JSON.parse(readFileSync(metaPath, "utf-8"))
      : { slug };
    meta.lastUpdated = new Date().toISOString();
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  } catch {
    // Non-critical — skill was still updated
  }

  return { ok: true, message: `Skill '${name}' (${slug}) updated successfully.` };
}

/** Parse YAML frontmatter from a SKILL.md file. */
function parseFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: "", description: "" };

  const frontmatter = match[1];
  let name = "";
  let description = "";

  for (const line of frontmatter.split("\n")) {
    const idx = line.indexOf(": ");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 2).trim();
    if (key === "name") name = value;
    if (key === "description") description = value;
  }

  return { name, description };
}
