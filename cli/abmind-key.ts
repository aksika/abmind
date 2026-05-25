/**
 * abmind key — init, migrate, passwd subcommands (#607).
 */

import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto";
import { getAbmindEnv } from "../src/env-schema.js";
import { deriveFromPassphrase, writeKeyVerify, validateKey, loadKeyFromFile, _resetKeyCache } from "../src/crypto.js";
import { writeToKeyring } from "../src/keyring.js";

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

function keyPath(): string { return getAbmindEnv().keyFile; }

function decryptBlob(blob: string, key: Buffer): string {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, "utf-8") + decipher.final("utf-8");
}

function encryptBlob(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

async function keyInit(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const username = await ask(rl, "Username (used for encryption — same on all machines): ");
    if (!username.trim()) { console.error("Username cannot be empty."); process.exit(1); }
    const passphrase = await ask(rl, "Passphrase: ");
    if (passphrase.length < 6) { console.error("Passphrase too short (min 6 chars)."); process.exit(1); }
    const confirm = await ask(rl, "Confirm passphrase: ");
    if (passphrase !== confirm) { console.error("Passphrases don't match."); process.exit(1); }

    const key = deriveFromPassphrase(passphrase, username.trim());
    writeKeyVerify(key);

    const stored = writeToKeyring(passphrase);
    if (stored) console.log("✓ Passphrase stored in OS keyring.");
    else console.log("ℹ Keyring not available — use ABMIND_PASSPHRASE env var for daemon mode.");

    console.log("✓ Key initialized. Remember your username and passphrase.");
  } finally { rl.close(); }
}

async function keyMigrate(): Promise<void> {
  const keyFile = getAbmindEnv().keyFile;
  if (!existsSync(keyFile)) { console.error(`No existing key at ${keyFile}. Use 'abmind key init' instead.`); process.exit(1); }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const username = await ask(rl, "Username (used for encryption — same on all machines): ");
    if (!username.trim()) { console.error("Username cannot be empty."); process.exit(1); }
    const passphrase = await ask(rl, "New passphrase: ");
    if (passphrase.length < 6) { console.error("Passphrase too short (min 6 chars)."); process.exit(1); }
    const confirm = await ask(rl, "Confirm passphrase: ");
    if (passphrase !== confirm) { console.error("Passphrases don't match."); process.exit(1); }

    const oldKey = loadKeyFromFile(keyFile);
    const newKey = deriveFromPassphrase(passphrase, username.trim());

    // Re-encrypt SECRET memories
    const reEncrypted = await reEncryptSecrets(oldKey, newKey);

    writeKeyVerify(newKey);
    renameSync(keyFile, keyFile + ".backup");

    const stored = writeToKeyring(passphrase);
    if (stored) console.log("✓ Passphrase stored in OS keyring.");

    console.log(`✓ Migrated. ${reEncrypted} secrets re-encrypted. Old key backed up at ${keyFile}.backup`);
  } finally { rl.close(); }
}

async function keyPasswd(): Promise<void> {
  const verifyPath = join(dirname(getAbmindEnv().keyFile), "key.verify");
  if (!existsSync(verifyPath)) { console.error("No passphrase-mode key found. Run 'abmind key init' or 'abmind key migrate' first."); process.exit(1); }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const username = await ask(rl, "Username: ");
    const currentPass = await ask(rl, "Current passphrase: ");
    const oldKey = deriveFromPassphrase(currentPass, username.trim());
    if (!validateKey(oldKey)) { console.error("Wrong passphrase."); process.exit(1); }

    const newPass = await ask(rl, "New passphrase: ");
    if (newPass.length < 6) { console.error("Passphrase too short (min 6 chars)."); process.exit(1); }
    const confirm = await ask(rl, "Confirm new passphrase: ");
    if (newPass !== confirm) { console.error("Passphrases don't match."); process.exit(1); }

    const newKey = deriveFromPassphrase(newPass, username.trim());
    const reEncrypted = await reEncryptSecrets(oldKey, newKey);

    _resetKeyCache();
    writeKeyVerify(newKey);

    const stored = writeToKeyring(newPass);
    if (stored) console.log("✓ Passphrase updated in OS keyring.");

    console.log(`✓ Passphrase changed. ${reEncrypted} secrets re-encrypted.`);
  } finally { rl.close(); }
}

async function reEncryptSecrets(oldKey: Buffer, newKey: Buffer): Promise<number> {
  let count = 0;

  // 1. Re-encrypt DB memories (classification=3)
  try {
    const { getAbmindEnv: env } = await import("../src/env-schema.js");
    const dbPath = join(env().memoryDir, "memory.db");
    if (existsSync(dbPath)) {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath, { readonly: false });
      const rows = db.prepare("SELECT id, content FROM memories WHERE classification = 3 AND (content LIKE 'eyJ%' OR content LIKE 'eyA%')").all() as Array<{ id: number; content: string }>;
      const update = db.prepare("UPDATE memories SET content = ? WHERE id = ?");
      for (const row of rows) {
        try {
          const plaintext = decryptBlob(row.content, oldKey);
          update.run(encryptBlob(plaintext, newKey), row.id);
          count++;
        } catch { /* skip rows that fail */ }
      }
      db.close();
    }
  } catch { /* DB not available */ }

  // 2. Re-encrypt file-based secrets (~/.abtars/secret/)
  const { hkdfSync } = await import("node:crypto");
  const oldPurpose = Buffer.from(hkdfSync("sha256", oldKey, "", "abtars-secrets-files-v1", 32));
  const newPurpose = Buffer.from(hkdfSync("sha256", newKey, "", "abtars-secrets-files-v1", 32));
  const abtarsSecret = join(homedir(), ".abtars", "secret");
  if (existsSync(abtarsSecret)) {
    const { readdirSync, statSync } = await import("node:fs");
    for (const f of readdirSync(abtarsSecret)) {
      const fp = join(abtarsSecret, f);
      if (statSync(fp).isDirectory()) continue;
      const raw = readFileSync(fp, "utf-8").trim();
      if (!raw.startsWith("ENC:")) continue;
      try {
        const buf = Buffer.from(raw.slice(4), "base64");
        const iv = buf.subarray(1, 13);
        const tag = buf.subarray(buf.length - 16);
        const ciphertext = buf.subarray(13, buf.length - 16);
        const { createDecipheriv, createCipheriv, randomBytes } = await import("node:crypto");
        const decipher = createDecipheriv("aes-256-gcm", oldPurpose, iv);
        decipher.setAuthTag(tag);
        const plaintext = decipher.update(ciphertext, undefined, "utf-8") + decipher.final("utf-8");
        const newIv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", newPurpose, newIv);
        const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
        const newTag = cipher.getAuthTag();
        const blob = "ENC:" + Buffer.concat([Buffer.from([0x01]), newIv, encrypted, newTag]).toString("base64");
        writeFileSync(fp, blob, { mode: 0o600 });
        count++;
      } catch { /* skip files that fail */ }
    }
  }

  return count;
}

export function run(): void {
  const sub = process.argv[2];
  if (!sub || sub === "--help") {
    console.log("Usage: abmind key <init|migrate|passwd>\n");
    console.log("  init     Set up passphrase-based encryption (new installs)");
    console.log("  migrate  Migrate from random key file to passphrase");
    console.log("  passwd   Change passphrase");
    process.exit(0);
  }
  const cmd = { init: keyInit, migrate: keyMigrate, passwd: keyPasswd }[sub];
  if (!cmd) { console.error(`Unknown key subcommand: ${sub}`); process.exit(1); }
  cmd().catch(err => { console.error(err.message); process.exit(1); });
}
