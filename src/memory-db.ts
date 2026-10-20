import type BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { logInfo } from "./mem-logger.js";
import { requireNativeDep } from "../cli/lib/native-dep.js";
import { PERSONAL_SCHEMA_SQL } from "./personal-schema.js";

let _Database: typeof BetterSqlite3 | null = null;
function getDatabase(): typeof BetterSqlite3 {
  if (!_Database) {
    _Database = requireNativeDep("better-sqlite3") as typeof BetterSqlite3;
  }
  return _Database;
}

const TAG = "memory-db";


// ── Custom scalar functions (registered before schema init, used at runtime) ──

export function registerFunctions(db: BetterSqlite3.Database): void {
  db.function("strip_emojis", (text: unknown) => {
    if (typeof text !== "string") return text;
    return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "").replace(/ {2,}/g, " ").trim();
  });

  db.function("strip_diacritics", (text: unknown) => {
    if (typeof text !== "string") return text;
    return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  });
}

// ── Schema ──────────────────────────────────────────────────────────────────

/** Full base schema DDL — used by initializeDatabase and in-memory tests. */
const BASE_MEMORY_DB_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL,
      platform_message_id TEXT, emotion_score INTEGER DEFAULT 0,
      type_hint TEXT, topic_hint TEXT, emotion_hint TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(user_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_platform_id ON messages(user_id, platform_message_id);

    -- Safety net: drop obsolete messages_fts (removed from architecture, triggers would break INSERTs if table missing)
    DROP TRIGGER IF EXISTS messages_ai;
    DROP TRIGGER IF EXISTS messages_ad;
    DROP TABLE IF EXISTS messages_fts;



    CREATE TABLE IF NOT EXISTS extraction_watermarks (user_id TEXT PRIMARY KEY, last_processed_timestamp INTEGER NOT NULL);

    CREATE TABLE IF NOT EXISTS context_watermarks (
      chat_id TEXT PRIMARY KEY,
      watermark_message_id INTEGER NOT NULL,
      compaction_count INTEGER DEFAULT 0,
      last_compacted_at INTEGER,
      last_failed_at INTEGER,
      pending_compaction INTEGER DEFAULT 0,
      model TEXT,
      token_estimate INTEGER
    );

    CREATE TABLE IF NOT EXISTS context_summaries (
      id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      source_message_start INTEGER NOT NULL,
      source_message_end INTEGER NOT NULL,
      classification INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ctx_summaries_chat ON context_summaries(chat_id, archived, created_at);

    -- #1335: cumulative checkpoint lineage
    CREATE TABLE IF NOT EXISTS context_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      previous_checkpoint_id INTEGER,
      source_message_start INTEGER NOT NULL,
      source_message_end INTEGER NOT NULL,
      first_kept_message_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      source_token_count INTEGER NOT NULL,
      checkpoint_token_count INTEGER NOT NULL,
      source_digest TEXT NOT NULL,
      checkpoint_digest TEXT NOT NULL,
      summarizer_model TEXT,
      summarizer_provider TEXT,
      active_request_model TEXT NOT NULL,
      reason TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      classification INTEGER NOT NULL,
      prompt_version TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      serializer_version TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_chat ON context_checkpoints(chat_id, created_at);

    CREATE TABLE IF NOT EXISTS active_context_checkpoint (
      chat_id TEXT PRIMARY KEY,
      checkpoint_id INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- #1371: Operational memory domain
    CREATE TABLE IF NOT EXISTS operational_lesson_drafts (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('draft', 'promoted', 'rejected')),
      lesson TEXT NOT NULL,
      problem TEXT,
      recommendation TEXT,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      suggested_scope_level TEXT NOT NULL CHECK (suggested_scope_level IN ('global','platform','host','workspace','repository','task_environment')),
      suggested_platform TEXT,
      suggested_host TEXT,
      suggested_workspace TEXT,
      suggested_repository TEXT,
      suggested_task_environment TEXT,
      confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
      source_task_id TEXT,
      source_session_id TEXT,
      source_executor TEXT,
      source_host TEXT,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      promoted_memory_id TEXT REFERENCES operational_memories(id),
      rejected_by TEXT,
      rejected_at INTEGER,
      rejection_reason TEXT,
      CHECK (
        (suggested_scope_level = 'global' AND suggested_platform IS NULL AND suggested_host IS NULL AND suggested_workspace IS NULL AND suggested_repository IS NULL AND suggested_task_environment IS NULL) OR
        (suggested_scope_level = 'platform' AND suggested_platform IS NOT NULL AND suggested_host IS NULL AND suggested_workspace IS NULL AND suggested_repository IS NULL AND suggested_task_environment IS NULL) OR
        (suggested_scope_level = 'host' AND suggested_platform IS NULL AND suggested_host IS NOT NULL AND suggested_workspace IS NULL AND suggested_repository IS NULL AND suggested_task_environment IS NULL) OR
        (suggested_scope_level = 'workspace' AND suggested_platform IS NULL AND suggested_host IS NULL AND suggested_workspace IS NOT NULL AND suggested_repository IS NULL AND suggested_task_environment IS NULL) OR
        (suggested_scope_level = 'repository' AND suggested_platform IS NULL AND suggested_host IS NULL AND suggested_workspace IS NULL AND suggested_repository IS NOT NULL AND suggested_task_environment IS NULL) OR
        (suggested_scope_level = 'task_environment' AND suggested_platform IS NULL AND suggested_host IS NULL AND suggested_workspace IS NULL AND suggested_repository IS NULL AND suggested_task_environment IS NOT NULL)
      ),
      CHECK (
        (status = 'draft' AND promoted_memory_id IS NULL AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL) OR
        (status = 'promoted' AND promoted_memory_id IS NOT NULL AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL) OR
        (status = 'rejected' AND promoted_memory_id IS NULL AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_op_drafts_status ON operational_lesson_drafts(status, created_at);

    CREATE TABLE IF NOT EXISTS operational_memories (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
      scope_level TEXT NOT NULL CHECK (scope_level IN ('global','platform','host','workspace','repository','task_environment')),
      platform TEXT,
      host TEXT,
      workspace TEXT,
      repository TEXT,
      task_environment TEXT,
      content_hash TEXT NOT NULL,
      current_version_id TEXT NOT NULL UNIQUE,
      confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
      provenance_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (scope_level = 'global' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
        (scope_level = 'platform' AND platform IS NOT NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
        (scope_level = 'host' AND platform IS NULL AND host IS NOT NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
        (scope_level = 'workspace' AND platform IS NULL AND host IS NULL AND workspace IS NOT NULL AND repository IS NULL AND task_environment IS NULL) OR
        (scope_level = 'repository' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NOT NULL AND task_environment IS NULL) OR
        (scope_level = 'task_environment' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NOT NULL)
      ),
      FOREIGN KEY (id, current_version_id)
        REFERENCES operational_memory_versions(memory_id, id)
        DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX IF NOT EXISTS idx_op_memories_active ON operational_memories(status, scope_level);

    CREATE TABLE IF NOT EXISTS operational_memory_versions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES operational_memories(id),
      previous_version_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
      scope_level TEXT NOT NULL CHECK (scope_level IN ('global','platform','host','workspace','repository','task_environment')),
      platform TEXT,
      host TEXT,
      workspace TEXT,
      repository TEXT,
      task_environment TEXT,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
      provenance_json TEXT NOT NULL DEFAULT '{}',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      mutation_reason TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (memory_id, id),
      CHECK (
        (scope_level = 'global' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
        (scope_level = 'platform' AND platform IS NOT NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
        (scope_level = 'host' AND platform IS NULL AND host IS NOT NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
        (scope_level = 'workspace' AND platform IS NULL AND host IS NULL AND workspace IS NOT NULL AND repository IS NULL AND task_environment IS NULL) OR
        (scope_level = 'repository' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NOT NULL AND task_environment IS NULL) OR
        (scope_level = 'task_environment' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NOT NULL)
      ),
      FOREIGN KEY (memory_id, previous_version_id)
        REFERENCES operational_memory_versions(memory_id, id)
        DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX IF NOT EXISTS idx_op_versions_lineage ON operational_memory_versions(memory_id, created_at);

    -- #1515: durable Dreamy clarification questions (bounded lifecycle)
    CREATE TABLE IF NOT EXISTS dream_questions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      memory_a_id INTEGER NOT NULL,
      memory_b_id INTEGER NOT NULL,
      memory_a_revision INTEGER NOT NULL,
      memory_b_revision INTEGER NOT NULL,
      question TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending','asked','resolved','expired','dismissed')
      ),
      source_run_id TEXT NOT NULL,
      source_step TEXT NOT NULL CHECK (source_step = 'contradiction-and-graph'),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      asked_at INTEGER,
      resolved_at INTEGER,
      dismissed_at INTEGER,
      delivery_key TEXT,
      CHECK (memory_a_id < memory_b_id),
      CHECK (
        (status = 'pending' AND asked_at IS NULL AND resolved_at IS NULL
          AND dismissed_at IS NULL AND delivery_key IS NULL) OR
        (status = 'asked' AND asked_at IS NOT NULL AND resolved_at IS NULL
          AND dismissed_at IS NULL AND delivery_key IS NOT NULL) OR
        (status = 'resolved' AND resolved_at IS NOT NULL AND dismissed_at IS NULL) OR
        (status = 'expired' AND resolved_at IS NULL AND dismissed_at IS NULL) OR
        (status = 'dismissed' AND resolved_at IS NULL AND dismissed_at IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_dream_questions_user_status_created
      ON dream_questions(user_id, status, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_dream_questions_user_pair
      ON dream_questions(user_id, memory_a_id, memory_b_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_dream_questions_active_pair
      ON dream_questions(user_id, memory_a_id, memory_b_id)
      WHERE status IN ('pending','asked');

    -- #1660: single-row generation ledger for the active secrets key material.
    -- One row, singleton = 1. Backups/restores carry it; a restore may move it
    -- backwards relative to the on-disk key, which is reported, not repaired.
    CREATE TABLE IF NOT EXISTS secret_key_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      active_generation INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO secret_key_state (singleton, active_generation) VALUES (1, 1);
`;

export const MEMORY_DB_SCHEMA_SQL = `${BASE_MEMORY_DB_SCHEMA_SQL}
${PERSONAL_SCHEMA_SQL}
`;

function ensureSchema(db: BetterSqlite3.Database): void {
  db.exec(MEMORY_DB_SCHEMA_SQL);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Opens (or creates) the SQLite database at the given path, registers
 * custom functions, and ensures the schema exists.
 */
export function initializeDatabase(dbPath: string): BetterSqlite3.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const Database = getDatabase();
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  registerFunctions(db);
  ensureSchema(db);

  logInfo(TAG, `Database initialized at ${dbPath}`);
  return db;
}
