/**
 * Skill syncing — copies resolved skills to backend-specific discovery directories.
 *
 * Backends like Claude and Codex discover skills from fixed filesystem locations.
 * This module copies Attache's resolved skills into those directories so they're
 * picked up natively, with manifest tracking to avoid touching user-created skills.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import type { ResolvedSkill } from "./types.js";

interface SyncManifest {
  syncedBy: "attache";
  skills: Record<string, { source: string; hash: string }>;
}

const MANIFEST_FILE = "_attache-synced.json";

/** Sync resolved skills into a target directory using file copies (Windows-safe). */
export async function syncSkillsToDirectory(
  skills: ResolvedSkill[],
  targetDir: string,
): Promise<void> {
  mkdirSync(targetDir, { recursive: true });

  const manifest = readManifest(targetDir);
  const currentSlugs = new Set(skills.map((s) => s.slug));

  // Sync each skill
  for (const skill of skills) {
    const hash = hashContent(skill.content);
    const existing = manifest.skills[skill.slug];

    // Skip if already synced and unchanged
    if (existing?.hash === hash && existsSync(join(targetDir, skill.slug))) {
      continue;
    }

    const dest = join(targetDir, skill.slug);
    try {
      // Remove old copy if it exists (was previously synced by us)
      if (existing && existsSync(dest)) {
        rmSync(dest, { recursive: true, force: true });
      }
      cpSync(skill.directory, dest, { recursive: true });
      manifest.skills[skill.slug] = { source: skill.source, hash };
    } catch (err) {
      console.error(`[attache] Failed to sync skill '${skill.slug}' to ${targetDir}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Remove stale synced skills (in our manifest but no longer resolved)
  for (const slug of Object.keys(manifest.skills)) {
    if (!currentSlugs.has(slug)) {
      const dest = join(targetDir, slug);
      try {
        if (existsSync(dest)) {
          rmSync(dest, { recursive: true, force: true });
        }
      } catch {
        // Best-effort cleanup
      }
      delete manifest.skills[slug];
    }
  }

  writeManifest(targetDir, manifest);
}

function readManifest(dir: string): SyncManifest {
  try {
    const raw = readFileSync(join(dir, MANIFEST_FILE), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.syncedBy === "attache" && typeof parsed.skills === "object") {
      return parsed;
    }
  } catch {
    // No manifest or invalid — start fresh
  }
  return { syncedBy: "attache", skills: {} };
}

function writeManifest(dir: string, manifest: SyncManifest): void {
  try {
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  } catch {
    // Non-fatal — worst case, next sync re-copies everything
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
