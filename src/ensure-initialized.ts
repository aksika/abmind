/**
 * ensure-initialized.ts — lazy runtime init for abmind (#427).
 *
 * Called on every MemoryManager.initialize(). Idempotent:
 * 1. Seeds missing core files from bundled templates
 * 2. Runs versioned schema migrations (additive only)
 *
 * Fast path (everything current): 1 SELECT + N existsSync = <1ms.
 * Pattern: idempotent seed + versioned migrations.
 *
 * Note (#1323, #1324): SOUL.md is personalized and owned by `soul-seeder`.
 * Lazy-init seed of the OTHER core files (agent_notes, memory-tools, etc.)
 * remains this module's job; SOUL.md is explicitly skipped to avoid
 * clobbering the personalized copy on every MemoryManager.initialize().
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const MIGRATIONS: Array<(db: Database.Database) => void> = [
  // #824: recall quality feedback columns
  (db) => {
    try { db.exec("ALTER TABLE extracted_memories ADD COLUMN cited_count INTEGER DEFAULT 0"); } catch { /* exists */ }
    try { db.exec("ALTER TABLE extracted_memories ADD COLUMN rejected_count INTEGER DEFAULT 0"); } catch { /* exists */ }
  },
  // #1371: operational memory domain tables (idempotent safety net)
  (db) => {
    db.exec(`
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
        CHECK ((suggested_scope_level = 'global' AND suggested_platform IS NULL AND suggested_host IS NULL AND suggested_workspace IS NULL AND suggested_repository IS NULL AND suggested_task_environment IS NULL) OR
               (suggested_scope_level = 'platform' AND suggested_platform IS NOT NULL AND suggested_host IS NULL AND suggested_workspace IS NULL AND suggested_repository IS NULL AND suggested_task_environment IS NULL) OR
               (suggested_scope_level = 'host' AND suggested_platform IS NULL AND suggested_host IS NOT NULL AND suggested_workspace IS NULL AND suggested_repository IS NULL AND suggested_task_environment IS NULL) OR
               (suggested_scope_level = 'workspace' AND suggested_platform IS NULL AND suggested_host IS NULL AND suggested_workspace IS NOT NULL AND suggested_repository IS NULL AND suggested_task_environment IS NULL) OR
               (suggested_scope_level = 'repository' AND suggested_platform IS NULL AND suggested_host IS NULL AND suggested_workspace IS NULL AND suggested_repository IS NOT NULL AND suggested_task_environment IS NULL) OR
               (suggested_scope_level = 'task_environment' AND suggested_platform IS NULL AND suggested_host IS NULL AND suggested_workspace IS NULL AND suggested_repository IS NULL AND suggested_task_environment IS NOT NULL)),
        CHECK ((status = 'draft' AND promoted_memory_id IS NULL AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL) OR
               (status = 'promoted' AND promoted_memory_id IS NOT NULL AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL) OR
               (status = 'rejected' AND promoted_memory_id IS NULL AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_op_drafts_status ON operational_lesson_drafts(status, created_at);

      CREATE TABLE IF NOT EXISTS operational_memories (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
        scope_level TEXT NOT NULL CHECK (scope_level IN ('global','platform','host','workspace','repository','task_environment')),
        platform TEXT, host TEXT, workspace TEXT, repository TEXT, task_environment TEXT,
        content_hash TEXT NOT NULL,
        current_version_id TEXT NOT NULL UNIQUE,
        confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
        provenance_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((scope_level = 'global' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
               (scope_level = 'platform' AND platform IS NOT NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
               (scope_level = 'host' AND platform IS NULL AND host IS NOT NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
               (scope_level = 'workspace' AND platform IS NULL AND host IS NULL AND workspace IS NOT NULL AND repository IS NULL AND task_environment IS NULL) OR
               (scope_level = 'repository' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NOT NULL AND task_environment IS NULL) OR
               (scope_level = 'task_environment' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NOT NULL)),
        FOREIGN KEY (id, current_version_id) REFERENCES operational_memory_versions(memory_id, id) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE INDEX IF NOT EXISTS idx_op_memories_active ON operational_memories(status, scope_level);

      CREATE TABLE IF NOT EXISTS operational_memory_versions (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES operational_memories(id),
        previous_version_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
        scope_level TEXT NOT NULL CHECK (scope_level IN ('global','platform','host','workspace','repository','task_environment')),
        platform TEXT, host TEXT, workspace TEXT, repository TEXT, task_environment TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
        provenance_json TEXT NOT NULL DEFAULT '{}',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        mutation_reason TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (memory_id, id),
        CHECK ((scope_level = 'global' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
               (scope_level = 'platform' AND platform IS NOT NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
               (scope_level = 'host' AND platform IS NULL AND host IS NOT NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
               (scope_level = 'workspace' AND platform IS NULL AND host IS NULL AND workspace IS NOT NULL AND repository IS NULL AND task_environment IS NULL) OR
               (scope_level = 'repository' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NOT NULL AND task_environment IS NULL) OR
               (scope_level = 'task_environment' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NOT NULL)),
        FOREIGN KEY (memory_id, previous_version_id) REFERENCES operational_memory_versions(memory_id, id) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE INDEX IF NOT EXISTS idx_op_versions_lineage ON operational_memory_versions(memory_id, created_at);
    `);
  },
  // #1379: AbmindService request idempotency ledger
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS abmind_service_requests (
        principal_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        method TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved','dispatch_started','completed','outcome_unknown')),
        response_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (principal_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_abmind_service_requests_retention
        ON abmind_service_requests(state, updated_at);
    `);
  },
  // #1477: preserve Discord snowflake message IDs losslessly.
  (db) => {
    const column = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string; type: string }>;
    const platformId = column.find((entry) => entry.name === "platform_message_id");
    if (!platformId || platformId.type.toUpperCase() === "TEXT") return;

    db.transaction(() => {
      db.exec("DROP INDEX IF EXISTS idx_messages_platform_id");
      db.exec("ALTER TABLE messages RENAME TO messages_platform_id_legacy");
      db.exec(`
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
          role TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL,
          platform_message_id TEXT, emotion_score INTEGER DEFAULT 0,
          type_hint TEXT, topic_hint TEXT, emotion_hint TEXT
        )
      `);
      db.exec(`
        INSERT INTO messages
          (id, user_id, session_id, role, content, timestamp, platform_message_id, emotion_score, type_hint, topic_hint, emotion_hint)
        SELECT id, user_id, session_id, role, content, timestamp,
          CASE WHEN platform_message_id IS NULL THEN NULL ELSE CAST(platform_message_id AS TEXT) END,
          emotion_score, type_hint, topic_hint, emotion_hint
        FROM messages_platform_id_legacy
      `);
      db.exec("DROP TABLE messages_platform_id_legacy");
      db.exec("CREATE INDEX idx_messages_platform_id ON messages(user_id, platform_message_id)");
    })();
  },
];

/** Resolve bundled templates/memory/core/ dir (works from src/ and dist/). */
function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ → up 1 to pkg root → templates/memory/core
  const srcSide = join(here, "..", "templates", "memory", "core");
  if (existsSync(srcSide)) return srcSide;
  // dist/src/ → up 2 to pkg root → templates/memory/core
  return join(here, "..", "..", "templates", "memory", "core");
}

/** Files in templates/memory/core/ that lazy-init must NOT seed. */
const LAZY_INIT_SKIP: ReadonlySet<string> = new Set([
  "SOUL.md", // personalized at install time via soul-seeder
]);

function ensureCoreFiles(dataDir: string): void {
  const tplDir = templatesDir();
  if (!existsSync(tplDir)) return;
  const coreDir = join(dataDir, "core");
  mkdirSync(coreDir, { recursive: true });

  for (const file of readdirSync(tplDir)) {
    if (LAZY_INIT_SKIP.has(file)) continue;
    const dst = join(coreDir, file);
    if (!existsSync(dst)) {
      copyFileSync(join(tplDir, file), dst);
    }
  }
}

function ensureSchema(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value)");
  const row = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  const current = parseInt(row?.value ?? "0", 10);
  const migrate = db.transaction(() => {
    if (current < MIGRATIONS.length) {
      for (let i = current; i < MIGRATIONS.length; i++) {
        MIGRATIONS[i]!(db);
      }
    }
    db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)").run(String(MIGRATIONS.length));
  });
  migrate();
}

export function ensureInitialized(db: Database.Database, dataDir: string): void {
  ensureCoreFiles(dataDir);
  ensureSchema(db);
}
