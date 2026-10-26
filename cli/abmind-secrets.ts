#!/usr/bin/env node
/**
 * abmind list-secrets    — Show sealed durable metadata.
 * abmind rekey --old-key <path> — Re-encrypt with new key.
 *
 * Action is passed as an explicit argument by the unified dispatcher
 * (see cli/abmind.ts). Previously smuggled via process.env["ABMIND_SECRET_ACTION"].
 * The reviewed legacy class-3 migration (encrypt-secrets) is retired with
 * the legacy table (#1939 stage 3).
 */

import { join } from "node:path";
import { requireNativeDep } from "./lib/native-dep.js";
const Database = requireNativeDep("better-sqlite3");
import { loadMemoryConfig } from "../src/memory-config.js";
import { loadKey, loadKeyFromFile } from "../src/crypto.js";
import { rotateSecretsKey } from "../src/secret-key-rotation.js";

export type SecretsAction = "list" | "rekey";

export function runSecretsCommand(action: SecretsAction): void {
  const config = loadMemoryConfig();
  const dbPath = join(config.memoryDir, "memory.db");
  const db = new Database(dbPath);

  try {
    if (action === "list") {
      const rows = db.prepare(
        "SELECT id, memory_type, created_at, revision, encrypted, sealed_format_version FROM long_term_memories WHERE classification >= 3 AND superseded_by_id IS NULL",
      ).all() as Array<{ id: number; memory_type: string; created_at: number; revision: number; encrypted: number; sealed_format_version: number }>;

      if (rows.length === 0) { console.log("No SECRET memories."); return; }

      console.log(`SECRET memories (${rows.length}):\n`);
      console.log("  ID  | Type       | Created              | Sealed  | Rev");
      console.log("------+------------+----------------------+---------+-----");
      for (const r of rows) {
        const date = new Date(r.created_at).toISOString().slice(0, 19).replace("T", " ");
        const sealed = r.encrypted && r.sealed_format_version === 1 ? "v1" : r.encrypted ? "v0-enc" : "PLAIN";
        console.log(`  ${String(r.id).padStart(3)} | ${(r.memory_type ?? "").padEnd(10)} | ${date} | ${sealed.padEnd(7)} | ${r.revision}`);
      }
    } else if (action === "rekey") {
      const oldKeyPath = process.argv.find((_, i, a) => a[i - 1] === "--old-key");
      if (!oldKeyPath) { console.error("Usage: abmind rekey --old-key <path-to-old-keyfile>"); process.exit(1); }

      // #1660: journaled rotation — re-encrypts only encrypted content_original
      // under the active key, preserving labels, keywords and indexes.
      const oldKey = loadKeyFromFile(oldKeyPath);
      const newKey = loadKey();
      const result = rotateSecretsKey({
        dbPath,
        oldMasterKey: oldKey,
        newMasterKey: newKey,
        writeKeyMaterial: false,
      });
      if (!result.ok) {
        console.error(result.refused);
        process.exit(1);
      }
      console.log(`Re-encrypted ${result.personalRotated} sealed durables with the active key (generation ${result.generation}).`);
    }
  } finally {
    db.close();
  }
}

