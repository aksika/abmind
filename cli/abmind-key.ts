/**
 * abmind key — init, migrate, passwd subcommands (#607).
 */

import { createInterface } from "node:readline";
import { existsSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAbmindEnv } from "../src/env-schema.js";
import { deriveFromPassphrase, writeKeyVerify, validateKey, loadKeyFromFile, _resetKeyCache, encrypt, decrypt } from "../src/crypto.js";
import { writeToKeyring } from "../src/keyring.js";

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
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
  try {
    const { getAbmindEnv: env } = await import("../src/env-schema.js");
    const dbPath = join(env().memoryDir, "memory.db");
    if (!existsSync(dbPath)) return 0;

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath, { readonly: false });
    const rows = db.prepare("SELECT id, content FROM memories WHERE classification = 3 AND content LIKE 'eyJ%' OR content LIKE 'eyA%'").all() as Array<{ id: number; content: string }>;

    let count = 0;
    const update = db.prepare("UPDATE memories SET content = ? WHERE id = ?");
    for (const row of rows) {
      try {
        // Decrypt with old key
        const { createDecipheriv, createCipheriv, randomBytes } = await import("node:crypto");
        const buf = Buffer.from(row.content, "base64");
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(buf.length - 16);
        const ciphertext = buf.subarray(12, buf.length - 16);
        const decipher = createDecipheriv("aes-256-gcm", oldKey, iv);
        decipher.setAuthTag(tag);
        const plaintext = decipher.update(ciphertext) + decipher.final("utf-8");

        // Encrypt with new key
        const newIv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", newKey, newIv);
        const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
        const newTag = cipher.getAuthTag();
        const newBlob = Buffer.concat([newIv, encrypted, newTag]).toString("base64");

        update.run(newBlob, row.id);
        count++;
      } catch { /* skip rows that fail to decrypt — may not be encrypted */ }
    }
    db.close();
    return count;
  } catch { return 0; }
}

export function run(): void {
  const sub = process.argv[3];
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
