/**
 * abmind passwd — change encryption passphrase.
 * Re-encrypts: DB memories (classification=3) + file-based secrets.
 * #1660: both go through the journaled rotation coordinator.
 */

import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { deriveFromPassphrase, validateKey, loadKeyFromFile, _resetKeyCache } from "../src/crypto.js";

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

const { printBanner } = await import("./banner.js");
await printBanner("passwd");

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

  // #1660: journaled, all-or-nothing rotation. DB rows, file secrets and key
  // material share one recovery journal; a failure keeps the old key usable.
  const { rotateSecretsKey } = await import("../src/secret-key-rotation.js");
  const dbPath = join(abmindHome, "memory", "memory.db");
  const result = rotateSecretsKey({
    dbPath,
    oldMasterKey: oldKey,
    newMasterKey: newKey,
    writeKeyMaterial: true,
    secretDir: existsSync(secretDir) ? secretDir : undefined,
  });
  if (!result.ok) {
    console.error(result.refused);
    process.exit(1);
  }
  const dbCount = result.memoriesRotated;
  const fileCount = result.filesRotated;

  // Finalize
  _resetKeyCache();
  let stored = false;
  try { const kr = await import("../src/keyring.js"); stored = kr.writeToKeyring(newPass); } catch { /* optional */ }

  console.log(`✓ Done. ${dbCount} memories + ${fileCount} secrets re-encrypted.`);
  console.log(`\nKey saved to ${keyFile} (daemon uses this automatically).`);
  if (stored) console.log("✓ Passphrase also stored in OS keyring.");
  else console.log(`If running without disk access (containers, CI), export ABMIND_KEY=${newKey.toString("hex")} instead.`);
} finally { rl.close(); }
