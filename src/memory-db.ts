import type BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { logInfo } from "./mem-logger.js";
import { requireNativeDep } from "../cli/lib/native-dep.js";

let _Database: typeof BetterSqlite3 | null = null;
function getDatabase(): typeof BetterSqlite3 {
  if (!_Database) {
    _Database = requireNativeDep("better-sqlite3") as typeof BetterSqlite3;
  }
  return _Database;
}

const TAG = "memory-db";


// ── Custom scalar functions (registered before schema init, used at runtime) ──

function registerFunctions(db: BetterSqlite3.Database): void {
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

function ensureSchema(db: BetterSqlite3.Database): void {
  db.exec(`
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

    CREATE TABLE IF NOT EXISTS ingested_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, source_type TEXT NOT NULL,
      identifier TEXT NOT NULL, chunk_count INTEGER NOT NULL, ingested_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ingested_docs_chat ON ingested_documents(user_id);

    CREATE TABLE IF NOT EXISTS extracted_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
      content_original TEXT NOT NULL, content_en TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'fact', source_timestamp INTEGER NOT NULL,
      preserve_original INTEGER NOT NULL DEFAULT 0, preserved_keyword TEXT, created_at INTEGER NOT NULL,
      emotion_score INTEGER DEFAULT 0, recall_count INTEGER DEFAULT 0, last_recalled_at INTEGER,
      relevance_score INTEGER DEFAULT 0, confidence INTEGER DEFAULT 3, source_message_ids TEXT,
      classification INTEGER DEFAULT 1, trust INTEGER DEFAULT 0, integrity INTEGER DEFAULT 2,
      credibility INTEGER DEFAULT 6, embedding BLOB, edited_at INTEGER, edited_by TEXT,
      emotion_tags TEXT, importance_flags TEXT, emotion_arc TEXT, signature BLOB,
      source_type TEXT DEFAULT 'conversation', topic TEXT DEFAULT 'general', tier TEXT DEFAULT 'general',
      valid_from TEXT, valid_to TEXT, emotion_context TEXT,
      encrypted INTEGER DEFAULT 0, recall_timestamps TEXT DEFAULT '[]', created_by TEXT DEFAULT 'unknown',
      cited_count INTEGER DEFAULT 0, rejected_count INTEGER DEFAULT 0,
      semantic_revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_extracted_memories_chat_ts ON extracted_memories(user_id, source_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_extracted_memories_preserve ON extracted_memories(preserve_original) WHERE preserve_original = 1;
    CREATE INDEX IF NOT EXISTS idx_extracted_memories_chat_created ON extracted_memories(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_em_topic ON extracted_memories(topic);
    CREATE INDEX IF NOT EXISTS idx_em_tier ON extracted_memories(tier);
    CREATE INDEX IF NOT EXISTS idx_em_valid ON extracted_memories(valid_to);

    CREATE VIRTUAL TABLE IF NOT EXISTS extracted_memories_fts USING fts5(
      content_en, content=extracted_memories, content_rowid=id, tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS extracted_memories_ai AFTER INSERT ON extracted_memories BEGIN
      INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (new.id, new.content_en);
    END;
    CREATE TRIGGER IF NOT EXISTS extracted_memories_ad AFTER DELETE ON extracted_memories BEGIN
      INSERT INTO extracted_memories_fts(extracted_memories_fts, rowid, content_en) VALUES('delete', old.id, old.content_en);
    END;
    CREATE TRIGGER IF NOT EXISTS extracted_memories_au AFTER UPDATE OF content_en ON extracted_memories BEGIN
      INSERT INTO extracted_memories_fts(extracted_memories_fts, rowid, content_en) VALUES('delete', old.id, old.content_en);
      INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (new.id, new.content_en);
    END;

    CREATE TABLE IF NOT EXISTS extraction_watermarks (user_id TEXT PRIMARY KEY, last_processed_timestamp INTEGER NOT NULL);

    CREATE VIRTUAL TABLE IF NOT EXISTS content_en_trigram USING fts5(content, tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS content_en_trigram_ai AFTER INSERT ON extracted_memories BEGIN
      INSERT INTO content_en_trigram(rowid, content) VALUES (new.id, strip_diacritics(COALESCE(new.content_en, '') || ' ' || COALESCE(new.preserved_keyword, '')));
    END;
    CREATE TRIGGER IF NOT EXISTS content_en_trigram_ad AFTER DELETE ON extracted_memories BEGIN
      DELETE FROM content_en_trigram WHERE rowid = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS content_en_trigram_au AFTER UPDATE OF content_en, preserved_keyword ON extracted_memories BEGIN
      DELETE FROM content_en_trigram WHERE rowid = old.id;
      INSERT INTO content_en_trigram(rowid, content) VALUES (new.id, strip_diacritics(COALESCE(new.content_en, '') || ' ' || COALESCE(new.preserved_keyword, '')));
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS content_original_trigram USING fts5(content, tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS content_original_trigram_ai AFTER INSERT ON extracted_memories BEGIN
      INSERT INTO content_original_trigram(rowid, content) VALUES (new.id, strip_diacritics(COALESCE(new.content_original, '')));
    END;
    CREATE TRIGGER IF NOT EXISTS content_original_trigram_ad AFTER DELETE ON extracted_memories BEGIN
      DELETE FROM content_original_trigram WHERE rowid = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS content_original_trigram_au AFTER UPDATE OF content_original ON extracted_memories BEGIN
      DELETE FROM content_original_trigram WHERE rowid = old.id;
      INSERT INTO content_original_trigram(rowid, content) VALUES (new.id, strip_diacritics(COALESCE(new.content_original, '')));
    END;

    CREATE TABLE IF NOT EXISTS entity_graph (
      id INTEGER PRIMARY KEY,
      entity_a TEXT NOT NULL,
      entity_b TEXT NOT NULL,
      relation TEXT NOT NULL,
      source_memory_id INTEGER,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      UNIQUE(entity_a, entity_b, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_eg_a ON entity_graph(entity_a);
    CREATE INDEX IF NOT EXISTS idx_eg_b ON entity_graph(entity_b);

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
  `);

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
