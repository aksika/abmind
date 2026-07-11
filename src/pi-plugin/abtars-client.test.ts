import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

const FIXED_SIGNING_KEY = "MC4CAQAwBQYDK2VwBCIEIMpFWz2hNcBs246s1mKzY77q922hxHVnP2C+RtQWVi9A";
const FIXED_KEY_ID = "eded156be7f98b56";

let TMP_HOME: string;
const ORIG_HOME = process.env["HOME"];

beforeEach(() => {
  vi.resetModules();
  TMP_HOME = join(tmpdir(), `pi-client-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TMP_HOME, { recursive: true });
  process.env["HOME"] = TMP_HOME;
});

afterEach(() => {
  process.env["HOME"] = ORIG_HOME;
  delete process.env["AGENT_API_PORT"];
  rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("checkPiClient", () => {
  it("returns unavailable when no credential file exists", async () => {
    const { checkPiClient } = await import("./abtars-client.js");
    const state = checkPiClient();
    expect(state.available).toBe(false);
    expect(state.reason).toBe("no-credential");
  });

  it("returns available when credential file exists", async () => {
    const credDir = join(TMP_HOME, ".abtars", "clients", "pi");
    mkdirSync(credDir, { recursive: true });
    writeFileSync(
      join(credDir, "credential.json"),
      JSON.stringify({
        version: 1,
        clientId: "pi-local",
        keyId: FIXED_KEY_ID,
        signingKey: FIXED_SIGNING_KEY,
        createdAt: new Date().toISOString(),
      }),
    );
    const { checkPiClient } = await import("./abtars-client.js");
    const state = checkPiClient();
    expect(state.available).toBe(true);
  });
});

describe("piRequest", () => {
  it("returns no_credential when no credential file", async () => {
    const { piRequest } = await import("./abtars-client.js");
    const resp = await piRequest("GET", "/v1/pi/status");
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe("no_credential");
    }
  });

  it("returns connection_failed when bridge is not running", async () => {
    const credDir = join(TMP_HOME, ".abtars", "clients", "pi");
    mkdirSync(credDir, { recursive: true });
    writeFileSync(
      join(credDir, "credential.json"),
      JSON.stringify({
        version: 1,
        clientId: "pi-local",
        keyId: FIXED_KEY_ID,
        signingKey: FIXED_SIGNING_KEY,
        createdAt: new Date().toISOString(),
      }),
    );
    // Use an unused port to ensure connection refused
    process.env["AGENT_API_PORT"] = "18799";
    const { piRequest } = await import("./abtars-client.js");
    const resp = await piRequest("GET", "/v1/pi/status");
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe("connection_failed");
      expect(resp.error.retryable).toBe(true);
    }
    delete process.env["AGENT_API_PORT"];
  });
});
