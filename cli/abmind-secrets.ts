#!/usr/bin/env node
/**
 * abmind list-secrets    — Show SECRET memory metadata.
 * abmind encrypt-secrets — Reviewed legacy class-3 migration (dry-run first).
 * abmind rekey --old-key <path> — Re-encrypt with new key.
 *
 * Action is passed as an explicit argument by the unified dispatcher
 * (see cli/abmind.ts). Previously smuggled via process.env["ABMIND_SECRET_ACTION"].
 */

import { join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { requireNativeDep } from "./lib/native-dep.js";
const Database = requireNativeDep("better-sqlite3");
import { loadMemoryConfig } from "../src/memory-config.js";
import { registerFunctions } from "../src/memory-db.js";
import { loadKey, loadKeyFromFile } from "../src/crypto.js";
import { rotateSecretsKey } from "../src/secret-key-rotation.js";
import {
  inspectSealedMigration,
  applySealedMigration,
  type SealedMigrationDecision,
} from "../src/sealed-migration.js";
import { createBackup, verifyBackupFile } from "../src/backup.js";

export type SecretsAction = "list" | "encrypt" | "rekey";

export function runSecretsCommand(action: SecretsAction): void {
  const config = loadMemoryConfig();
  const dbPath = join(config.memoryDir, "memory.db");
  const db = new Database(dbPath);
  // #1660: the trigram triggers reference strip_diacritics/strip_emojis; the
  // CLI opens the DB directly, so the custom functions must be registered or
  // every UPDATE that fires a trigram trigger fails with
  // "no such function: strip_diacritics".
  registerFunctions(db);

  try {
    if (action === "list") {
      const rows = db.prepare(
        "SELECT id, memory_type, created_at, emotion_tags, importance_flags, encrypted, sealed_format_version FROM extracted_memories WHERE classification = 3",
      ).all() as Array<{ id: number; memory_type: string; created_at: number; emotion_tags: string | null; importance_flags: string | null; encrypted: number; sealed_format_version: number }>;

      if (rows.length === 0) { console.log("No SECRET memories."); return; }

      console.log(`SECRET memories (${rows.length}):\n`);
      console.log("  ID  | Type       | Created              | Sealed  | Emotions         | Flags");
      console.log("------+------------+----------------------+---------+------------------+------");
      for (const r of rows) {
        const date = new Date(r.created_at).toISOString().slice(0, 19).replace("T", " ");
        const sealed = r.encrypted && r.sealed_format_version === 1 ? "v1" : r.encrypted ? "v0-enc" : "PLAIN";
        console.log(`  ${String(r.id).padStart(3)} | ${(r.memory_type ?? "").padEnd(10)} | ${date} | ${sealed.padEnd(7)} | ${(r.emotion_tags ?? "").padEnd(16)} | ${r.importance_flags ?? ""}`);
      }
    } else if (action === "encrypt") {
      runEncryptMigration(db, config.memoryDir, dbPath);
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
      console.log(`Re-encrypted ${result.memoriesRotated} memories with the active key (generation ${result.generation}).`);
    }
  } finally {
    db.close();
  }
}

function runEncryptMigration(db: InstanceType<typeof Database>, memoryDir: string, dbPath: string): void {
  const argv = process.argv.slice(2);
  const decisionsIdx = argv.indexOf("--decisions");
  const decisionsPath = decisionsIdx >= 0 && argv[decisionsIdx + 1] ? argv[decisionsIdx + 1]! : null;
  const apply = argv.includes("--apply");

  // Metadata-only dry run: ids/revisions/format booleans — never content.
  const plan = inspectSealedMigration(db);
  if (plan.candidates.length === 0) {
    console.log("No legacy class-3 rows require migration.");
    return;
  }

  if (!decisionsPath) {
    console.log(`Legacy class-3 rows requiring a decision (${plan.candidates.length}):`);
    for (const c of plan.candidates) {
      console.log(`  #${c.memoryId} rev=${c.semanticRevision} encrypted=${c.encrypted} format=${c.sealedFormatVersion}${c.encrypted === 0 ? " (plaintext value)" : ""}`);
    }
    console.log(plan.ftsIntegrityOk ? "FTS integrity-check: OK" : "FTS integrity-check: FAILED (apply rebuilds the index once)");
    console.log("\nProvide --decisions <0600-json> to review, --decisions <file> --apply to run.");
    return;
  }

  let mode: number;
  try {
    mode = statSync(decisionsPath).mode & 0o777;
  } catch {
    console.error(`Decision file not found: ${decisionsPath}`);
    process.exit(1);
  }
  if (mode !== 0o600) {
    console.error(`Decision file must be 0600 (found ${mode.toString(8)}): ${decisionsPath}`);
    process.exit(1);
  }
  let decisions: SealedMigrationDecision[];
  try {
    const raw = JSON.parse(readFileSync(decisionsPath, "utf-8")) as unknown;
    if (!Array.isArray(raw)) throw new Error("decisions must be a JSON array");
    decisions = raw as SealedMigrationDecision[];
  } catch (err) {
    console.error(`Invalid decisions file: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!apply) {
    // Review run: per-decision effect without writing anything.
    const byId = new Map(plan.candidates.map((c) => [c.memoryId, c]));
    console.log(`Decision review against ${plan.candidates.length} candidates:`);
    for (const d of decisions) {
      const candidate = byId.get(d.memoryId);
      console.log(`  #${d.memoryId}: ${d.action}${candidate ? ` (current rev ${candidate.semanticRevision})` : " — NOT A CANDIDATE"}`);
    }
    for (const c of plan.candidates) {
      if (!decisions.some((d) => d.memoryId === c.memoryId)) {
        console.log(`  #${c.memoryId}: MISSING decision`);
      }
    }
    return;
  }

  // Apply: create and verify an encrypted backup before any mutation.
  const backupPath = join(memoryDir, "..", "backups", `sealed-migration-${Date.now()}.abm`);
  try {
    createBackup(db, memoryDir, undefined, backupPath, { dbOnly: true });
  } catch (err) {
    console.error(`Backup creation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!verifyBackupFile(backupPath)) {
    console.error(`Backup verification failed: ${backupPath}`);
    process.exit(1);
  }

  const outcome = applySealedMigration(db, decisions, { verifiedBackup: true });
  if (!outcome.ok) {
    console.error(outcome.refused);
    process.exit(1);
  }
  console.log(`Migrated: sealed=${outcome.sealed.length} declassified=${outcome.declassified.length} quarantined=${outcome.quarantined.length}${outcome.ftsRebuilt ? " (FTS rebuilt)" : ""}`);
  console.log(`Backup: ${backupPath}`);
}
