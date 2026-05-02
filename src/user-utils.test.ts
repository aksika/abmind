import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMasterUserId } from "./user-utils.js";

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
});
