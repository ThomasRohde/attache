import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Preferred Attache user data directory: ~/.attache */
export const ATTACHE_HOME = join(homedir(), ".attache");

/** Known user-data homes in priority order */
export const HOME_CANDIDATES = [ATTACHE_HOME] as const;

export const ATTACHE_DB_PATH = join(ATTACHE_HOME, "attache.db");
export const ATTACHE_ENV_PATH = join(ATTACHE_HOME, ".env");
export const ATTACHE_SKILLS_DIR = join(ATTACHE_HOME, "skills");
export const ATTACHE_SESSIONS_DIR = join(ATTACHE_HOME, "sessions");
export const ATTACHE_UPLOADS_DIR = join(ATTACHE_HOME, "uploads");
export const ATTACHE_API_TOKEN_PATH = join(ATTACHE_HOME, "api-token");

/** Return the active Attache home directory. */
export function getActiveHome(): string {
  return ATTACHE_HOME;
}

export function hasAttacheState(): boolean {
  return existsSync(ATTACHE_HOME);
}

/** Path to the SQLite database */
export const DB_PATH = ATTACHE_DB_PATH;

/** Path to the user .env file */
export const ENV_PATH = ATTACHE_ENV_PATH;

/** Path to user-local skills */
export const SKILLS_DIR = ATTACHE_SKILLS_DIR;

/** Path to Attache's isolated session state (keeps CLI history clean) */
export const SESSIONS_DIR = ATTACHE_SESSIONS_DIR;

/** Path to the API bearer token file */
export const API_TOKEN_PATH = ATTACHE_API_TOKEN_PATH;

export function ensureHome(homePath: string): void {
  mkdirSync(homePath, { recursive: true });
}

/** Ensure ~/.attache/ exists */
export function ensureAttacheHome(): void {
  ensureHome(ATTACHE_HOME);
  ensureHome(ATTACHE_UPLOADS_DIR);
}
