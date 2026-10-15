/**
 * personal-schema.ts — Personal memory contract v1 structural DDL (#1930).
 *
 * Structural boot DDL only: creates episode/durable/readiness/forgetting
 * bookkeeping. Never reinterprets legacy `general`/`core`, never derives
 * episodes, never changes classification/encryption. Content conversion runs
 * only through personal-conversion.ts reviewed inspect/apply.
 */

import type Database from "better-sqlite3";
import { existsSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";

/** Personal data-model version frozen by specs/1930. */
export const PERSONAL_MODEL_VERSION = 1;

/** Fail-closed personal serving states (design C5). */
export type PersonalDataState =
  | "legacy"
  | "converting"
  | "interrupted"
  | "failed"
  | "awaiting_decision"
  | "ready";

export const PERSONAL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS short_term_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER NOT NULL,
    session_ids TEXT NOT NULL DEFAULT '[]',
    source_message_ids TEXT NOT NULL DEFAULT '[]',
    grouping_hash TEXT NOT NULL,
    outcomes TEXT,
    unresolved TEXT,
    evidence_excerpts TEXT NOT NULL DEFAULT '[]',
    prominence REAL NOT NULL DEFAULT 1.0,
    prev_episode_id INTEGER,
    next_episode_id INTEGER,
    classification INTEGER NOT NULL DEFAULT 1,
    encrypted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, grouping_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_stm_owner_time ON short_term_memories(user_id, start_ts);
  CREATE INDEX IF NOT EXISTS idx_stm_owner_topic ON short_term_memories(user_id, topic);

  CREATE TABLE IF NOT EXISTS long_term_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    memory_type TEXT NOT NULL DEFAULT 'fact',
    content TEXT NOT NULL,
    content_original TEXT,
    authority TEXT NOT NULL DEFAULT 'inference' CHECK (authority IN ('user_statement','confirmed_decision','agent_proposal','inference')),
    applicability_scope TEXT NOT NULL DEFAULT '{"scope":"general"}',
    valid_from TEXT,
    valid_to TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    supersedes_id INTEGER,
    superseded_by_id INTEGER,
    provenance TEXT NOT NULL DEFAULT '{}',
    evidence TEXT NOT NULL DEFAULT '[]',
    classification INTEGER NOT NULL DEFAULT 1,
    encrypted INTEGER NOT NULL DEFAULT 0,
    sealed_format_version INTEGER NOT NULL DEFAULT 0,
    embedding BLOB,
    signature BLOB,
    semantic_revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ltm_owner_type ON long_term_memories(user_id, memory_type);
  CREATE INDEX IF NOT EXISTS idx_ltm_owner_current ON long_term_memories(user_id, superseded_by_id);

  CREATE TABLE IF NOT EXISTS long_term_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id INTEGER NOT NULL REFERENCES long_term_memories(id),
    user_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_original TEXT,
    authority TEXT NOT NULL,
    applicability_scope TEXT NOT NULL,
    valid_from TEXT,
    valid_to TEXT,
    supersedes_id INTEGER,
    provenance TEXT NOT NULL DEFAULT '{}',
    evidence TEXT NOT NULL DEFAULT '[]',
    classification INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE(memory_id, revision)
  );

  CREATE TABLE IF NOT EXISTS personal_model_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    state TEXT NOT NULL CHECK (state IN ('legacy','converting','interrupted','failed','awaiting_decision','ready')),
    expected_version INTEGER NOT NULL DEFAULT 1,
    actual_version INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    progress TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS forget_markers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    record_kind TEXT NOT NULL CHECK (record_kind IN ('episode','durable','raw','evidence')),
    record_id INTEGER NOT NULL,
    episode_id INTEGER,
    lineage TEXT NOT NULL DEFAULT '[]',
    digest TEXT NOT NULL,
    key_generation INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE(owner, record_kind, record_id)
  );
  CREATE INDEX IF NOT EXISTS idx_forget_owner ON forget_markers(owner);

  CREATE TABLE IF NOT EXISTS forget_key_ring (
    owner TEXT NOT NULL,
    generation INTEGER NOT NULL,
    wrapped_key BLOB NOT NULL,
    nonce BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner, generation)
  );

  CREATE TABLE IF NOT EXISTS forget_operations (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','complete')),
    targets TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS personal_grouping_ledger (
    user_id TEXT NOT NULL,
    grouping_hash TEXT NOT NULL,
    episode_id INTEGER NOT NULL REFERENCES short_term_memories(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, grouping_hash)
  );
`;

export function ensurePersonalSchema(db: Database.Database): void {
  db.exec(PERSONAL_SCHEMA_SQL);
}

/** Readiness row, or undefined when bookkeeping was never seeded. */
export function getPersonalState(db: Database.Database): {
  state: PersonalDataState;
  expected_version: number;
  actual_version: number;
  reason: string | null;
  progress: string;
} | undefined {
  try {
    const row = db.prepare(
      "SELECT state, expected_version, actual_version, reason, progress FROM personal_model_state WHERE singleton = 1",
    ).get() as
      | { state: PersonalDataState; expected_version: number; actual_version: number; reason: string | null; progress: string }
      | undefined;
    return row;
  } catch {
    return undefined;
  }
}

/**
 * Seed readiness bookkeeping without content conversion.
 * Fresh empty installs become ready; anything with legacy personal rows,
 * messages, summaries/checkpoints, or conversion progress stays legacy.
 * Idempotent: never overwrites an existing row.
 */
export function seedPersonalReadiness(db: Database.Database, dataDir?: string): void {
  const existing = getPersonalState(db);
  if (existing) return;
  const now = Date.now();
  let hasLegacy = false;
  try {
    const mem = (db.prepare("SELECT COUNT(*) as c FROM extracted_memories").get() as { c: number }).c;
    if (mem > 0) hasLegacy = true;
  } catch { /* table may predate */ }
  try {
    const msg = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c;
    if (msg > 0) hasLegacy = true;
  } catch { /* ignore */ }
  try {
    const sum = (db.prepare("SELECT COUNT(*) as c FROM context_summaries").get() as { c: number }).c;
    if (sum > 0) hasLegacy = true;
  } catch { /* ignore */ }
  try {
    const chk = (db.prepare("SELECT COUNT(*) as c FROM context_checkpoints").get() as { c: number }).c;
    if (chk > 0) hasLegacy = true;
  } catch { /* ignore */ }
  // A missing readiness row is never proof that a populated new-model store
  // or on-disk projection is a fresh installation.
  for (const table of ["short_term_memories", "long_term_memories", "long_term_revisions", "personal_grouping_ledger", "forget_markers", "forget_operations"]) {
    if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) hasLegacy = true;
  }
  if (dataDir) {
    const hasFiles = (dir: string): boolean => existsSync(dir) && readdirSync(dir).some(name => {
      const file = join(dir, name);
      const stat = lstatSync(file);
      return stat.isSymbolicLink() || (stat.isDirectory() ? hasFiles(file) : /\.(md|json)$/.test(name));
    });
    if (["core", "daily", "weekly", "quarterly", "sleep"].some(tier => hasFiles(join(dataDir, tier)))) hasLegacy = true;
  }
  if (hasLegacy) {
    db.prepare(
      "INSERT INTO personal_model_state (singleton, state, expected_version, actual_version, reason, progress, updated_at) VALUES (1, 'legacy', 1, 0, ?, '{}', ?)",
    ).run("conversion required: existing personal rows or artifacts present", now);
  } else {
    db.prepare(
      "INSERT INTO personal_model_state (singleton, state, expected_version, actual_version, reason, progress, updated_at) VALUES (1, 'ready', 1, 1, ?, '{}', ?)",
    ).run("fresh installation on the new model", now);
  }
}

export function setPersonalState(
  db: Database.Database,
  state: PersonalDataState,
  opts?: { reason?: string; progress?: string; actualVersion?: number },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO personal_model_state (singleton, state, expected_version, actual_version, reason, progress, updated_at)
     VALUES (1, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET state = excluded.state, actual_version = excluded.actual_version,
       reason = excluded.reason, progress = excluded.progress, updated_at = excluded.updated_at`,
  ).run(state, opts?.actualVersion ?? (state === "ready" ? 1 : 0), opts?.reason ?? null, opts?.progress ?? "{}", now);
}

/** Fail-closed gate: true only when personal serving is authorized. */
export function isPersonalReady(db: Database.Database): boolean {
  const row = getPersonalState(db);
  return row?.state === "ready" && row.actual_version === PERSONAL_MODEL_VERSION && row.expected_version === PERSONAL_MODEL_VERSION;
}
