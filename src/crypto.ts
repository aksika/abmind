import { getAbmindEnv } from "./env-schema.js";
/**
 * AES-256-GCM encryption for SECRET (classification=3) memories.
 * Master key: either passphrase-derived (scrypt) or legacy random bytes.
 * Purpose-specific keys derived via HKDF with unique salts.
 */

import { randomBytes, createCipheriv, createDecipheriv, hkdfSync, scryptSync, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { readFromKeyring } from "./keyring.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const VERIFY_PLAINTEXT = "abmind-verify";

let cachedKey: Buffer | null = null;
const derivedCache = new Map<string, Buffer>();

function keyPath(): string {
  return getAbmindEnv().keyFile;
}

function verifyPath(): string {
  return join(dirname(keyPath()), "key.verify");
}

/** Derive a 32-byte key from passphrase + username via scrypt. */
export function deriveFromPassphrase(passphrase: string, username: string): Buffer {
  const salt = createHash("sha256").update(`abmind:${username}`).digest().subarray(0, 16);
  return scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 }) as Buffer;
}

/** Create key.verify file (encrypt known plaintext with the derived key). */
export function writeKeyVerify(key: Buffer): void {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(VERIFY_PLAINTEXT, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, encrypted, tag]).toString("base64");
  const dir = dirname(verifyPath());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(verifyPath(), blob, { mode: 0o600 });
}

/** Validate a key against key.verify. Returns true if passphrase is correct. */
export function validateKey(key: Buffer): boolean {
  try {
    const blob = readFileSync(verifyPath(), "utf-8").trim();
    const buf = Buffer.from(blob, "base64");
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const result = decipher.update(ciphertext) + decipher.final("utf-8");
    return result === VERIFY_PLAINTEXT;
  } catch {
    return false;
  }
}

/** Resolve passphrase from env → keyring → null. */
function resolvePassphrase(): string | null {
  const env = getAbmindEnv();
  if (env.passphrase) return env.passphrase;
  // Daemon mode on Linux: skip keyring (no desktop session)
  if (!process.stdin.isTTY && process.platform === "linux") return null;
  const fromKeyring = readFromKeyring();
  if (fromKeyring) return fromKeyring;
  return null;
}

/** Resolve username from env → user_profile.md → null. */
function resolveUsername(): string | null {
  const env = getAbmindEnv();
  if (env.username) return env.username;
  try {
    const profilePath = join(dirname(dirname(keyPath())), "memory", "core", "user_profile.md");
    const content = readFileSync(profilePath, "utf-8");
    const match = content.match(/^Name:\s*(.+)/m);
    if (match?.[1]) return match[1].trim();
  } catch { /* profile may not exist */ }
  return null;
}

/** Load or generate the encryption key. Cached per process. */
export function loadKey(): Buffer {
  if (cachedKey) return cachedKey;

  // Option 1: Key file on disk (daemon mode — fast, no derivation)
  const path = keyPath();
  if (existsSync(path)) {
    const hex = readFileSync(path, "utf-8").trim();
    if (hex.length === 64) {
      cachedKey = Buffer.from(hex, "hex");
      return cachedKey;
    }
  }

  // Option 2: ABMIND_KEY env var (pre-derived hex key)
  const keyHex = process.env["ABMIND_KEY"]?.trim();
  if (keyHex && keyHex.length === 64) {
    const key = Buffer.from(keyHex, "hex");
    if (existsSync(verifyPath()) && !validateKey(key)) {
      throw new Error("ABMIND_KEY env var present but key.verify validation failed — wrong key.");
    }
    cachedKey = key;
    return cachedKey;
  }

  // Option 3: Passphrase mode (ABTARS_PASS env var or keyring)
  if (existsSync(verifyPath())) {
    const passphrase = resolvePassphrase();
    if (!passphrase) {
      throw new Error("No encryption key available. Provide ~/.abmind/secret/abmind.key, ABMIND_KEY env, or ABTARS_PASS env.");
    }
    const username = resolveUsername();
    if (!username) {
      throw new Error("Username required for key derivation. Set ABMIND_USER env var.");
    }
    const key = deriveFromPassphrase(passphrase, username);
    if (!validateKey(key)) {
      throw new Error("Wrong passphrase — key.verify validation failed.");
    }
    cachedKey = key;
    return cachedKey;
  }

  // Generate new random key (standalone users without onboarding)
  const key = randomBytes(32);
  const hex = key.toString("hex");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, hex + "\n", { mode: 0o600 });
  cachedKey = key;
  return cachedKey;
}

/** Returns true if a key file exists (without loading it). */
export function hasKey(): boolean {
  return existsSync(keyPath()) || cachedKey !== null;
}

/** Derive a purpose-specific key from the master key via HKDF. Cached per process. */
export function deriveKey(purpose: string): Buffer {
  const cached = derivedCache.get(purpose);
  if (cached) return cached;
  const master = loadKey();
  const derived = Buffer.from(hkdfSync("sha256", master, "", purpose, 32));
  derivedCache.set(purpose, derived);
  return derived;
}

/** Get the secrets encryption key (for DB class=3 memories). */
export function getSecretsKey(): Buffer { return deriveKey("abmind-secrets-v1"); }

/** Get the backup encryption key. */
export function getBackupKey(): Buffer { return deriveKey("abmind-backup-v1"); }

/** Encrypt plaintext using the derived secrets key. Returns base64(iv + ciphertext + authTag). */
export function encrypt(plaintext: string): string {
  const key = getSecretsKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

/** Decrypt base64(iv + ciphertext + authTag) using the derived secrets key. Returns plaintext. */
export function decrypt(blob: string): string {
  const key = getSecretsKey();
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf-8");
}

/** Load a key from a specific file path (for rekey). */
export function loadKeyFromFile(path: string): Buffer {
  return Buffer.from(readFileSync(path, "utf-8").trim(), "hex");
}

/** Decrypt using a specific key (for rekey). */
export function decryptWithKey(blob: string, key: Buffer): string {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf-8");
}

/** Reset cached key (for testing). */
export function _resetKeyCache(): void {
  cachedKey = null;
  derivedCache.clear();
}
