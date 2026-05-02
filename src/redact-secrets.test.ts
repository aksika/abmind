import { describe, it, expect } from "vitest";
import { redactSecrets, SECRET_PATTERNS } from "./redact-secrets.js";

describe("redactSecrets", () => {
  it("redacts OpenAI-style keys (sk-...)", () => {
    const input = "request failed with key sk-abcdef1234567890abcdef1234567890";
    const out = redactSecrets(input);
    expect(out).toContain("sk-***REDACTED***");
    expect(out).not.toContain("sk-abcdef1234567890abcdef1234567890");
  });

  it("redacts sk_live and sk_test Stripe keys", () => {
    const live = redactSecrets("stripe key sk_live_abcdef1234567890abcdef");
    const test = redactSecrets("stripe key sk_test_abcdef1234567890abcdef");
    expect(live).toContain("sk_live_***REDACTED***");
    expect(test).toContain("sk_test_***REDACTED***");
  });

  it("redacts GitHub classic PATs (ghp_...)", () => {
    const input = "auth: ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(redactSecrets(input)).toContain("ghp_***REDACTED***");
  });

  it("redacts GitHub fine-grained PATs (github_pat_...)", () => {
    const input = "auth: github_pat_abcdefghijklmnopqrst_uvwxyz";
    expect(redactSecrets(input)).toContain("github_pat_***REDACTED***");
  });

  it("redacts Slack tokens (xoxb-, xoxp-, etc.)", () => {
    const input = "token xoxb-1234567890-abcdef";
    expect(redactSecrets(input)).toContain("xox_-***REDACTED***");
  });

  it("redacts Google API keys (AIza...)", () => {
    const input = "key AIzaSyAbcdefghijklmnop_qrstuvwxyz01234";
    expect(redactSecrets(input)).toContain("AIza***REDACTED***");
  });

  it("redacts AWS access keys (AKIA...)", () => {
    const input = "aws AKIAIOSFODNN7EXAMPLE running";
    expect(redactSecrets(input)).toContain("AKIA***REDACTED***");
  });

  it("redacts Telegram bot tokens (digits:letters)", () => {
    const input = "bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawXYZ";
    expect(redactSecrets(input)).toContain("***BOT_TOKEN***");
  });

  it("redacts Bearer auth headers", () => {
    const input = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz";
    expect(redactSecrets(input)).toContain("Bearer ***REDACTED***");
  });

  it("redacts HuggingFace tokens (hf_...)", () => {
    const input = "hf_abcdefghijklmnopqrstu";
    expect(redactSecrets(input)).toContain("hf_***REDACTED***");
  });

  it("redacts npm tokens (npm_...)", () => {
    const input = "npm_abcdefghijklmnopqrstu";
    expect(redactSecrets(input)).toContain("npm_***REDACTED***");
  });

  it("redacts SendGrid keys (SG....)", () => {
    const input = "SG.abcdefghijklmnopqrstu";
    expect(redactSecrets(input)).toContain("SG.***REDACTED***");
  });

  it("redacts JSON-shaped credentials (api_key, token, secret, password, authorization)", () => {
    const input = '{"api_key":"supersecretvalue123","other":"ok"}';
    const out = redactSecrets(input);
    expect(out).toContain('"api_key":"***REDACTED***"');
    expect(out).not.toContain("supersecretvalue123");
  });

  it("redacts env-var-style credentials (KEY=, TOKEN=, SECRET=, PASSWORD=)", () => {
    const input = "OPENAI_API_KEY=verysecretvalue123456";
    expect(redactSecrets(input)).toContain("OPENAI_API_KEY=***REDACTED***");
  });

  it("is idempotent — redacting twice produces the same output", () => {
    const input = "sk-abcdef1234567890abcdef1234567890 and ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const once = redactSecrets(input);
    const twice = redactSecrets(once);
    expect(twice).toBe(once);
  });

  it("returns unchanged text when no patterns match", () => {
    const input = "this is a perfectly normal sentence with no secrets";
    expect(redactSecrets(input)).toBe(input);
  });

  it("returns empty string when input is empty", () => {
    expect(redactSecrets("")).toBe("");
  });

  it("exposes SECRET_PATTERNS as an array", () => {
    expect(Array.isArray(SECRET_PATTERNS)).toBe(true);
    expect(SECRET_PATTERNS.length).toBeGreaterThan(0);
  });
});
