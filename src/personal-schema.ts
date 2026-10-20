/**
 * personal-schema.ts — Personal memory contract v1 structural DDL (#1930).
 *
 * Structural boot DDL only: creates episode/durable/readiness/forgetting
 * bookkeeping. Content conversion and re-own are retired (#1939 stage 3:
 * every host is converted; unconverted datasets are unconvertible).
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

/**
 * #1928 C4 — retrieval projection surfaces (M2).
 *
 * Derived, reconstructible index data over primary-owned eligible durable
 * revisions and episodes. Structural DDL only: this creates empty surfaces
 * and never stamps populated/ready. Content backfill runs exclusively
 * through the reviewed inspect/build/verify/activate module
 * (recall-projection-build.ts) behind the generation barrier, which
 * requires a verified backup. No raw transcript or summary content is
 * copied here; sealed exact values never enter these surfaces.
 */
export const RECALL_PROJECTION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS recall_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    layer TEXT NOT NULL CHECK (layer IN ('durable','episode')),
    record_id INTEGER NOT NULL,
    owner TEXT NOT NULL,
    source_version TEXT NOT NULL,
    generation INTEGER NOT NULL,
    safe_text TEXT NOT NULL,
    original_text TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT '{"scope":"general"}',
    authority TEXT NOT NULL DEFAULT 'inference',
    classification INTEGER NOT NULL DEFAULT 1,
    source_refs TEXT NOT NULL DEFAULT '[]',
    signature BLOB,
    UNIQUE(layer, record_id, owner, source_version, generation)
  );
  CREATE INDEX IF NOT EXISTS idx_recall_docs_owner_gen ON recall_documents(owner, generation);
  CREATE INDEX IF NOT EXISTS idx_recall_docs_source ON recall_documents(layer, record_id, owner);

  CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(
    safe_text, content=recall_documents, content_rowid=id, tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS recall_fts_ai AFTER INSERT ON recall_documents BEGIN
    INSERT INTO recall_fts(rowid, safe_text) VALUES (new.id, new.safe_text);
  END;
  CREATE TRIGGER IF NOT EXISTS recall_fts_ad AFTER DELETE ON recall_documents BEGIN
    INSERT INTO recall_fts(recall_fts, rowid, safe_text) VALUES('delete', old.id, old.safe_text);
  END;
  CREATE TRIGGER IF NOT EXISTS recall_fts_au AFTER UPDATE OF safe_text ON recall_documents BEGIN
    INSERT INTO recall_fts(recall_fts, rowid, safe_text) VALUES('delete', old.id, old.safe_text);
    INSERT INTO recall_fts(rowid, safe_text) VALUES (new.id, new.safe_text);
  END;

  CREATE VIRTUAL TABLE IF NOT EXISTS recall_trigram_en USING fts5(content, tokenize='trigram');
  CREATE TRIGGER IF NOT EXISTS recall_trigram_en_ai AFTER INSERT ON recall_documents BEGIN
    INSERT INTO recall_trigram_en(rowid, content) VALUES (new.id, strip_diacritics(new.safe_text || ' ' || new.keywords));
  END;
  CREATE TRIGGER IF NOT EXISTS recall_trigram_en_ad AFTER DELETE ON recall_documents BEGIN
    DELETE FROM recall_trigram_en WHERE rowid = old.id;
  END;
  CREATE TRIGGER IF NOT EXISTS recall_trigram_en_au AFTER UPDATE OF safe_text, keywords ON recall_documents BEGIN
    DELETE FROM recall_trigram_en WHERE rowid = old.id;
    INSERT INTO recall_trigram_en(rowid, content) VALUES (new.id, strip_diacritics(new.safe_text || ' ' || new.keywords));
  END;

  CREATE VIRTUAL TABLE IF NOT EXISTS recall_trigram_orig USING fts5(content, tokenize='trigram');
  CREATE TRIGGER IF NOT EXISTS recall_trigram_orig_ai AFTER INSERT ON recall_documents BEGIN
    INSERT INTO recall_trigram_orig(rowid, content) VALUES (new.id, strip_diacritics(new.original_text));
  END;
  CREATE TRIGGER IF NOT EXISTS recall_trigram_orig_ad AFTER DELETE ON recall_documents BEGIN
    DELETE FROM recall_trigram_orig WHERE rowid = old.id;
  END;
  CREATE TRIGGER IF NOT EXISTS recall_trigram_orig_au AFTER UPDATE OF original_text ON recall_documents BEGIN
    DELETE FROM recall_trigram_orig WHERE rowid = old.id;
    INSERT INTO recall_trigram_orig(rowid, content) VALUES (new.id, strip_diacritics(new.original_text));
  END;

  CREATE TABLE IF NOT EXISTS recall_vectors (
    doc_id INTEGER PRIMARY KEY REFERENCES recall_documents(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vector BLOB NOT NULL,
    source_version TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recall_graph_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    entity_a TEXT NOT NULL,
    entity_b TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'related',
    src_layer TEXT NOT NULL,
    src_record_id INTEGER NOT NULL,
    src_version TEXT NOT NULL,
    generation INTEGER NOT NULL,
    UNIQUE(owner, entity_a, entity_b, relation, src_layer, src_record_id, generation)
  );
  CREATE INDEX IF NOT EXISTS idx_recall_graph_owner ON recall_graph_edges(owner, generation);

  CREATE TABLE IF NOT EXISTS recall_projection_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    state TEXT NOT NULL CHECK (state IN ('not_built','building','ready','interrupted','failed')),
    serving_generation INTEGER,
    building_generation INTEGER,
    projection_version INTEGER NOT NULL DEFAULT 1,
    reason TEXT,
    progress TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
`;

export function ensurePersonalSchema(db: Database.Database): void {
  db.exec(PERSONAL_SCHEMA_SQL);
  db.exec(RECALL_PROJECTION_SCHEMA_SQL);
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
  // #1939 stage 3: the legacy table is dropped by the boot migration before
  // this runs, so there is no legacy-row check left here.
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
    ).run("unconvertible: existing personal rows or artifacts present (conversion retired)", now);
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
