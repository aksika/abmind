#!/usr/bin/env node
/**
 * abmind list-secrets    — Show SECRET memory metadata.
 * abmind encrypt-secrets — Encrypt existing classification=3 rows.
 * abmind rekey --old-key <path> — Re-encrypt with new key.
 *
 * Action is passed as an explicit argument by the unified dispatcher
 * (see cli/abmind.ts). Previously smuggled via process.env["ABMIND_SECRET_ACTION"].
 */

import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { loadMemoryConfig } from "../src/memory-config.js";
import { encrypt, loadKey, loadKeyFromFile, decryptWithKey, hasKey } from "../src/crypto.js";

export type SecretsAction = "list" | "encrypt" | "rekey";

export function runSecretsCommand(action: SecretsAction): void {
  const config = loadMemoryConfig();
  const dbPath = join(config.memoryDir, "memory.db");
  const db = new Database(dbPath);

  try {
    if (action === "list") {
      const rows = db.prepare(
        "SELECT id, memory_type, created_at, emotion_tags, importance_flags, encrypted FROM extracted_memories WHERE classification = 3",
      ).all() as Array<{ id: number; memory_type: string; created_at: number; emotion_tags: string | null; importance_flags: string | null; encrypted: number }>;

      if (rows.length === 0) { console.log("No SECRET memories."); return; }

      console.log(`SECRET memories (${rows.length}):\n`);
      console.log("  ID  | Type       | Created              | Encrypted | Emotions         | Flags");
      console.log("------+------------+----------------------+-----------+------------------+------");
      for (const r of rows) {
        const date = new Date(r.created_at).toISOString().slice(0, 19).replace("T", " ");
        const enc = r.encrypted ? "yes" : "NO";
        console.log(`  ${String(r.id).padStart(3)} | ${(r.memory_type ?? "").padEnd(10)} | ${date} | ${enc.padEnd(9)} | ${(r.emotion_tags ?? "").padEnd(16)} | ${r.importance_flags ?? ""}`);
      }
    } else if (action === "encrypt") {
      if (!hasKey()) loadKey();

      const rows = db.prepare(
        "SELECT id, content_en, content_original FROM extracted_memories WHERE classification = 3 AND (encrypted = 0 OR encrypted IS NULL)",
      ).all() as Array<{ id: number; content_en: string; content_original: string }>;

      if (rows.length === 0) { console.log("All SECRET memories already encrypted."); return; }

      const tx = db.transaction(() => {
        for (const r of rows) {
          db.prepare("UPDATE extracted_memories SET content_en = ?, content_original = ?, encrypted = 1 WHERE id = ?")
            .run(encrypt(r.content_en), encrypt(r.content_original), r.id);
          db.prepare("INSERT INTO extracted_memories_fts(extracted_memories_fts, rowid, content_en) VALUES('delete', ?, ?)").run(r.id, "");
          db.prepare("DELETE FROM content_en_trigram WHERE rowid = ?").run(r.id);
          db.prepare("DELETE FROM content_original_trigram WHERE rowid = ?").run(r.id);
        }
      });
      tx();
      console.log(`Encrypted ${rows.length} SECRET memories.`);
    } else if (action === "rekey") {
      const oldKeyPath = process.argv.find((_, i, a) => a[i - 1] === "--old-key");
      if (!oldKeyPath) { console.error("Usage: abmind rekey --old-key <path-to-old-keyfile>"); process.exit(1); }

      const oldKey = loadKeyFromFile(oldKeyPath);
      loadKey();

      const rows = db.prepare(
        "SELECT id, content_en, content_original FROM extracted_memories WHERE encrypted = 1",
      ).all() as Array<{ id: number; content_en: string; content_original: string }>;

      if (rows.length === 0) { console.log("No encrypted memories to rekey."); return; }

      const tx = db.transaction(() => {
        for (const r of rows) {
          const plainEn = decryptWithKey(r.content_en, oldKey);
          const plainOrig = decryptWithKey(r.content_original, oldKey);
          db.prepare("UPDATE extracted_memories SET content_en = ?, content_original = ? WHERE id = ?")
            .run(encrypt(plainEn), encrypt(plainOrig), r.id);
        }
      });
      tx();
      console.log(`Re-encrypted ${rows.length} memories with new key.`);
    }
  } finally {
    db.close();
  }
}
