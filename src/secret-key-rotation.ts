/**
 * secret-key-rotation.ts — journaled, crash-recoverable rotation of the
 * secrets master key (#1660).
 *
 * Both `abmind passwd` (passphrase change, DB + file secrets + key material)
 * and `abmind rekey --old-key` (DB rows only, key file unchanged) route
 * through this coordinator. The DB transaction is bound to
 * `secret_key_state.active_generation`, staged files are promoted only after
 * the DB commit, and a 0600 journal makes interruption deterministic:
 *
 *   - DB generation == journal.generation        → finish: promote staged files
 *   - DB generation == journal.generation - 1    → discard: keep the old key
 *   - anything else, or mismatch with no journal → report, refuse rotation
 *
 * A restored backup can move `active_generation` backwards relative to the
 * on-disk key material; that is a reported operator decision, never an
 * auto-finished rotation.
 */

import type Database from "better-sqlite3";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  hkdfSync,
} from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  chmodSync,
  readdirSync,
  statSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { requireNativeDep } from "../cli/lib/native-dep.js";
import { getAbmindEnv } from "./env-schema.js";
import { registerFunctions } from "./memory-db.js";
import { logInfo, logError } from "./mem-logger.js";

const TAG = "secret-key-rotation";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const DB_PURPOSE = "abmind-secrets-v1";
const FILE_PURPOSE = "abtars-secrets-files-v1";
const VERIFY_PLAINTEXT = "abmind-verify";

export type RotationRequest = {
  /** Absolute path to memory.db. */
  dbPath: string;
  /** Current master key (decrypts existing rows). */
  oldMasterKey: Buffer;
  /** New master key (re-encrypts rows). */
  newMasterKey: Buffer;
  /**
   * true for passphrase rotation: stage + promote `abmind.key`,
   * `key.verify` and `key.generation`. false for `rekey --old-key`, where the
   * key file is unchanged and the operation is one atomic DB transaction.
   */
  writeKeyMaterial: boolean;
  /**
   * Directory with ENC:-prefixed file secrets to re-encrypt (passwd only).
   * File secrets use the `abtars-secrets-files-v1` purpose under both keys.
   */
  secretDir?: string;
  /**
   * Validate the old key before staging (passphrase mode validates against
   * key.verify). Throws on mismatch.
   */
  verifyOldKey?: () => void;
};

export type RotationResult =
  | { ok: true; memoriesRotated: number; filesRotated: number; generation: number }
  | { ok: false; refused: string };

export type RecoveryReport = {
  state: "clean" | "finish_new" | "discard_stage" | "mismatch" | "refused";
  dbGeneration?: number;
  keyGeneration?: number;
  encryptedRowCount?: number;
  reason?: string;
};

type Journal = {
  generation: number;
  rows: Array<{ id: number; userId: string; revision: number }>;
  files: string[];
  stagedKey: boolean;
  stagedVerify: boolean;
  stagedKeyGen: boolean;
};

// ── Paths and small helpers ─────────────────────────────────────────────────

function keyPath(): string {
  return getAbmindEnv().keyFile;
}

function secretPaths() {
  const dir = dirname(keyPath());
  return {
    dir,
    keyFile: keyPath(),
    verifyFile: join(dir, "key.verify"),
    keyGenFile: join(dir, "key.generation"),
    journalFile: join(dir, "rotation-journal.json"),
  };
}

function stagedPath(target: string): string {
  return `${target}.staged`;
}

function encryptWith(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

function decryptWith(blob: string, key: Buffer): string {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf-8");
}

function purposeKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, "", purpose, 32));
}

function write0600(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

function readDbGeneration(db: Database.Database): number {
  const row = db.prepare("SELECT active_generation FROM secret_key_state WHERE singleton = 1").get() as { active_generation: number } | undefined;
  return row?.active_generation ?? 1;
}

function readKeyGeneration(): number {
  const { keyGenFile } = secretPaths();
  if (!existsSync(keyGenFile)) return 1;
  const parsed = parseInt(readFileSync(keyGenFile, "utf-8").trim(), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

function writeVerifyBlobTo(path: string, key: Buffer): void {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(VERIFY_PLAINTEXT, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, encrypted, tag]).toString("base64");
  write0600(path, blob);
}

function readJournal(): Journal | null {
  const { journalFile } = secretPaths();
  if (!existsSync(journalFile)) return null;
  try {
    return JSON.parse(readFileSync(journalFile, "utf-8")) as Journal;
  } catch (err) {
    logError(TAG, `Unreadable rotation journal at ${journalFile}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function removeJournal(): void {
  const { journalFile } = secretPaths();
  if (existsSync(journalFile)) unlinkSync(journalFile);
}

function stageList(files: string[]): void {
  for (const file of files) {
    const staged = stagedPath(file);
    if (existsSync(staged)) unlinkSync(staged);
  }
}

function promoteStage(): void {
  const paths = secretPaths();
  for (const [live, staged] of [
    [paths.keyFile, stagedPath(paths.keyFile)],
    [paths.verifyFile, stagedPath(paths.verifyFile)],
    [paths.keyGenFile, stagedPath(paths.keyGenFile)],
  ] as const) {
    if (existsSync(staged)) {
      renameSync(staged, live);
    }
  }
}

function removeStaged(): void {
  const paths = secretPaths();
  for (const file of [paths.keyFile, paths.verifyFile, paths.keyGenFile]) {
    const staged = stagedPath(file);
    if (existsSync(staged)) unlinkSync(staged);
  }
}

function encryptedRowCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) as c FROM extracted_memories WHERE encrypted = 1").get() as { c: number }).c;
}

// ── Recovery ────────────────────────────────────────────────────────────────

/**
 * Settle any interrupted rotation. Called at startup and before the next
 * rotation. Never loads the key and never auto-resolves a mismatch.
 */
export function recoverSecretKeyRotation(db: Database.Database): RecoveryReport {
  const dbGeneration = readDbGeneration(db);
  const journal = readJournal();

  if (journal) {
    if (dbGeneration === journal.generation) {
      // DB commit landed; the staged key material must become live.
      promoteStage();
      for (const file of journal.files) {
        const staged = stagedPath(file);
        if (existsSync(staged)) renameSync(staged, file);
      }
      stageList(journal.files);
      removeJournal();
      logInfo(TAG, `Finished interrupted key rotation (generation ${journal.generation})`);
      return { state: "finish_new", dbGeneration, keyGeneration: readKeyGeneration(), encryptedRowCount: encryptedRowCount(db) };
    }
    if (dbGeneration === journal.generation - 1) {
      // DB never committed; the old key remains active. Discard the stage.
      removeStaged();
      for (const file of journal.files) {
        const staged = stagedPath(file);
        if (existsSync(staged)) unlinkSync(staged);
      }
      removeJournal();
      logInfo(TAG, `Discarded interrupted key rotation stage (generation ${journal.generation})`);
      return { state: "discard_stage", dbGeneration, keyGeneration: readKeyGeneration(), encryptedRowCount: encryptedRowCount(db) };
    }
    removeJournal();
    logError(TAG, `Inconsistent rotation journal: DB generation ${dbGeneration}, journal generation ${journal.generation}`);
    return {
      state: "refused",
      dbGeneration,
      keyGeneration: readKeyGeneration(),
      encryptedRowCount: encryptedRowCount(db),
      reason: `rotation journal generation ${journal.generation} does not match DB generation ${dbGeneration}`,
    };
  }

  // No journal: the DB generation must agree with the on-disk key material.
  const keyGeneration = readKeyGeneration();
  if (keyGeneration !== dbGeneration) {
    return {
      state: "mismatch",
      dbGeneration,
      keyGeneration,
      encryptedRowCount: encryptedRowCount(db),
      reason: `DB active_generation ${dbGeneration} differs from key material generation ${keyGeneration} — restored backup or replaced key; rotation stays refused`,
    };
  }
  return { state: "clean", dbGeneration, keyGeneration, encryptedRowCount: encryptedRowCount(db) };
}

// ── Rotation ────────────────────────────────────────────────────────────────

/**
 * Rotate the secrets key. All-or-nothing for the selected DB rows; staged
 * file/key promotion happens only after the DB commit. Throws on any
 * stale/corrupt input — the old key stays active and the stage is discarded.
 */
export function rotateSecretsKey(req: RotationRequest): RotationResult {
  const Database = requireNativeDep("better-sqlite3") as typeof import("better-sqlite3");
  const db = new Database(req.dbPath);
  // #1660: the content_original trigram trigger references the custom
  // strip_diacritics function; without registration every rotation UPDATE
  // fails with "no such function: strip_diacritics".
  registerFunctions(db);
  try {
    return rotateSecretsKeyOnOpen(db, req);
  } finally {
    db.close();
  }
}

/** Rotation against an already-open Database handle (used by tests). */
export function rotateSecretsKeyOnOpen(db: Database.Database, req: RotationRequest): RotationResult {
  const dbGeneration = readDbGeneration(db);

  const rec = recoverSecretKeyRotation(db);
  if (rec.state === "mismatch" || rec.state === "refused") {
    return { ok: false, refused: rec.reason ?? "previous rotation requires an operator decision" };
  }

  if (req.verifyOldKey) {
    try {
      req.verifyOldKey();
    } catch (err) {
      return { ok: false, refused: err instanceof Error ? err.message : String(err) };
    }
  }

  // A stage (journal) only exists when key material or file secrets must be
  // promoted after the DB commit. `rekey --old-key` changes the key file
  // material not at all: it is one atomic DB transaction, the generation
  // stays aligned with the unchanged on-disk key, and no journal is written.
  const hasStage = req.writeKeyMaterial || (req.secretDir !== undefined && existsSync(req.secretDir));
  const nextGeneration = hasStage ? dbGeneration + 1 : dbGeneration;
  const oldDbKey = purposeKey(req.oldMasterKey, DB_PURPOSE);
  const newDbKey = purposeKey(req.newMasterKey, DB_PURPOSE);

  const rows = db.prepare(
    "SELECT id, user_id, semantic_revision, content_original, encrypted FROM extracted_memories WHERE encrypted = 1 ORDER BY id",
  ).all() as Array<{ id: number; user_id: string; semantic_revision: number; content_original: string; encrypted: number }>;

  // Stage file secrets first (0600), decrypt-only — no DB writes yet.
  const stagedFiles: string[] = [];
  if (req.secretDir && existsSync(req.secretDir)) {
    const oldFileKey = purposeKey(req.oldMasterKey, FILE_PURPOSE);
    const newFileKey = purposeKey(req.newMasterKey, FILE_PURPOSE);
    for (const f of readdirSync(req.secretDir)) {
      const fp = join(req.secretDir, f);
      if (statSync(fp).isDirectory()) continue;
      const raw = readFileSync(fp, "utf-8").trim();
      if (!raw.startsWith("ENC:")) continue;
      let plain: string;
      try {
        const buf = Buffer.from(raw.slice(4), "base64");
        const iv = buf.subarray(1, 1 + IV_LEN);
        const tag = buf.subarray(buf.length - TAG_LEN);
        const ct = buf.subarray(1 + IV_LEN, buf.length - TAG_LEN);
        const decipher = createDecipheriv(ALGO, oldFileKey, iv);
        decipher.setAuthTag(tag);
        plain = decipher.update(ct, undefined, "utf-8") + decipher.final("utf-8");
      } catch (err) {
        throw new Error(`file secret ${f} is not decryptable with the old key — rotation refused (${err instanceof Error ? err.message : "decrypt failed"})`);
      }
      const iv = randomBytes(IV_LEN);
      const cipher = createCipheriv(ALGO, newFileKey, iv);
      const enc = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
      const blob = "ENC:" + Buffer.concat([Buffer.from([0x01]), iv, enc, cipher.getAuthTag()]).toString("base64");
      write0600(stagedPath(fp), blob);
      stagedFiles.push(fp);
    }
  }

  // Stage key material (passphrase rotation only).
  if (req.writeKeyMaterial) {
    write0600(stagedPath(secretPaths().keyFile), req.newMasterKey.toString("hex") + "\n");
    writeVerifyBlobTo(stagedPath(secretPaths().verifyFile), req.newMasterKey);
    write0600(stagedPath(secretPaths().keyGenFile), `${nextGeneration}\n`);
  }

  // Journal (0600, content-free entries: ids + revisions only) when there is
  // anything to promote after the DB commit.
  if (hasStage) {
    const journalEntry: Journal = {
      generation: nextGeneration,
      rows: rows.map((r) => ({ id: r.id, userId: r.user_id, revision: r.semantic_revision })),
      files: stagedFiles,
      stagedKey: req.writeKeyMaterial,
      stagedVerify: req.writeKeyMaterial,
      stagedKeyGen: req.writeKeyMaterial,
    };
    write0600(secretPaths().journalFile, JSON.stringify(journalEntry, null, 2));
    // Force journal durability before the DB transaction.
    try {
      const fd = openSync(secretPaths().journalFile, "r+");
      fsyncSync(fd);
      closeSync(fd);
    } catch { /* journal already written; fsync best-effort */ }
  }

  // One DB transaction: verify each row, decrypt with old key, encrypt with
  // new key, bump revision, advance the generation (staged rotations only).
  let memoriesRotated = 0;
  try {
    const txn = db.transaction(() => {
      const verify = db.prepare(
        "SELECT id FROM extracted_memories WHERE id = ? AND user_id = ? AND semantic_revision = ? AND encrypted = 1",
      );
      const update = db.prepare(
        "UPDATE extracted_memories SET content_original = ?, semantic_revision = semantic_revision + 1 WHERE id = ? AND user_id = ? AND semantic_revision = ? AND encrypted = 1",
      );
      for (const row of rows) {
        if (!verify.get(row.id, row.user_id, row.semantic_revision)) {
          throw new Error(`row ${row.id} changed since staging (owner/revision/encryption CAS failed)`);
        }
        const plain = decryptWith(row.content_original, oldDbKey);
        update.run(encryptWith(plain, newDbKey), row.id, row.user_id, row.semantic_revision);
        memoriesRotated++;
      }
      if (hasStage) {
        db.prepare("UPDATE secret_key_state SET active_generation = ? WHERE singleton = 1").run(nextGeneration);
      }
    });
    txn();
  } catch (err) {
    // Roll back the stage: the old key remains fully usable.
    removeStaged();
    stageList(stagedFiles);
    removeJournal();
    const message = err instanceof Error ? err.message : String(err);
    logError(TAG, `Key rotation refused, old key retained: ${message}`);
    return { ok: false, refused: `rotation refused, old key retained: ${message}` };
  }

  // DB commit landed. Verify every selected row decrypts with the new key.
  for (const row of rows) {
    const fresh = db.prepare(
      "SELECT content_original FROM extracted_memories WHERE id = ? AND user_id = ?",
    ).get(row.id, row.user_id) as { content_original: string } | undefined;
    if (!fresh) {
      logError(TAG, `Row ${row.id} vanished after rotation commit — manual review required`);
      return { ok: false, refused: `row ${row.id} vanished after rotation commit` };
    }
    try {
      decryptWith(fresh.content_original, newDbKey);
    } catch (err) {
      logError(TAG, `Row ${row.id} not decryptable with the new key after commit — manual review required`);
      return { ok: false, refused: `row ${row.id} is not decryptable with the new key` };
    }
  }

  // Promote staged files only after the DB commit.
  try {
    promoteStage();
    for (const file of stagedFiles) {
      renameSync(stagedPath(file), file);
    }
    removeJournal();
  } catch (err) {
    logError(TAG, `Staged files could not be promoted: ${err instanceof Error ? err.message : String(err)} — recovery will finish the rotation on next start`);
    // Journal remains; startup recovery finishes the promotion.
  }

  logInfo(TAG, `Key rotation complete: ${memoriesRotated} memories, ${stagedFiles.length} file secrets → generation ${nextGeneration}`);
  return {
    ok: true,
    memoriesRotated,
    filesRotated: stagedFiles.length,
    generation: nextGeneration,
  };
}
