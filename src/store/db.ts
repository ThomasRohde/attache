import Database from "better-sqlite3";
import { DB_PATH, ensureAttacheHome } from "../paths.js";
import { config } from "../config.js";
import { formatAssistantHandle } from "../identity.js";

let db: Database.Database | undefined;
let logInsertCount = 0;
let skillUsageInsertCount = 0;
export const ASSISTANT_DISPLAY_NAME_STATE_KEY = "assistant_display_name";

export function getDb(): Database.Database {
  if (!db) {
    ensureAttacheHome();
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        copilot_session_id TEXT,
        working_dir TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        last_output TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Clean up stale worker sessions from previous daemon runs
    db.exec(`DELETE FROM worker_sessions`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS attache_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'unknown',
        ts DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK(category IN ('preference', 'fact', 'project', 'person', 'routine')),
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // ── FTS5 full-text index for memories ──────────────────────
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        content=memories,
        content_rowid=id,
        tokenize='porter unicode61'
      )
    `);
    // Keep FTS5 index in sync via triggers
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES (new.id, new.content);
      END
    `);
    // Populate FTS5 from any existing memories not yet indexed
    {
      const ftsCount = (db.prepare(`SELECT COUNT(*) as c FROM memories_fts`).get() as { c: number }).c;
      const memCount = (db.prepare(`SELECT COUNT(*) as c FROM memories`).get() as { c: number }).c;
      if (memCount > 0 && ftsCount === 0) {
        db.exec(`INSERT INTO memories_fts(rowid, content) SELECT id, content FROM memories`);
      }
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'partial')),
        notes TEXT,
        used_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_skill_usage_slug ON skill_usage(slug)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        notify_telegram INTEGER NOT NULL DEFAULT 0,
        last_run_at DATETIME,
        last_status TEXT CHECK(last_status IN ('success', 'failure', 'running')),
        next_run_at DATETIME,
        run_count INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS cron_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('success', 'failure', 'running')),
        result TEXT,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME,
        duration_ms INTEGER
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_exec_job ON cron_executions(job_id)`);
    // Migrate: if the table already existed with a stricter CHECK, recreate it
    try {
      const probe = db.prepare(
        `INSERT INTO conversation_log (role, content, source) VALUES ('system', '__migration_test__', 'test')`,
      ).run();
      db.prepare(`DELETE FROM conversation_log WHERE id = ?`).run(probe.lastInsertRowid);
    } catch {
      // CHECK constraint doesn't allow 'system' — recreate table preserving data
      const migrateConversationLog = db.transaction(() => {
        db!.exec(`ALTER TABLE conversation_log RENAME TO conversation_log_old`);
        db!.exec(`
          CREATE TABLE conversation_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
            content TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'unknown',
            ts DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        db!.exec(`INSERT INTO conversation_log (role, content, source, ts) SELECT role, content, source, ts FROM conversation_log_old`);
        db!.exec(`DROP TABLE conversation_log_old`);
      });
      migrateConversationLog();
    }
    // Prune conversation log at startup
    db.prepare(`DELETE FROM conversation_log WHERE id NOT IN (SELECT id FROM conversation_log ORDER BY id DESC LIMIT 200)`).run();
  }
  return db;
}

export function getState(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM attache_state WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setState(key: string, value: string): void {
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO attache_state (key, value) VALUES (?, ?)`).run(key, value);
}

export function getAssistantDisplayName(): string | undefined {
  return getState(ASSISTANT_DISPLAY_NAME_STATE_KEY);
}

export function setAssistantDisplayName(value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Assistant display name must not be blank");
  }
  setState(ASSISTANT_DISPLAY_NAME_STATE_KEY, trimmed);
}

/** Remove a key from persistent state. */
export function deleteState(key: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM attache_state WHERE key = ?`).run(key);
}

/** Log a conversation turn (user, assistant, or system). */
export function logConversation(role: "user" | "assistant" | "system", content: string, source: string): void {
  const db = getDb();
  db.prepare(`INSERT INTO conversation_log (role, content, source) VALUES (?, ?, ?)`).run(role, content, source);
  // Keep last 200 entries to support context recovery after session loss
  logInsertCount++;
  if (logInsertCount % 50 === 0) {
    db.prepare(`DELETE FROM conversation_log WHERE id NOT IN (SELECT id FROM conversation_log ORDER BY id DESC LIMIT 200)`).run();
  }
}

/** Delete all rows from conversation_log. */
export function clearConversationLog(): void {
  const db = getDb();
  db.prepare(`DELETE FROM conversation_log`).run();
}

/** Get recent conversation history formatted for injection into system message. */
export function getRecentConversation(limit = 20): string {
  const db = getDb();
  const rows = db.prepare(
    `SELECT role, content, source, ts FROM conversation_log ORDER BY id DESC LIMIT ?`
  ).all(limit) as { role: string; content: string; source: string; ts: string }[];

  if (rows.length === 0) return "";

  // Reverse so oldest is first (chronological order)
  rows.reverse();

  return rows.map((r) => {
    const tag = r.role === "user" ? `[${r.source}] User`
      : r.role === "system" ? `[${r.source}] System`
      : formatAssistantHandle(config.assistantDisplayName);
    // Truncate long messages to keep context manageable
    const content = r.content.length > 500 ? r.content.slice(0, 500) + "…" : r.content;
    return `${tag}: ${content}`;
  }).join("\n\n");
}

const MAX_MEMORY_CONTENT_LENGTH = 10_000;

/** Add a memory to long-term storage. */
export function addMemory(
  category: "preference" | "fact" | "project" | "person" | "routine",
  content: string,
  source: "user" | "auto" = "user"
): number {
  if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
    throw new Error(`Memory content too long (${content.length} chars, max ${MAX_MEMORY_CONTENT_LENGTH})`);
  }
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO memories (category, content, source) VALUES (?, ?, ?)`
  ).run(category, content, source);
  return result.lastInsertRowid as number;
}

/** Search memories by keyword and/or category.
 *  Uses FTS5 full-text search when a keyword is provided (supports boolean
 *  operators, proximity, prefix matching).  Falls back to a simple scan when
 *  only a category filter is given.
 */
export function searchMemories(
  keyword?: string,
  category?: string,
  limit = 20
): { id: number; category: string; content: string; source: string; created_at: string }[] {
  const db = getDb();

  let rows: { id: number; category: string; content: string; source: string; created_at: string }[];

  if (keyword) {
    // Build an FTS5 query: add implicit prefix matching (*) to each bare term
    // so "deploy" also matches "deployment", while preserving explicit operators
    // like AND, OR, NOT, and quoted phrases the caller may have used.
    const ftsQuery = keyword
      .split(/\s+/)
      .map((tok) => {
        // Pass through FTS5 operators and quoted phrases
        if (/^(AND|OR|NOT)$/i.test(tok) || tok.startsWith('"')) return tok;
        // Already has a prefix wildcard
        if (tok.endsWith("*")) return tok;
        return tok + "*";
      })
      .join(" ");

    const catFilter = category ? `AND m.category = ?` : "";
    const params: (string | number)[] = [ftsQuery];
    if (category) params.push(category);
    params.push(limit);

    rows = db.prepare(`
      SELECT m.id, m.category, m.content, m.source, m.created_at
      FROM memories_fts f
      JOIN memories m ON m.id = f.rowid
      WHERE memories_fts MATCH ?
      ${catFilter}
      ORDER BY f.rank, m.last_accessed DESC
      LIMIT ?
    `).all(...params) as typeof rows;
  } else {
    // No keyword — simple category scan
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (category) {
      conditions.push(`category = ?`);
      params.push(category);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    rows = db.prepare(
      `SELECT id, category, content, source, created_at FROM memories ${where} ORDER BY last_accessed DESC LIMIT ?`
    ).all(...params) as typeof rows;
  }

  // Update last_accessed for returned memories
  if (rows.length > 0) {
    const placeholders = rows.map(() => "?").join(",");
    db.prepare(`UPDATE memories SET last_accessed = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...rows.map((r) => r.id));
  }

  return rows;
}

/** Remove a memory by ID. */
export function removeMemory(id: number): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  return result.changes > 0;
}

/** Get a compact summary of all memories for injection into system message. */
export function getMemorySummary(): string {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, category, content FROM memories ORDER BY category, last_accessed DESC`
  ).all() as { id: number; category: string; content: string }[];

  if (rows.length === 0) return "";

  // Group by category
  const grouped: Record<string, { id: number; content: string }[]> = {};
  for (const r of rows) {
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push({ id: r.id, content: r.content });
  }

  const sections = Object.entries(grouped).map(([cat, items]) => {
    const lines = items.map((i) => {
      // Truncate long entries to prevent system message bloat
      const content = i.content.length > 500 ? i.content.slice(0, 500) + "…" : i.content;
      return `  - [#${i.id}] ${content}`;
    }).join("\n");
    return `**${cat}**:\n${lines}`;
  });

  return sections.join("\n");
}

/** Log a skill usage event. Returns the row ID. Prunes to 500 rows every 50 inserts. */
export function logSkillUsage(
  slug: string,
  outcome: "success" | "failure" | "partial",
  notes?: string,
): number {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO skill_usage (slug, outcome, notes) VALUES (?, ?, ?)`,
  ).run(slug, outcome, notes ?? null);
  skillUsageInsertCount++;
  if (skillUsageInsertCount % 50 === 0) {
    db.prepare(`DELETE FROM skill_usage WHERE id NOT IN (SELECT id FROM skill_usage ORDER BY id DESC LIMIT 500)`).run();
  }
  return result.lastInsertRowid as number;
}

/** Get aggregated skill usage stats, optionally filtered by slug. */
export function getSkillStats(
  slug?: string,
): { slug: string; total: number; successes: number; failures: number; partials: number; lastUsed: string; recentNotes: string[] }[] {
  const db = getDb();
  const condition = slug ? `WHERE slug = ?` : "";
  const params = slug ? [slug] : [];

  const rows = db.prepare(
    `SELECT slug,
            COUNT(*) as total,
            SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
            SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) as failures,
            SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) as partials,
            MAX(used_at) as lastUsed
     FROM skill_usage ${condition}
     GROUP BY slug
     ORDER BY lastUsed DESC`,
  ).all(...params) as { slug: string; total: number; successes: number; failures: number; partials: number; lastUsed: string }[];

  return rows.map((r) => {
    const noteRows = db.prepare(
      `SELECT notes FROM skill_usage WHERE slug = ? AND notes IS NOT NULL ORDER BY id DESC LIMIT 5`,
    ).all(r.slug) as { notes: string }[];
    return { ...r, recentNotes: noteRows.map((n) => n.notes) };
  });
}

/** Get raw skill usage history for a specific skill. */
export function getSkillUsageHistory(
  slug: string,
  limit = 20,
): { id: number; slug: string; outcome: string; notes: string | null; used_at: string }[] {
  const db = getDb();
  return db.prepare(
    `SELECT id, slug, outcome, notes, used_at FROM skill_usage WHERE slug = ? ORDER BY id DESC LIMIT ?`,
  ).all(slug, limit) as { id: number; slug: string; outcome: string; notes: string | null; used_at: string }[];
}

// ── Cron Job CRUD ─────────────────────────────────────────

export interface CronJob {
  id: number;
  name: string;
  prompt: string;
  cron_expression: string;
  enabled: number;
  notify_telegram: number;
  last_run_at: string | null;
  last_status: string | null;
  next_run_at: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

export interface CronExecution {
  id: number;
  job_id: number;
  status: string;
  result: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

let cronExecInsertCount = 0;

export function createCronJob(
  name: string,
  prompt: string,
  cronExpr: string,
  notifyTelegram = false,
): number {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO cron_jobs (name, prompt, cron_expression, notify_telegram) VALUES (?, ?, ?, ?)`,
  ).run(name, prompt, cronExpr, notifyTelegram ? 1 : 0);
  return result.lastInsertRowid as number;
}

export function getCronJobs(): CronJob[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM cron_jobs ORDER BY id`).all() as CronJob[];
}

export function getCronJob(id: number): CronJob | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM cron_jobs WHERE id = ?`).get(id) as CronJob | undefined;
}

export function updateCronJob(
  id: number,
  fields: Partial<{ name: string; prompt: string; cron_expression: string; enabled: boolean; notify_telegram: boolean }>,
): void {
  const db = getDb();
  const sets: string[] = [];
  const params: (string | number)[] = [];

  if (fields.name !== undefined) { sets.push("name = ?"); params.push(fields.name); }
  if (fields.prompt !== undefined) { sets.push("prompt = ?"); params.push(fields.prompt); }
  if (fields.cron_expression !== undefined) { sets.push("cron_expression = ?"); params.push(fields.cron_expression); }
  if (fields.enabled !== undefined) { sets.push("enabled = ?"); params.push(fields.enabled ? 1 : 0); }
  if (fields.notify_telegram !== undefined) { sets.push("notify_telegram = ?"); params.push(fields.notify_telegram ? 1 : 0); }

  if (sets.length === 0) return;
  sets.push("updated_at = CURRENT_TIMESTAMP");
  params.push(id);

  db.prepare(`UPDATE cron_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function deleteCronJob(id: number): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM cron_jobs WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function logCronExecution(jobId: number, status: string): number {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO cron_executions (job_id, status) VALUES (?, ?)`,
  ).run(jobId, status);

  // Prune: every 100 inserts, keep last 500 per job
  cronExecInsertCount++;
  if (cronExecInsertCount % 100 === 0) {
    db.prepare(
      `DELETE FROM cron_executions WHERE id NOT IN (
        SELECT e.id FROM cron_executions e
        INNER JOIN (
          SELECT job_id, id,
            ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY id DESC) AS rn
          FROM cron_executions
        ) ranked ON e.id = ranked.id AND ranked.rn <= 500
      )`,
    ).run();
  }

  return result.lastInsertRowid as number;
}

export function completeCronExecution(
  executionId: number,
  status: "success" | "failure",
  result: string | null,
  durationMs: number,
): void {
  const db = getDb();
  db.prepare(
    `UPDATE cron_executions SET status = ?, result = ?, finished_at = CURRENT_TIMESTAMP, duration_ms = ? WHERE id = ?`,
  ).run(status, result, durationMs, executionId);
}

export function getCronExecutions(jobId?: number, limit = 50): CronExecution[] {
  const db = getDb();
  if (jobId !== undefined) {
    return db.prepare(
      `SELECT * FROM cron_executions WHERE job_id = ? ORDER BY id DESC LIMIT ?`,
    ).all(jobId, limit) as CronExecution[];
  }
  return db.prepare(
    `SELECT * FROM cron_executions ORDER BY id DESC LIMIT ?`,
  ).all(limit) as CronExecution[];
}

export function updateCronJobRunState(
  id: number,
  state: { lastRunAt?: string; lastStatus?: string; nextRunAt?: string | null; runCount?: number },
): void {
  const db = getDb();
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (state.lastRunAt !== undefined) { sets.push("last_run_at = ?"); params.push(state.lastRunAt); }
  if (state.lastStatus !== undefined) { sets.push("last_status = ?"); params.push(state.lastStatus); }
  if (state.nextRunAt !== undefined) { sets.push("next_run_at = ?"); params.push(state.nextRunAt); }
  if (state.runCount !== undefined) { sets.push("run_count = ?"); params.push(state.runCount); }

  if (sets.length === 0) return;
  sets.push("updated_at = CURRENT_TIMESTAMP");
  params.push(id);

  db.prepare(`UPDATE cron_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}
