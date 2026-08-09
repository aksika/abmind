import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMasterUserId, ensurePrimaryUserId } from "./user-utils.js";
import { _resetAbmindEnv } from "./env-schema.js";
describe("loadMasterUserId", () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;
  const originalBridgeHome = process.env.ABMIND_HOME;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "user-utils-"));
    process.env.ABMIND_HOME = tmpDir;
    delete process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.ABMIND_HOME = originalBridgeHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns master userId from users.json", () => {
    const configDir = join(tmpDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "users.json"), JSON.stringify({
      users: [
        { userId: "alice", role: "master", maxClass: 3, platforms: {} },
        { userId: "bob", role: "user", maxClass: 1, platforms: {} },
      ],
    }));
    expect(loadMasterUserId()).toBe("alice");
  });

  it("returns 'master' when users.json missing", () => {
    expect(loadMasterUserId()).toBe("master");
  });

  it("returns 'master' when no master role in users.json", () => {
    const configDir = join(tmpDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "users.json"), JSON.stringify({
      users: [{ userId: "bob", role: "user", maxClass: 1, platforms: {} }],
    }));
    expect(loadMasterUserId()).toBe("master");
  });

  it("returns 'master' when users.json is invalid JSON", () => {
    const configDir = join(tmpDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "users.json"), "not json");
    expect(loadMasterUserId()).toBe("master");
  });
  it("uses configDir param when provided", () => {
    const customDir = join(tmpDir, "custom");
    mkdirSync(customDir, { recursive: true });
    writeFileSync(join(customDir, "users.json"), JSON.stringify({
      users: [{ userId: "custom-master", role: "master", maxClass: 3, platforms: {} }],
    }));
    expect(loadMasterUserId(customDir)).toBe("custom-master");
  });

  describe("ensurePrimaryUserId (#1608)", () => {
    const originalEnv = process.env.ABMIND_USER_ID;
    let homeDir: string;

    beforeEach(() => {
      _resetAbmindEnv();
      homeDir = join(tmpDir, "home");
      mkdirSync(homeDir, { recursive: true });
    });

    afterEach(() => {
      _resetAbmindEnv();
      if (originalEnv === undefined) delete process.env.ABMIND_USER_ID;
      else process.env.ABMIND_USER_ID = originalEnv;
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
});
