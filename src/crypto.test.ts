import { _resetAbmindEnv } from "./env-schema.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encrypt, decrypt, loadKey, hasKey, _resetKeyCache, loadKeyFromFile, decryptWithKey, getSecretsKey } from "./crypto.js";

describe("crypto", () => {
  let tmpDir: string;
  const origEnv = process.env["ABMIND_KEY_FILE"];

  beforeEach(() => {
    _resetKeyCache();
    tmpDir = mkdtempSync(join(tmpdir(), "abmind-crypto-"));
    process.env["ABMIND_KEY_FILE"] = join(tmpDir, "test.key");
    _resetAbmindEnv();
  });

  afterEach(() => {
    _resetKeyCache();
    if (origEnv) process.env["ABMIND_KEY_FILE"] = origEnv;
    else delete process.env["ABMIND_KEY_FILE"];
    _resetAbmindEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates key on first load", () => {
    const key = loadKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it("returns same key on second load", () => {
    const k1 = loadKey();
    const k2 = loadKey();
    expect(k1).toBe(k2); // same reference (cached)
  });

  it("reads existing key from file", () => {
    const hex = "a".repeat(64);
    writeFileSync(join(tmpDir, "test.key"), hex + "\n");
    const key = loadKey();
    expect(key.toString("hex")).toBe(hex);
  });

  it("hasKey returns false before generation", () => {
    expect(hasKey()).toBe(false);
  });

  it("hasKey returns true after generation", () => {
    loadKey();
    expect(hasKey()).toBe(true);
  });

  it("encrypt/decrypt roundtrip", () => {
    const plaintext = "sk-proj-abc123-secret-api-key";
    const blob = encrypt(plaintext);
    expect(blob).not.toBe(plaintext);
    expect(decrypt(blob)).toBe(plaintext);
  });

  it("encrypt produces different ciphertext each time (random IV)", () => {
    const text = "same input";
    const a = encrypt(text);
    const b = encrypt(text);
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(text);
    expect(decrypt(b)).toBe(text);
  });

  it("decrypt fails with wrong key", () => {
    const blob = encrypt("secret");
    _resetKeyCache();
    // Generate a new key
    process.env["ABMIND_KEY_FILE"] = join(tmpDir, "other.key");
    _resetAbmindEnv();
    expect(() => decrypt(blob)).toThrow();
  });

  it("decrypt fails with tampered ciphertext", () => {
    const blob = encrypt("secret");
    const buf = Buffer.from(blob, "base64");
    buf[20] ^= 0xff; // flip a byte
    expect(() => decrypt(buf.toString("base64"))).toThrow();
  });

  it("handles empty string", () => {
    const blob = encrypt("");
    expect(decrypt(blob)).toBe("");
  });

  it("handles unicode content", () => {
    const text = "Titkos jelszó: 🔑 パスワード";
    expect(decrypt(encrypt(text))).toBe(text);
  });

  it("loadKeyFromFile reads a specific key", () => {
    const hex = "b".repeat(64);
    const path = join(tmpDir, "old.key");
    writeFileSync(path, hex + "\n");
    const key = loadKeyFromFile(path);
    expect(key.toString("hex")).toBe(hex);
  });

  it("decryptWithKey uses provided key", () => {
    const key = getSecretsKey();
    const blob = encrypt("test");
    expect(decryptWithKey(blob, key)).toBe("test");
  });
});

describe("passphrase derivation", () => {
  let tmpDir: string;
  const origKeyFile = process.env["ABMIND_KEY_FILE"];
  const origPassphrase = process.env["ABMIND_PASSPHRASE"];
  const origUser = process.env["ABMIND_USER"];

  beforeEach(() => {
    _resetKeyCache();
    tmpDir = mkdtempSync(join(tmpdir(), "abmind-passphrase-"));
    process.env["ABMIND_KEY_FILE"] = join(tmpDir, "secret", "abmind.key");
    _resetAbmindEnv();
  });

  afterEach(() => {
    _resetKeyCache();
    if (origKeyFile) process.env["ABMIND_KEY_FILE"] = origKeyFile; else delete process.env["ABMIND_KEY_FILE"];
    if (origPassphrase) process.env["ABMIND_PASSPHRASE"] = origPassphrase; else delete process.env["ABMIND_PASSPHRASE"];
    if (origUser) process.env["ABMIND_USER"] = origUser; else delete process.env["ABMIND_USER"];
    _resetAbmindEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deriveFromPassphrase produces deterministic 32-byte key", async () => {
    const { deriveFromPassphrase } = await import("./crypto.js");
    const k1 = deriveFromPassphrase("mypass", "aksika");
    const k2 = deriveFromPassphrase("mypass", "aksika");
    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(true);
  });

  it("different username produces different key", async () => {
    const { deriveFromPassphrase } = await import("./crypto.js");
    const k1 = deriveFromPassphrase("mypass", "aksika");
    const k2 = deriveFromPassphrase("mypass", "other");
    expect(k1.equals(k2)).toBe(false);
  });

  it("writeKeyVerify + validateKey round-trip", async () => {
    const { deriveFromPassphrase, writeKeyVerify, validateKey } = await import("./crypto.js");
    mkdirSync(join(tmpDir, "secret"), { recursive: true });
    const key = deriveFromPassphrase("testpass", "testuser");
    writeKeyVerify(key);
    expect(validateKey(key)).toBe(true);
  });

  it("wrong passphrase fails validation", async () => {
    const { deriveFromPassphrase, writeKeyVerify, validateKey } = await import("./crypto.js");
    mkdirSync(join(tmpDir, "secret"), { recursive: true });
    const correctKey = deriveFromPassphrase("correct", "user");
    writeKeyVerify(correctKey);
    const wrongKey = deriveFromPassphrase("wrong", "user");
    expect(validateKey(wrongKey)).toBe(false);
  });

  it("loadKey in passphrase mode works via env vars", async () => {
    const { deriveFromPassphrase, writeKeyVerify } = await import("./crypto.js");
    mkdirSync(join(tmpDir, "secret"), { recursive: true });
    const key = deriveFromPassphrase("envpass", "envuser");
    writeKeyVerify(key);
    _resetKeyCache();
    process.env["ABMIND_PASSPHRASE"] = "envpass";
    process.env["ABMIND_USER"] = "envuser";
    _resetAbmindEnv();
    const loaded = loadKey();
    expect(loaded.equals(key)).toBe(true);
  });
});
