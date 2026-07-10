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
  if (current < MIGRATIONS.length) {
    for (let i = current; i < MIGRATIONS.length; i++) {
      MIGRATIONS[i]!(db);
    }
  }
  db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)").run(String(MIGRATIONS.length));
}

export function ensureInitialized(db: Database.Database, dataDir: string): void {
  ensureCoreFiles(dataDir);
  ensureSchema(db);
}
