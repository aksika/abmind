import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { acquireLock, releaseLock, generateLockToken, LockError } from "./shared-native-deps-lock.js";
import { readManifest, createEmptyManifest, writeManifest, resolveCompatibility, addConsumer, removeConsumer } from "./shared-native-deps-manifest.js";

let tmpHome: string;

describe("shared-native-deps", () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "native-deps-test-"));
    process.env["AB_SHARED_DEPS_ROOT"] = tmpHome;
  });

  afterEach(() => {
    delete process.env["AB_SHARED_DEPS_ROOT"];
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe("lock", () => {
    it("acquires and releases a lock", () => {
      const token = generateLockToken();
      acquireLock("abtars", "test", token);
      expect(existsSync(join(tmpHome, LOCK_DIR_NAME))).toBe(true);
      releaseLock(token);
      expect(existsSync(join(tmpHome, LOCK_DIR_NAME))).toBe(false);
    });

    it("detects concurrent locks", () => {
      const t1 = generateLockToken();
      const t2 = generateLockToken();
      acquireLock("abtars", "test", t1);
      expect(() => acquireLock("abmind", "test", t2, 500)).toThrow(LockError);
      releaseLock(t1);
    });

    it("releases only matching token", () => {
      const t1 = generateLockToken();
      acquireLock("abtars", "test", t1);
      releaseLock("fake-token");
      expect(existsSync(join(tmpHome, LOCK_DIR_NAME))).toBe(true);
      releaseLock(t1);
      expect(existsSync(join(tmpHome, LOCK_DIR_NAME))).toBe(false);
    });
  });

  describe("manifest", () => {
    it("creates and reads manifest", () => {
      const m = createEmptyManifest();
      expect(m.protocolVersion).toBe(1);
      expect(m.generation).toBe(0);
    });

    it("writes and reads manifest atomically", () => {
      const m = createEmptyManifest();
      m.generation = 5;
      writeManifest(m);
      const read = readManifest();
      expect(read).not.toBeNull();
      expect(read!.generation).toBe(5);
    });

    it("adds consumer only once", () => {
      const m = createEmptyManifest();
      m.packages["better-sqlite3"] = dummyRecord("abtars");
      const m2 = addConsumer(m, "better-sqlite3", "abtars");
      const m3 = addConsumer(m2, "better-sqlite3", "abtars");
      expect(m3.packages["better-sqlite3"].consumers).toEqual(["abtars"]);
    });

    it("rejects incompatible ABI", () => {
      const m = createEmptyManifest();
      m.packages["better-sqlite3"] = dummyRecord("abtars", { nodeAbi: "127" });
      const decision = resolveCompatibility(
        dummyRequest({ nodeAbi: "131" }),
        m,
        true,
      );
      expect(decision.kind).toBe("conflict");
    });

    it("resolves reuse for same version", () => {
      const m = createEmptyManifest();
      m.packages["better-sqlite3"] = dummyRecord("abtars");
      const decision = resolveCompatibility(dummyRequest({}), m, true);
      expect(decision.kind).toBe("reuse");
    });

    it("removes consumer and indicates deletability", () => {
      const m = createEmptyManifest();
      m.packages["better-sqlite3"] = dummyRecord("abtars", { consumers: ["abtars", "abmind"] });
      const { manifest: m1, canDelete } = removeConsumer(m, "better-sqlite3", "abtars");
      expect(canDelete).toBe(false);
      expect(m1.packages["better-sqlite3"].consumers).toEqual(["abmind"]);
      const { manifest: m2, canDelete: canDelete2 } = removeConsumer(m1, "better-sqlite3", "abmind");
      expect(canDelete2).toBe(true);
      expect(m2.packages["better-sqlite3"]).toBeUndefined();
    });
  });
});

const LOCK_DIR_NAME = ".native-deps.lock";
const MANIFEST_FILE = "native-deps.manifest.json";
const STAGING_DIR_NAME = ".native-deps-staging";

function dummyRecord(
  installedBy: "abtars" | "abmind",
  overrides: Partial<import("./shared-native-deps-types.js").NativePackageRecord> = {},
): import("./shared-native-deps-types.js").NativePackageRecord {
  return {
    version: "11.0.0",
    nodeAbi: "127",
    nodeVersion: "22.0.0",
    platform: "linux" as NodeJS.Platform,
    arch: "x64",
    contentHash: "abc123",
    installedAt: new Date().toISOString(),
    installedBy,
    consumers: [installedBy],
    probe: "ok",
    ...overrides,
  };
}

function dummyRequest(
  overrides: Partial<import("./shared-native-deps-types.js").PackageRequest> = {},
): import("./shared-native-deps-types.js").PackageRequest {
  return {
    name: "better-sqlite3",
    version: "11.0.0",
    nodeAbi: "127",
    nodeVersion: "22.0.0",
    platform: "linux" as NodeJS.Platform,
    arch: "x64",
    sourceDir: "/tmp",
    probeModule: ".",
    ...overrides,
  };
}
