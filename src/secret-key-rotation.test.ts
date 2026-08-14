import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";
import { initializeDatabase } from "./memory-db.js";
import {
  rotateSecretsKeyOnOpen,
  recoverSecretKeyRotation,
} from "./secret-key-rotation.js";
import { loadKey, _resetKeyCache } from "./crypto.js";
import { _resetAbmindEnv } from "./env-schema.js";
import type Database from "better-sqlite3";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function purposeKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, "", purpose, 32));
}

function encryptWith(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return Buffer.concat([iv, enc, cipher.getAuthTag()]).toString("base64");
}

function decryptWith(blob: string, key: Buffer): string {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const d = createDecipheriv(ALGO, key, iv);
  d.setAuthTag(tag);
  return d.update(ct, undefined, "utf-8") + d.final("utf-8");
}

function writeEncFile(dir: string, name: string, plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const blob = "ENC:" + Buffer.concat([Buffer.from([0x01]), iv, enc, cipher.getAuthTag()]).toString("base64");
  const fp = join(dir, name);
  writeFileSync(fp, blob, { mode: 0o600 });
  return fp;
}

function readEncFile(fp: string, key: Buffer): string {
  const raw = readFileSync(fp, "utf-8").trim();
  const buf = Buffer.from(raw.slice(4), "base64");
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(1 + IV_LEN, buf.length - TAG_LEN);
  const d = createDecipheriv(ALGO, key, iv);
  d.setAuthTag(tag);
  return d.update(ct, undefined, "utf-8") + d.final("utf-8");
}

describe("#1660 secret key rotation", () => {
  let tmpDir: string;
  let db: Database.Database;
  let secretDir: string;

  beforeEach(() => {
    _resetKeyCache();
    _resetAbmindEnv();
    tmpDir = mkdtempSync(join(tmpdir(), "abmind-rotation-"));
    process.env["ABMIND_KEY_FILE"] = join(tmpDir, "secret", "abmind.key");
    process.env.ABMIND_USER_ID = "test";
    _resetAbmindEnv();
    db = initializeDatabase(join(tmpDir, "memory", "memory.db"));
    secretDir = join(tmpDir, "secrets");
    mkdirSync(secretDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    _resetKeyCache();
    delete process.env["ABMIND_KEY_FILE"];
    _resetAbmindEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedEncryptedRow(plaintext: string, key: Buffer): number {
    const info = db.prepare(
      `INSERT INTO extracted_memories
         (user_id, content_original, content_en, memory_type, source_timestamp,
          created_at, classification, encrypted, sealed_format_version)
       VALUES (?, ?, ?, 'fact', ?, ?, 3, 1, 1)`,
    ).run("test", encryptWith(plaintext, purposeKey(key, "abmind-secrets-v1")), "a label", 1000, 1000);
    return Number(info.lastInsertRowid);
  }

  it("rotates rows, file secrets and key material; old key no longer reads rows", () => {
    const oldKey = Buffer.from("ab".repeat(32), "hex");
    const newKey = Buffer.from("cd".repeat(32), "hex");
    const id = seedEncryptedRow("sk-or-v1-secret123", oldKey);
    writeEncFile(secretDir, "api-key.txt", "file-secret-value", purposeKey(oldKey, "abtars-secrets-files-v1"));

    const result = rotateSecretsKeyOnOpen(db, {
      dbPath: join(tmpDir, "memory", "memory.db"),
      oldMasterKey: oldKey,
      newMasterKey: newKey,
      writeKeyMaterial: true,
      secretDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.memoriesRotated).toBe(1);
      expect(result.filesRotated).toBe(1);
      expect(result.generation).toBe(2);
    }

    // Row readable under the new key only.
    const row = db.prepare("SELECT content_original FROM extracted_memories WHERE id = ?").get(id) as { content_original: string };
    const plain = decryptWith(row.content_original, purposeKey(newKey, "abmind-secrets-v1"));
    expect(plain).toBe("sk-or-v1-secret123");
    expect(() => decryptWith(row.content_original, purposeKey(oldKey, "abmind-secrets-v1"))).toThrow();

    // Labels, keywords, indexes untouched.
    expect((db.prepare("SELECT content_en FROM extracted_memories WHERE id = ?").get(id) as { content_en: string }).content_en).toBe("a label");

    // Generation advanced; staged files promoted; journal gone.
    expect((db.prepare("SELECT active_generation FROM secret_key_state WHERE singleton = 1").get() as { active_generation: number }).active_generation).toBe(2);
    const keyFile = join(tmpDir, "secret", "abmind.key");
    expect(readFileSync(keyFile, "utf-8").trim()).toBe(newKey.toString("hex"));
    expect(existsSync(join(tmpDir, "secret", "rotation-journal.json"))).toBe(false);
    expect(existsSync(join(tmpDir, "secret", "key.generation"))).toBe(true);

    // File secret re-encrypted under the new purpose key.
    const filePlain = readEncFile(join(secretDir, "api-key.txt"), purposeKey(newKey, "abtars-secrets-files-v1"));
    expect(filePlain).toBe("file-secret-value");
    expect(() => readEncFile(join(secretDir, "api-key.txt"), purposeKey(oldKey, "abtars-secrets-files-v1"))).toThrow();
  });

  it("rejects corrupt input with rollback: old key stays fully usable, no stage left", () => {
    const oldKey = Buffer.from("ab".repeat(32), "hex");
    const newKey = Buffer.from("cd".repeat(32), "hex");
    const id = seedEncryptedRow("value-1", oldKey);
    // Corrupt the ciphertext so decryption fails inside the DB transaction.
    db.prepare("UPDATE extracted_memories SET content_original = 'not-base64-ciphertext' WHERE id = ?").run(id);
    writeEncFile(secretDir, "api-key.txt", "file-secret-value", purposeKey(oldKey, "abtars-secrets-files-v1"));

    const result = rotateSecretsKeyOnOpen(db, {
      dbPath: join(tmpDir, "memory", "memory.db"),
      oldMasterKey: oldKey,
      newMasterKey: newKey,
      writeKeyMaterial: true,
      secretDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refused).toContain("refused");

    // Row untouched; generation unchanged; stage and journal gone.
    expect((db.prepare("SELECT semantic_revision FROM extracted_memories WHERE id = ?").get(id) as { semantic_revision: number }).semantic_revision).toBe(1);
    expect((db.prepare("SELECT active_generation FROM secret_key_state WHERE singleton = 1").get() as { active_generation: number }).active_generation).toBe(1);
    expect(existsSync(join(tmpDir, "secret", "rotation-journal.json"))).toBe(false);
    expect(existsSync(join(secretDir, "api-key.txt.staged"))).toBe(false);
  });

  it("recovers an interrupted rotation: DB committed → finish promotion (discard_stage and finish_new phases)", () => {
    const oldKey = Buffer.from("ab".repeat(32), "hex");
    const newKey = Buffer.from("cd".repeat(32), "hex");
    seedEncryptedRow("value-1", oldKey);
    writeEncFile(secretDir, "api-key.txt", "file-secret-value", purposeKey(oldKey, "abtars-secrets-files-v1"));

    // Phase A: journal present, DB not yet committed (generation still 1).
    const first = rotateSecretsKeyOnOpen(db, {
      dbPath: join(tmpDir, "memory", "memory.db"),
      oldMasterKey: oldKey,
      newMasterKey: newKey,
      writeKeyMaterial: true,
      secretDir,
    });
    expect(first.ok).toBe(true);

    // Simulate a crash AFTER the DB commit but BEFORE promotion by hand:
    // re-run rotation is refused while journal is gone... instead simulate by
    // directly writing a journal with generation 2 (DB already at 2) and a
    // staged key that differs from live.
    const keyFile = join(tmpDir, "secret", "abmind.key");
    const liveHex = readFileSync(keyFile, "utf-8").trim();
    const stagedFile = join(tmpDir, "secret", "abmind.key.staged");
    writeFileSync(stagedFile, "ff".repeat(32) + "\n", { mode: 0o600 });
    writeFileSync(join(tmpDir, "secret", "rotation-journal.json"), JSON.stringify({
      generation: 2,
      rows: [],
      files: [],
      stagedKey: true,
      stagedVerify: false,
      stagedKeyGen: false,
    }), { mode: 0o600 });

    // Recovery sees DB generation 2 == journal generation 2 → finish: staged
    // key becomes live.
    const finish = recoverSecretKeyRotation(db);
    expect(finish.state).toBe("finish_new");
    expect(readFileSync(keyFile, "utf-8").trim()).toBe("ff".repeat(32));
    expect(existsSync(join(tmpDir, "secret", "rotation-journal.json"))).toBe(false);

    // Phase B: journal present with DB at generation 1 (crash before commit).
    writeFileSync(stagedFile, "ee".repeat(32) + "\n", { mode: 0o600 });
    writeFileSync(join(tmpDir, "secret", "rotation-journal.json"), JSON.stringify({
      generation: 2,
      rows: [],
      files: [],
      stagedKey: true,
      stagedVerify: false,
      stagedKeyGen: false,
    }), { mode: 0o600 });

    // Generation is 2 now, so downgrade the journal scenario: write journal
    // generation 3 (DB at 2 → discard).
    writeFileSync(join(tmpDir, "secret", "rotation-journal.json"), JSON.stringify({
      generation: 3,
      rows: [],
      files: [],
      stagedKey: true,
      stagedVerify: false,
      stagedKeyGen: false,
    }), { mode: 0o600 });

    const discard = recoverSecretKeyRotation(db);
    expect(discard.state).toBe("discard_stage");
    expect(existsSync(stagedFile)).toBe(false);
    expect(existsSync(join(tmpDir, "secret", "rotation-journal.json"))).toBe(false);
    // Live key untouched.
    expect(readFileSync(keyFile, "utf-8").trim()).toBe("ff".repeat(32));
  });

  it("reports a backup-restore generation mismatch and refuses rotation until decided", () => {
    const oldKey = Buffer.from("ab".repeat(32), "hex");
    seedEncryptedRow("value-1", oldKey);
    // Restore scenario: DB says generation 1 but the on-disk key material is
    // generation 2 (sidecar written by a rotation of another DB).
    mkdirSync(join(tmpDir, "secret"), { recursive: true });
    writeFileSync(join(tmpDir, "secret", "key.generation"), "2\n", { mode: 0o600 });

    const rec = recoverSecretKeyRotation(db);
    expect(rec.state).toBe("mismatch");
    expect(rec.dbGeneration).toBe(1);
    expect(rec.keyGeneration).toBe(2);
    expect(rec.encryptedRowCount).toBe(1);

    const rotated = rotateSecretsKeyOnOpen(db, {
      dbPath: join(tmpDir, "memory", "memory.db"),
      oldMasterKey: oldKey,
      newMasterKey: Buffer.from("cd".repeat(32), "hex"),
      writeKeyMaterial: true,
    });
    expect(rotated.ok).toBe(false);
    if (!rotated.ok) expect(rotated.refused).toContain("refused");

    // Nothing was mutated.
    const row = db.prepare("SELECT content_original FROM extracted_memories").get() as { content_original: string };
    expect(decryptWith(row.content_original, purposeKey(oldKey, "abmind-secrets-v1"))).toBe("value-1");
  });

  it("keeps loadKey() consistent with the rotated key file after cache reset", () => {
    const oldKey = Buffer.from("ab".repeat(32), "hex");
    const newKey = Buffer.from("cd".repeat(32), "hex");
    seedEncryptedRow("value-1", oldKey);

    const result = rotateSecretsKeyOnOpen(db, {
      dbPath: join(tmpDir, "memory", "memory.db"),
      oldMasterKey: oldKey,
      newMasterKey: newKey,
      writeKeyMaterial: true,
    });
    expect(result.ok).toBe(true);

    _resetKeyCache();
    const loaded = loadKey();
    expect(loaded.toString("hex")).toBe(newKey.toString("hex"));
  });
});

describe("#1660 CLI-path trigger registration", () => {
  it("the exported rotateSecretsKey registers strip_diacritics so trigram triggers can fire", async () => {
    const { mkdtempSync, rmSync: rm, writeFileSync } = await import("node:fs");
    const { join: pjoin } = await import("node:path");
    const { tmpdir: osTmp } = await import("node:os");
    const { requireNativeDep } = await import("../cli/lib/native-dep.js");
    const dir = mkdtempSync(pjoin(osTmp(), "abmind-rot-reg-"));
    process.env["ABMIND_KEY_FILE"] = pjoin(dir, "secret", "abmind.key");
    _resetAbmindEnv();
    const dbPath = pjoin(dir, "memory.db");
    // Build the DB through the canonical initializer (registers functions),
    // then reopen it RAW exactly as the CLI does and exercise the exported
    // rotation entry — its UPDATE fires content_original_trigram_au.
    const rawDb = initializeDatabase(dbPath);
    const seedKey = Buffer.from("ab".repeat(32), "hex");
    rawDb.prepare(
      `INSERT INTO extracted_memories
         (user_id, content_original, content_en, memory_type, source_timestamp,
          created_at, classification, encrypted, sealed_format_version)
       VALUES ('test', ?, 'label', 'fact', 1000, 1000, 3, 1, 1)`,
    ).run(encryptWith("seeded-value", purposeKey(seedKey, "abmind-secrets-v1")));
    rawDb.close();

    const { rotateSecretsKey } = await import("./secret-key-rotation.js");
    const result = rotateSecretsKey({
      dbPath,
      oldMasterKey: seedKey,
      newMasterKey: Buffer.from("cd".repeat(32), "hex"),
      writeKeyMaterial: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.memoriesRotated).toBe(1);

    const verifyDb = initializeDatabase(dbPath);
    const row = verifyDb.prepare("SELECT content_original, semantic_revision FROM extracted_memories").get() as { content_original: string; semantic_revision: number };
    expect(row.semantic_revision).toBe(2);
    expect(decryptWith(row.content_original, purposeKey(Buffer.from("cd".repeat(32), "hex"), "abmind-secrets-v1"))).toBe("seeded-value");
    verifyDb.close();
    rm(dir, { recursive: true, force: true });
  });
});
