import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";

import { acquireLock, releaseLock, generateLockToken, LockError } from "./shared-native-deps-lock.js";
import { readManifest, readManifestRaw, createEmptyManifest, writeManifest, resolveCompatibility, addConsumer, removeConsumer, upsertRecordGroup } from "./shared-native-deps-manifest.js";
import { LOCK_DIR_NAME, MANIFEST_FILE } from "./shared-native-deps-paths.js";
import type { SharedNativeManifest, NativePackageRecord } from "./shared-native-deps-types.js";

function pkg(m: SharedNativeManifest, name: string): NativePackageRecord {
  const p = m.packages[name];
  if (p === undefined) throw new Error(`expected package ${name} in manifest`);
  return p;
}

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
      expect(pkg(m3, "better-sqlite3").consumers).toEqual(["abtars"]);
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
      expect(pkg(m1, "better-sqlite3").consumers).toEqual(["abmind"]);
      const { manifest: m2, canDelete: canDelete2 } = removeConsumer(m1, "better-sqlite3", "abmind");
      expect(canDelete2).toBe(true);
      expect(m2.packages["better-sqlite3"]).toBeUndefined();
    });

    it("upsertRecordGroup overlays records with single generation bump", () => {
      const m = createEmptyManifest();
      m.packages["existing"] = dummyRecord("abtars", { version: "1.0.0" });
      const genBefore = m.generation;
      const records = new Map<string, ReturnType<typeof dummyRecord>>();
      records.set("new-pkg", dummyRecord("abmind", { version: "2.0.0" }));
      const updated = upsertRecordGroup(m, records, new Date().toISOString());
      expect(pkg(updated, "new-pkg").version).toBe("2.0.0");
      expect(updated.packages["existing"]).toBeDefined();
      expect(updated.generation).toBe(genBefore + 1);
    });

    it("readManifestRaw returns exact written bytes", () => {
      const m = createEmptyManifest();
      const content = JSON.stringify(m, null, 2) + "\n";
      writeManifest(m);
      const raw = readManifestRaw();
      expect(raw).toBe(content);
    });

    it("readManifestRaw returns null when no manifest exists", () => {
      expect(readManifestRaw()).toBeNull();
    });
  });
});

describe("native target contract (#1436)", () => {
  it("has exact versions (not registry latest)", async () => {
    const { NATIVE_TARGET_CONTRACT, nativeTargetVersion, NATIVE_TARGET_NAMES } = await import("../../cli/lib/native-dep-targets.js");
    for (const pkg of NATIVE_TARGET_NAMES) {
      const v = nativeTargetVersion(pkg);
      expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(NATIVE_TARGET_CONTRACT.nodeMajor).toBe(22);
  });

  it("has stable canonical JSON", async () => {
    const { nativeTargetCanonicalJson, NATIVE_TARGET_CONTRACT } = await import("../../cli/lib/native-dep-targets.js");
    const json = nativeTargetCanonicalJson();
    const parsed = JSON.parse(json);
    expect(parsed.contractHash).toBe(NATIVE_TARGET_CONTRACT.contractHash);
    expect(parsed.packages["better-sqlite3"].version).toBe("12.11.1");
    expect(parsed.packages["sqlite-vec"].version).toBe("0.1.9");
  });

  it("prohibits registry latest for native packages", async () => {
    const { NATIVE_TARGET_CONTRACT, NATIVE_TARGET_NAMES } = await import("../../cli/lib/native-dep-targets.js");
    for (const pkg of NATIVE_TARGET_NAMES) {
      const spec = NATIVE_TARGET_CONTRACT.packages[pkg];
      expect(spec.version).not.toBe("latest");
      expect(spec.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe("concurrency (#1388)", () => {
  let concurrencyHome: string;

  beforeEach(() => {
    concurrencyHome = mkdtempSync(join(tmpdir(), "native-deps-con-"));
    process.env["AB_SHARED_DEPS_ROOT"] = concurrencyHome;
  });

  afterEach(() => {
    delete process.env["AB_SHARED_DEPS_ROOT"];
    rmSync(concurrencyHome, { recursive: true, force: true });
  });

  it("second acquire times out when first holds lock", () => {
    const token1 = generateLockToken();
    const token2 = generateLockToken();
    acquireLock("abtars", "op1", token1);
    expect(() => acquireLock("abmind", "op2", token2, 500)).toThrow(LockError);
    releaseLock(token1);
  });

  it("stale lock from dead PID is recoverable", () => {
    // Use a nonexistent PID by using -1 (always fails kill(0))
    const lockDir = join(concurrencyHome, ".native-deps.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({
      protocolVersion: 1,
      token: "stale-token",
      product: "abtars",
      operation: "crashed",
      pid: 999_999_999,
      hostname: hostname(),
      processStartedAt: Date.now() - 60000,
      acquiredAt: new Date(Date.now() - 60000).toISOString(),
    }));
    const token = generateLockToken();
    acquireLock("abmind", "recover", token);
    releaseLock(token);
    expect(existsSync(lockDir)).toBe(false);
  });
});

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
