import { describe, it, expect } from "vitest";
import { fingerprint } from "./request-fingerprint.js";

describe("fingerprint", () => {
  it("returns a deterministic one-way truncated SHA-256 digest", () => {
    expect(fingerprint("idem-key-1", 8)).toBe(fingerprint("idem-key-1", 8));
    expect(fingerprint("idem-key-1", 8)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("differs for different inputs at the same truncation", () => {
    expect(fingerprint("key-a", 8)).not.toBe(fingerprint("key-b", 8));
  });

  it("respects the requested truncation length", () => {
    expect(fingerprint("secret", 16)).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint("secret", 16).startsWith(fingerprint("secret", 8))).toBe(true);
  });

  it("never reveals the input", () => {
    const value = "super-secret-idempotency-key";
    expect(fingerprint(value, 8)).not.toContain(value);
  });
});
