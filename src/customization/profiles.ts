/**
 * Profile loading — reads named profile YAML files from ~/.attache/profiles/
 * and optionally from <gitRoot>/.attache/profiles/.
 *
 * Profiles select subsets of skills, MCP servers, and instructions
 * for different contexts (e.g., work vs personal, orchestrator vs worker).
 *
 * When a workingDirectory is provided, repo-scoped profiles take precedence
 * over user-scoped profiles (repo > user).
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { ATTACHE_PROFILES_DIR } from "../paths.js";
import type { Profile } from "./types.js";

/**
 * Walk up from `dir` looking for a `.git/` directory or file.
 * Returns the git root path, or undefined if none found.
 */
function findGitRoot(dir: string): string | undefined {
  let current = resolve(dir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Load a profile by name. Scans user profiles (~/.attache/profiles/) first,
 * then repo-scoped profiles (<gitRoot>/.attache/profiles/) if a workingDirectory
 * is provided. Repo scope wins if both exist (higher precedence).
 */
export function loadProfile(name: string, workingDirectory?: string): Profile | undefined {
  // Start with user-scope profile
  let result: Profile | undefined;
  for (const ext of [".yaml", ".yml"]) {
    const filePath = join(ATTACHE_PROFILES_DIR, `${name}${ext}`);
    try {
      const content = readFileSync(filePath, "utf-8");
      result = parseProfile(content, name);
      break;
    } catch {
      // File not found — try next extension
    }
  }

  // Check repo-scoped profiles (higher precedence — overrides user if found)
  if (workingDirectory) {
    const gitRoot = findGitRoot(workingDirectory);
    if (gitRoot) {
      const repoProfilesDir = join(gitRoot, ".attache", "profiles");
      for (const ext of [".yaml", ".yml"]) {
        const filePath = join(repoProfilesDir, `${name}${ext}`);
        try {
          const content = readFileSync(filePath, "utf-8");
          result = parseProfile(content, name);
          break;
        } catch {
          // File not found — try next extension
        }
      }
    }
  }

  return result;
}

/** List all available profiles from ~/.attache/profiles/. */
export function listProfiles(): Profile[] {
  try {
    const entries = readdirSync(ATTACHE_PROFILES_DIR);
    const profiles: Profile[] = [];
    for (const entry of entries) {
      if (!/\.(yaml|yml)$/i.test(entry)) continue;
      const name = entry.replace(/\.(yaml|yml)$/i, "");
      try {
        const content = readFileSync(join(ATTACHE_PROFILES_DIR, entry), "utf-8");
        profiles.push(parseProfile(content, name));
      } catch {
        // Skip unparseable profiles
      }
    }
    return profiles;
  } catch {
    return [];
  }
}

/**
 * Simple YAML parser for profile files.
 * Supports the flat profile structure with nested include/exclude arrays.
 */
function parseProfile(content: string, fallbackName: string): Profile {
  const profile: Profile = { name: fallbackName };
  const lines = content.split(/\r?\n/);

  let currentSection: string | undefined;
  let currentSubSection: string | undefined;

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Skip comments and blank lines
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Top-level key: "name:", "description:", "skills:", "mcp:", "instructions:"
    const topMatch = trimmed.match(/^(\w+):\s*(.*)/);
    if (topMatch) {
      const [, key, value] = topMatch;
      const v = value.trim();

      if (key === "name" && v) {
        profile.name = v;
        currentSection = undefined;
        currentSubSection = undefined;
      } else if (key === "description" && v) {
        profile.description = v;
        currentSection = undefined;
        currentSubSection = undefined;
      } else if (key === "skills" || key === "mcp" || key === "instructions") {
        currentSection = key;
        currentSubSection = undefined;
      } else {
        currentSection = undefined;
        currentSubSection = undefined;
      }
      continue;
    }

    // Sub-key (indented): "  include:", "  exclude:", "  include_tags:", "  exclude_tags:"
    const subMatch = trimmed.match(/^\s+([\w_]+):\s*(.*)/);
    if (subMatch && currentSection) {
      const [, key, value] = subMatch;
      currentSubSection = key;
      // Inline array: include: ["a", "b"]
      const inlineArray = parseInlineArray(value.trim());
      if (inlineArray) {
        setProfileValue(profile, currentSection, key, inlineArray);
        currentSubSection = undefined;
      }
      continue;
    }

    // Array item (indented): "    - value"
    const itemMatch = trimmed.match(/^\s+-\s+(.*)/);
    if (itemMatch && currentSection && currentSubSection) {
      const value = itemMatch[1].trim().replace(/^["']|["']$/g, "");
      appendProfileValue(profile, currentSection, currentSubSection, value);
    }
  }

  return profile;
}

function parseInlineArray(value: string): string[] | undefined {
  if (!value.startsWith("[") || !value.endsWith("]")) return undefined;
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
}

function setProfileValue(profile: Profile, section: string, key: string, values: string[]): void {
  if (section === "skills") {
    if (!profile.skills) profile.skills = {};
    if (key === "include") profile.skills.include = values;
    else if (key === "exclude") profile.skills.exclude = values;
  } else if (section === "mcp") {
    if (!profile.mcp) profile.mcp = {};
    if (key === "include") profile.mcp.include = values;
    else if (key === "exclude") profile.mcp.exclude = values;
  } else if (section === "instructions") {
    if (!profile.instructions) profile.instructions = {};
    if (key === "include_tags") profile.instructions.include_tags = values;
    else if (key === "exclude_tags") profile.instructions.exclude_tags = values;
  }
}

function appendProfileValue(profile: Profile, section: string, key: string, value: string): void {
  if (section === "skills") {
    if (!profile.skills) profile.skills = {};
    if (key === "include") (profile.skills.include ??= []).push(value);
    else if (key === "exclude") (profile.skills.exclude ??= []).push(value);
  } else if (section === "mcp") {
    if (!profile.mcp) profile.mcp = {};
    if (key === "include") (profile.mcp.include ??= []).push(value);
    else if (key === "exclude") (profile.mcp.exclude ??= []).push(value);
  } else if (section === "instructions") {
    if (!profile.instructions) profile.instructions = {};
    if (key === "include_tags") (profile.instructions.include_tags ??= []).push(value);
    else if (key === "exclude_tags") (profile.instructions.exclude_tags ??= []).push(value);
  }
}
