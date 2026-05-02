import { getAbmindEnv } from "./env-schema.js";
/**
 * AES-256-GCM encryption for SECRET (classification=3) memories.
 * Key: 32 random bytes stored as 64 hex chars in abmind.key.
 */

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function keyPath(): string {
  return getAbmindEnv().keyFile;
}

function backupKeyPath(): string {
  return getAbmindEnv().keyFile;
}

/** Load or generate the encryption key. Cached per process. */
export function loadKey(): Buffer {
  if (cachedKey) return cachedKey;

  const path = keyPath();
  if (existsSync(path)) {
    cachedKey = Buffer.from(readFileSync(path, "utf-8").trim(), "hex");
    return cachedKey;
  }

  // Generate new key
  const key = randomBytes(32);
  const hex = key.toString("hex");

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, hex + "\n", { mode: 0o600 });

  // Copy to abmind backup
  const backup = backupKeyPath();
  try {
    if (existsSync(dirname(backup))) {
      copyFileSync(path, backup);
    }
  } catch { /* backup dir may not exist */ }

  cachedKey = key;
  return cachedKey;
}

/** Returns true if a key file exists (without loading it). */
export function hasKey(): boolean {
  return existsSync(keyPath()) || cachedKey !== null;
}

/** Encrypt plaintext. Returns base64(iv + ciphertext + authTag). */
export function encrypt(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

/** Decrypt base64(iv + ciphertext + authTag). Returns plaintext. */
export function decrypt(blob: string): string {
  const key = loadKey();
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
}
