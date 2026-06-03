/**
 * abmind passwd — change encryption passphrase.
 */

import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { deriveFromPassphrase, validateKey, writeKeyVerify } from "../src/crypto.js";
import { packagePaths, readManifest } from "../src/deploy-lib/index.js";

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => { rl.question(question, a => { rl.close(); resolve(a.trim()); }); });
}

const paths = packagePaths("abmind");
const manifest = await readManifest(paths.manifest);
const encryptionUser: string = (manifest as any)?.encryptionUser ?? process.env["USER"] ?? "default";
const keyPath = join(paths.home, "secret", "abmind.key");

// Get old + new passphrase (positional or interactive)
const args = process.argv.slice(2);
let oldPass = args[0];
let newPass = args[1];

if (!oldPass) oldPass = await prompt("Current passphrase: ");
if (!oldPass) { console.error("Error: passphrase required"); process.exit(1); }

// Verify old passphrase
const oldKey = deriveFromPassphrase(oldPass, encryptionUser);
let valid = validateKey(oldKey);
if (!valid) {
  // Fallback: compare against key file
  try {
    const stored = readFileSync(keyPath, "utf-8").trim();
    valid = oldKey.toString("hex") === stored;
  } catch { /* key file missing */ }
}
if (!valid) { console.error("Error: wrong passphrase"); process.exit(1); }

if (!newPass) {
  newPass = await prompt("New passphrase: ");
  const confirm = await prompt("Confirm new passphrase: ");
  if (newPass !== confirm) { console.error("Error: passphrases do not match"); process.exit(1); }
}
if (!newPass) { console.error("Error: new passphrase required"); process.exit(1); }

// Derive new key and overwrite
const newKey = deriveFromPassphrase(newPass, encryptionUser);
writeFileSync(keyPath, newKey.toString("hex"), { mode: 0o600 });
writeKeyVerify(newKey);
try { const kr = await import("../src/keyring.js"); kr.writeToKeyring(newPass); } catch { /* optional */ }

console.log("✓ passphrase changed");
