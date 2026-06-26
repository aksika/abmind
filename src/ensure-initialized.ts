/**
 * ensure-initialized.ts — lazy runtime init for abmind (#427).
 *
 * Called on every MemoryManager.initialize(). Idempotent:
 * 1. Seeds missing core files from bundled templates
 * 2. Runs versioned schema migrations (additive only)
 *
 * Fast path (everything current): 1 SELECT + N existsSync = <1ms.
 * Pattern: idempotent seed + versioned migrations.
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { logInfo, logWarn } from "./mem-logger.js";

const MIGRATIONS: Array<(db: Database.Database) => void> = [
  // #824: recall quality feedback columns
  (db) => {
    try { db.exec("ALTER TABLE extracted_memories ADD COLUMN cited_count INTEGER DEFAULT 0"); } catch { /* exists */ }
    try { db.exec("ALTER TABLE extracted_memories ADD COLUMN rejected_count INTEGER DEFAULT 0"); } catch { /* exists */ }
  },
];

/** Resolve bundled templates/core/ dir (works from src/ and dist/). */
function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ → up 1 to pkg root → templates/core
  const srcSide = join(here, "..", "templates", "core");
  if (existsSync(srcSide)) return srcSide;
  // dist/src/ → up 2 to pkg root → templates/core
  return join(here, "..", "..", "templates", "core");
}

function ensureCoreFiles(dataDir: string): void {
  const tplDir = templatesDir();
  if (!existsSync(tplDir)) return;
  const coreDir = join(dataDir, "core");
  mkdirSync(coreDir, { recursive: true });

  // Read agentName from manifest for template substitution
  const manifestPath = join(dataDir, "..", "manifest.json");
  let agentName: string | null = null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    agentName = manifest.agentName ?? null;
  } catch { /* no manifest — fresh or corrupt */ }

  for (const file of readdirSync(tplDir)) {
    const dst = join(coreDir, file);
    if (!existsSync(dst)) {
      if (file === "SOUL.md" && agentName) {
        let content = readFileSync(join(tplDir, file), "utf-8");
        content = content.replaceAll("<agentName>", agentName);
        writeFileSync(dst, content, { mode: 0o600 });
      } else if (file === "SOUL.md" && !agentName) {
        logWarn("ensure-init", "No agentName in manifest — SOUL.md seeded with <agentName> placeholder. Run abmind install to fix.");
        copyFileSync(join(tplDir, file), dst);
      } else {
        copyFileSync(join(tplDir, file), dst);
      }
    }
  }
}

function ensureSchema(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)");
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
