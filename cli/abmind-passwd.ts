/**
 * abmind passwd — change encryption passphrase.
 * Re-encrypts: DB memories (classification=3) + file-based secrets.
 */

import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createDecipheriv, createCipheriv, randomBytes, hkdfSync } from "node:crypto";
import { deriveFromPassphrase, validateKey, writeKeyVerify, loadKeyFromFile, _resetKeyCache } from "../src/crypto.js";

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: abmind passwd [--secrets-dir <path>]\n\nChange encryption passphrase. Re-encrypts DB secrets + file secrets.\n\nOptions:\n  --secrets-dir <path>  Directory with ENC: files (default: ~/.abtars/secret)");
  process.exit(0);
}

const sdIdx = args.indexOf("--secrets-dir");
const secretDir: string = sdIdx >= 0 && args[sdIdx + 1]
  ? args[sdIdx + 1]!
  : join(process.env["ABTARS_HOME"] ?? join(homedir(), ".abtars"), "secret");

process.stdout.write(`abmind passwd\n\n`);

const abmindHome = process.env["ABMIND_HOME"] ?? join(homedir(), ".abmind");
const keyFile = join(abmindHome, "secret", "abmind.key");
const verifyFile = join(abmindHome, "secret", "key.verify");
const manifestPath = join(abmindHome, "manifest.json");

// Read username from manifest (fixed salt — not user input)
let username: string;
try {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  username = manifest.encryptionUser;
  if (!username) throw new Error("encryptionUser not set");
  console.log(`Using identity: ${username}`);
} catch {
  console.error("⚠️  manifest.json not found or missing encryptionUser — enter username manually.");
  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  username = await ask(rl2, "Username: ");
  rl2.close();
  if (!username.trim()) { console.error("Username cannot be empty."); process.exit(1); }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  let oldKey: Buffer;
  if (existsSync(keyFile)) {
    oldKey = loadKeyFromFile(keyFile);
  } else {
    const oldPass = await ask(rl, "Current passphrase (empty = abort): ");
    if (!oldPass) { console.error("No key file and no passphrase."); process.exit(1); }
    oldKey = deriveFromPassphrase(oldPass, username.trim());
    if (!existsSync(verifyFile)) { console.error("No key.verify file — cannot validate."); process.exit(1); }
    if (!validateKey(oldKey)) { console.error("Wrong passphrase."); process.exit(1); }
  }

  const newPass = await ask(rl, "New passphrase (min 6 chars): ");
  if (newPass.length < 6) { console.error("Too short."); process.exit(1); }
  const confirm = await ask(rl, "Confirm: ");
  if (newPass !== confirm) { console.error("Mismatch."); process.exit(1); }

  const newKey = deriveFromPassphrase(newPass, username.trim());

  // Re-encrypt DB memories (classification=3)
  let dbCount = 0;
  try {
    const memDir = abmindHome;
    const dbPath = join(memDir, "memory", "memory.db");
    if (existsSync(dbPath)) {
      const oldDbKey = Buffer.from(hkdfSync("sha256", oldKey, "", "abmind-secrets-v1", 32));
      const newDbKey = Buffer.from(hkdfSync("sha256", newKey, "", "abmind-secrets-v1", 32));
      const { loadNative } = await import("../src/native-loader.js");
      const Database = loadNative("better-sqlite3") as any;
      const db = new Database(dbPath, { readonly: false });
      const rows = db.prepare("SELECT id, content_en FROM extracted_memories WHERE classification = 3").all() as Array<{ id: number; content_en: string }>;
      const update = db.prepare("UPDATE extracted_memories SET content_en = ? WHERE id = ?");
      for (const row of rows) {
        try {
          const buf = Buffer.from(row.content_en, "base64");
          const iv = buf.subarray(0, 12);
          const tag = buf.subarray(buf.length - 16);
          const ct = buf.subarray(12, buf.length - 16);
          const d = createDecipheriv("aes-256-gcm", oldDbKey, iv);
          d.setAuthTag(tag);
          const plain = d.update(ct, undefined, "utf-8") + d.final("utf-8");
          const newIv = randomBytes(12);
          const c = createCipheriv("aes-256-gcm", newDbKey, newIv);
          const enc = Buffer.concat([c.update(plain, "utf-8"), c.final()]);
          update.run(Buffer.concat([newIv, enc, c.getAuthTag()]).toString("base64"), row.id);
          dbCount++;
        } catch { /* skip corrupted */ }
      }
      db.close();
    }
  } catch { /* DB not available */ }

  // Re-encrypt file-based secrets
  let fileCount = 0;
  if (existsSync(secretDir)) {
    const oldPurpose = Buffer.from(hkdfSync("sha256", oldKey, "", "abtars-secrets-files-v1", 32));
    const newPurpose = Buffer.from(hkdfSync("sha256", newKey, "", "abtars-secrets-files-v1", 32));
    for (const f of readdirSync(secretDir)) {
      const fp = join(secretDir, f);
      if (statSync(fp).isDirectory()) continue;
      const raw = readFileSync(fp, "utf-8").trim();
      if (!raw.startsWith("ENC:")) continue;
      try {
        const buf = Buffer.from(raw.slice(4), "base64");
        const iv = buf.subarray(1, 13);
        const tag = buf.subarray(buf.length - 16);
        const ct = buf.subarray(13, buf.length - 16);
        const d = createDecipheriv("aes-256-gcm", oldPurpose, iv);
        d.setAuthTag(tag);
        const plain = d.update(ct, undefined, "utf-8") + d.final("utf-8");
        const newIv = randomBytes(12);
        const c = createCipheriv("aes-256-gcm", newPurpose, newIv);
        const enc = Buffer.concat([c.update(plain, "utf-8"), c.final()]);
        const blob = "ENC:" + Buffer.concat([Buffer.from([0x01]), newIv, enc, c.getAuthTag()]).toString("base64");
        writeFileSync(fp, blob, { mode: 0o600 });
        fileCount++;
      } catch { /* skip */ }
    }
  }

  // Finalize
  _resetKeyCache();
  writeFileSync(keyFile, newKey.toString("hex") + "\n", { mode: 0o600 });
  writeKeyVerify(newKey);
  let stored = false;
  try { const kr = await import("../src/keyring.js"); stored = kr.writeToKeyring(newPass); } catch { /* optional */ }

  console.log(`✓ Done. ${dbCount} memories + ${fileCount} secrets re-encrypted.`);
  console.log(`\nKey saved to ${keyFile} (daemon uses this automatically).`);
  if (stored) console.log("✓ Passphrase also stored in OS keyring.");
  else console.log(`If running without disk access (containers, CI), export ABMIND_KEY=${newKey.toString("hex")} instead.`);
} finally { rl.close(); }
