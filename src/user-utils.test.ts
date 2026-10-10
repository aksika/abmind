import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrimaryUserId } from "./user-utils.js";
import { _resetAbmindEnv } from "./env-schema.js";

// #1384: the legacy users.json/master guess (loadMasterUserId and its
// "master" fallback) is removed — no caller may substitute a placeholder
// principal. The canonical identity below is the only runtime path.
describe("ensurePrimaryUserId (#1608)", () => {
  let tmpDir: string;
  let homeDir: string;
  const originalEnv = process.env.ABMIND_USER_ID;
  const originalHome = process.env.HOME;
  const originalBridgeHome = process.env.ABMIND_HOME;

  beforeEach(() => {
    _resetAbmindEnv();
    tmpDir = mkdtempSync(join(tmpdir(), "user-utils-"));
    process.env.ABMIND_HOME = tmpDir;
    delete process.env.HOME;
    homeDir = join(tmpDir, "home");
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    _resetAbmindEnv();
    if (originalEnv === undefined) delete process.env.ABMIND_USER_ID;
    else process.env.ABMIND_USER_ID = originalEnv;
    process.env.HOME = originalHome;
    process.env.ABMIND_HOME = originalBridgeHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the explicit ABMIND_USER_ID and never overwrites it", () => {
    process.env.ABMIND_USER_ID = "explicit-user";
    writeFileSync(join(homeDir, "manifest.json"), JSON.stringify({
      package: "abmind",
      version: "0.0.0",
      encryptionUser: "saved-master",
    }));
    expect(ensurePrimaryUserId(homeDir)).toBe("explicit-user");
    expect(process.env.ABMIND_USER_ID).toBe("explicit-user");
  });

  it("initializes ABMIND_USER_ID from the saved manifest encryptionUser when the env var is absent", () => {
    delete process.env.ABMIND_USER_ID;
    writeFileSync(join(homeDir, "manifest.json"), JSON.stringify({
      package: "abmind",
      version: "0.0.0",
      encryptionUser: "aksika",
    }));
    expect(ensurePrimaryUserId(homeDir)).toBe("aksika");
    expect(process.env.ABMIND_USER_ID).toBe("aksika");
  });

  it("returns null and leaves the env var unset when no identity is configured", () => {
    delete process.env.ABMIND_USER_ID;
    expect(ensurePrimaryUserId(homeDir)).toBeNull();
    expect(process.env.ABMIND_USER_ID).toBeUndefined();
  });
});
