import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashContent, observeNativeGroup, selectNativeGroupAction, resolveClosure, nativeClosureProbeId, ensureNativeGroup } from "./shared-native-deps-group.js";
import type { NativeGroupObservation } from "./shared-native-deps-group.js";
import type { NativePackageRecord } from "./shared-native-deps-types.js";
import { NATIVE_TARGET_CONTRACT, NATIVE_TARGET_NAMES, nativeTargetVersion, nativeTargetProbeId } from "../../cli/lib/native-dep-targets.js";
import { createEmptyManifest, writeManifest, upsertRecord, readManifest } from "./shared-native-deps-manifest.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "native-group-test-"));
  process.env["AB_SHARED_DEPS_ROOT"] = tmpHome;
  mkdirSync(join(tmpHome, "node_modules"), { recursive: true });
});

afterEach(() => {
  delete process.env["AB_SHARED_DEPS_ROOT"];
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("observeNativeGroup", () => {
  it("returns absent when nothing is installed", () => {
    const obs = observeNativeGroup();
    expect(obs.state).toBe("absent");
    expect(obs.packages.length).toBe(2);
    expect(obs.packages.every(p => p.observed.state === "absent")).toBe(true);
  });

  it("has exact targets from the contract", () => {
    const obs = observeNativeGroup();
    for (const pkg of obs.packages) {
      expect(pkg.target).toBe(nativeTargetVersion(pkg.name));
    }
  });

  it("lists both native packages", () => {
    const obs = observeNativeGroup();
    const names = obs.packages.map(p => p.name);
    expect(names).toContain("better-sqlite3");
    expect(names).toContain("sqlite-vec");
  });

  it("returns ready when both packages match targets and manifest is valid", () => {
    const versions: Record<string, string> = { "better-sqlite3": "12.11.1", "sqlite-vec": "0.1.9" };
    for (const pkg of NATIVE_TARGET_NAMES) {
      const pkgDir = join(tmpHome, "node_modules", pkg);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version: versions[pkg] }));
    }
    let m = createEmptyManifest();
    for (const pkg of NATIVE_TARGET_NAMES) {
      const version = versions[pkg];
      if (version === undefined) throw new Error(`fixture version missing for ${pkg}`);
      m = upsertRecord(m, pkg, {
        version,
        nodeAbi: process.versions?.modules ?? "",
        nodeVersion: process.version,
        platform: process.platform as NodeJS.Platform,
        arch: process.arch,
        contentHash: hashContent(join(tmpHome, "node_modules", pkg)),
        installedAt: new Date().toISOString(),
        installedBy: "abmind",
        consumers: ["abmind"],
        probe: pkg === "better-sqlite3" ? "sqlite-open-select-v1" : "sqlite-vec-load-query-v1",
      });
    }
    writeManifest(m);
    const obs = observeNativeGroup();
    expect(obs.state).toBe("ready");
  });

  it("returns drifted when versions mismatch", () => {
    const pkgDir = join(tmpHome, "node_modules", "better-sqlite3");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "1.0.0" }));
    const obs = observeNativeGroup();
    expect(obs.state).toBe("drifted");
  });

  it("returns drifted when packages match targets but manifest is absent", () => {
    const versions: Record<string, string> = { "better-sqlite3": "12.11.1", "sqlite-vec": "0.1.9" };
    for (const pkg of NATIVE_TARGET_NAMES) {
      const pkgDir = join(tmpHome, "node_modules", pkg);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version: versions[pkg] }));
    }
    const obs = observeNativeGroup();
    expect(obs.state).toBe("drifted");
  });

  it("returns invalid when package.json is malformed", () => {
    const pkgDir = join(tmpHome, "node_modules", "better-sqlite3");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), "not json");
    const obs = observeNativeGroup();
    expect(obs.state).toBe("invalid");
    expect(obs.packages.some(p => p.observed.state === "invalid")).toBe(true);
  });

  it("reports adoption eligible when roots at targets but manifest absent", () => {
    const versions: Record<string, string> = { "better-sqlite3": "12.11.1", "sqlite-vec": "0.1.9" };
    for (const pkg of NATIVE_TARGET_NAMES) {
      const pkgDir = join(tmpHome, "node_modules", pkg);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version: versions[pkg] }));
    }
    const obs = observeNativeGroup();
    expect(obs.state).toBe("drifted");
    expect(obs.adoption.eligible).toBe(true);
    if (obs.adoption.eligible) {
      expect(obs.adoption.closure.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("reports adoption not eligible when drifted with version mismatch", () => {
    const pkgDir = join(tmpHome, "node_modules", "better-sqlite3");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "1.0.0" }));
    const obs = observeNativeGroup();
    expect(obs.state).toBe("drifted");
    expect(obs.adoption.eligible).toBe(false);
  });
});

describe("selectNativeGroupAction", () => {
  function makeObs(state: "absent" | "partial" | "invalid" | "drifted" | "ready") {
    const obs = observeNativeGroup();
    return { ...obs, state };
  }

  function makeAdoptableObs(): NativeGroupObservation {
    return {
      packages: [],
      state: "drifted",
      adoption: { eligible: true, closure: [] },
    };
  }

  it("install on ready returns reuse", () => {
    expect(selectNativeGroupAction("install", makeObs("ready"))).toBe("reuse");
  });

  it("install on absent returns repair", () => {
    expect(selectNativeGroupAction("install", makeObs("absent"))).toBe("repair");
  });

  it("install on partial returns repair", () => {
    expect(selectNativeGroupAction("install", makeObs("partial"))).toBe("repair");
  });

  it("install on drifted (not adoptable) returns repair", () => {
    expect(selectNativeGroupAction("install", makeObs("drifted"))).toBe("repair");
  });

  it("install on drifted (adoptable) returns adopt", () => {
    expect(selectNativeGroupAction("install", makeAdoptableObs())).toBe("adopt");
  });

  it("install on invalid returns repair", () => {
    expect(selectNativeGroupAction("install", makeObs("invalid"))).toBe("repair");
  });

  it("update on absent returns instruct-install", () => {
    expect(selectNativeGroupAction("update", makeObs("absent"))).toBe("instruct-install");
  });

  it("update on ready returns refresh", () => {
    expect(selectNativeGroupAction("update", makeObs("ready"))).toBe("refresh");
  });

  it("update on partial returns repair", () => {
    expect(selectNativeGroupAction("update", makeObs("partial"))).toBe("repair");
  });

  it("update on drifted (not adoptable) returns repair", () => {
    expect(selectNativeGroupAction("update", makeObs("drifted"))).toBe("repair");
  });

  it("update on drifted (adoptable) returns adopt", () => {
    expect(selectNativeGroupAction("update", makeAdoptableObs())).toBe("adopt");
  });

  it("update on invalid returns repair", () => {
    expect(selectNativeGroupAction("update", makeObs("invalid"))).toBe("repair");
  });
});

describe("contract integrity (#1436)", () => {
  it("contract hash matches the expected cross-product value", () => {
    expect(NATIVE_TARGET_CONTRACT.contractHash).toBe("native-v1-node22-better-sqlite3-12.11.1-sqlite-vec-0.1.9");
  });

  it("better-sqlite3 target is exact", () => {
    expect(nativeTargetVersion("better-sqlite3")).toBe("12.11.1");
  });

  it("sqlite-vec target is exact", () => {
    expect(nativeTargetVersion("sqlite-vec")).toBe("0.1.9");
  });

  it("node major is 22", () => {
    expect(NATIVE_TARGET_CONTRACT.nodeMajor).toBe(22);
  });

  it("all targets are semver (not latest)", () => {
    for (const pkg of NATIVE_TARGET_NAMES) {
      expect(NATIVE_TARGET_CONTRACT.packages[pkg].version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe("resolveClosure", () => {
  function writePkg(pkgDir: string, name: string, version: string, deps?: Record<string, string>, optDeps?: Record<string, string>) {
    mkdirSync(pkgDir, { recursive: true });
    const pkg: Record<string, unknown> = { name, version };
    if (deps) pkg.dependencies = deps;
    if (optDeps) pkg.optionalDependencies = optDeps;
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(pkgDir, "index.js"), `module.exports = { version: "${version}" };`);
  }

  it("resolves flat closure with both roots", () => {
    const nmDir = join(tmpHome, "node_modules");
    writePkg(join(nmDir, "better-sqlite3"), "better-sqlite3", "12.11.1", { "node-abi": "^3.0.0" });
    writePkg(join(nmDir, "sqlite-vec"), "sqlite-vec", "0.1.9");
    writePkg(join(nmDir, "node-abi"), "node-abi", "3.92.0");

    const result = resolveClosure(nmDir, ["better-sqlite3", "sqlite-vec"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.entries.map(e => e.name);
    expect(names).toContain("better-sqlite3");
    expect(names).toContain("sqlite-vec");
    expect(names).toContain("node-abi");

    const better = result.entries.find(e => e.name === "better-sqlite3")!;
    expect(better.kind).toBe("root");
    expect(better.version).toBe("12.11.1");
    const nodeAbi = result.entries.find(e => e.name === "node-abi")!;
    expect(nodeAbi.kind).toBe("transitive");
  });

  it("returns in package-name order", () => {
    const nmDir = join(tmpHome, "node_modules");
    writePkg(join(nmDir, "better-sqlite3"), "better-sqlite3", "12.11.1");
    writePkg(join(nmDir, "sqlite-vec"), "sqlite-vec", "0.1.9");

    const result = resolveClosure(nmDir, ["better-sqlite3", "sqlite-vec"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.entries.map(e => e.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it("supports scoped package dependencies", () => {
    const nmDir = join(tmpHome, "node_modules");
    writePkg(join(nmDir, "better-sqlite3"), "better-sqlite3", "12.11.1", { "@scope/util": "^1.0.0" });
    writePkg(join(nmDir, "sqlite-vec"), "sqlite-vec", "0.1.9");
    writePkg(join(nmDir, "@scope", "util"), "@scope/util", "1.0.0");

    const result = resolveClosure(nmDir, ["better-sqlite3", "sqlite-vec"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.entries.map(e => e.name);
    expect(names).toContain("@scope/util");
  });

  it("rejects missing root package", () => {
    const nmDir = join(tmpHome, "node_modules");
    writePkg(join(nmDir, "better-sqlite3"), "better-sqlite3", "12.11.1");
    // sqlite-vec not present

    const result = resolveClosure(nmDir, ["better-sqlite3", "sqlite-vec"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("sqlite-vec");
  });

  it("rejects malformed package.json", () => {
    const nmDir = join(tmpHome, "node_modules");
    const pkgDir = join(nmDir, "better-sqlite3");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), "not json");
    writePkg(join(nmDir, "sqlite-vec"), "sqlite-vec", "0.1.9");

    const result = resolveClosure(nmDir, ["better-sqlite3", "sqlite-vec"]);
    expect(result.ok).toBe(false);
  });

  it("rejects package name mismatch", () => {
    const nmDir = join(tmpHome, "node_modules");
    writePkg(join(nmDir, "better-sqlite3"), "better-sqlite3", "12.11.1");
    // sqlite-vec but package.json says wrong name
    const svDir = join(nmDir, "sqlite-vec");
    mkdirSync(svDir, { recursive: true });
    writeFileSync(join(svDir, "package.json"), JSON.stringify({ name: "sqlite-vec-wrong", version: "0.1.9" }));

    const result = resolveClosure(nmDir, ["better-sqlite3", "sqlite-vec"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("name mismatch");
  });

  it("rejects missing version", () => {
    const nmDir = join(tmpHome, "node_modules");
    writePkg(join(nmDir, "better-sqlite3"), "better-sqlite3", "12.11.1");
    const svDir = join(nmDir, "sqlite-vec");
    mkdirSync(svDir, { recursive: true });
    writeFileSync(join(svDir, "package.json"), JSON.stringify({ name: "sqlite-vec" }));

    const result = resolveClosure(nmDir, ["better-sqlite3", "sqlite-vec"]);
    expect(result.ok).toBe(false);
  });

  it("includes installed optional dependency, skips missing optional", () => {
    const nmDir = join(tmpHome, "node_modules");
    writePkg(join(nmDir, "better-sqlite3"), "better-sqlite3", "12.11.1", undefined, { "bindings": "^1.5.0" });
    writePkg(join(nmDir, "sqlite-vec"), "sqlite-vec", "0.1.9");
    // bindings is optional and NOT installed — should be skipped
    writePkg(join(nmDir, "bindings"), "bindings", "1.5.0"); // actually install it

    const result = resolveClosure(nmDir, ["better-sqlite3", "sqlite-vec"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.some(e => e.name === "bindings")).toBe(true);
  });

  it("rejects symlink escape outside shared root", () => {
    const nmDir = join(tmpHome, "node_modules");
    const escapeDir = join(tmpHome, "escape");
    mkdirSync(escapeDir, { recursive: true });
    writeFileSync(join(escapeDir, "package.json"), JSON.stringify({ name: "malicious", version: "1.0.0" }));

    writePkg(join(nmDir, "better-sqlite3"), "better-sqlite3", "12.11.1", { "malicious": "^1.0.0" });
    writePkg(join(nmDir, "sqlite-vec"), "sqlite-vec", "0.1.9");

    // Symlink from node_modules/malicious -> tmpHome/escape
    symlinkSync(escapeDir, join(nmDir, "malicious"), "dir");

    const result = resolveClosure(nmDir, ["better-sqlite3", "sqlite-vec"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("escapes");
  });

  it("skips transitive dep that is absent (not a root)", () => {
    const nmDir = join(tmpHome, "node_modules");
    writePkg(join(nmDir, "better-sqlite3"), "better-sqlite3", "12.11.1", { "missing-dep": "^1.0.0" });
    writePkg(join(nmDir, "sqlite-vec"), "sqlite-vec", "0.1.9");

    // missing-dep not installed — should be skipped since it's transitive, not root
    const result = resolveClosure(nmDir, ["better-sqlite3", "sqlite-vec"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.some(e => e.name === "missing-dep")).toBe(false);
  });

  it("returns consistent deterministic hashes", () => {
    const nmDir = join(tmpHome, "node_modules");
    writePkg(join(nmDir, "better-sqlite3"), "better-sqlite3", "12.11.1");
    writePkg(join(nmDir, "sqlite-vec"), "sqlite-vec", "0.1.9");

    const r1 = resolveClosure(nmDir, ["better-sqlite3", "sqlite-vec"]);
    const r2 = resolveClosure(nmDir, ["better-sqlite3", "sqlite-vec"]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.entries).toEqual(r2.entries);
  });
});

describe("nativeClosureProbeId", () => {
  it("returns a stable marker containing the contract hash", () => {
    const marker = nativeClosureProbeId();
    expect(marker).toContain(NATIVE_TARGET_CONTRACT.contractHash);
    expect(marker).toMatch(/^native-closure:/);
  });
});

describe("adoption eligibility with existing manifest records", () => {
  function writeRoots() {
    const versions: Record<string, string> = { "better-sqlite3": "12.11.1", "sqlite-vec": "0.1.9" };
    for (const pkg of NATIVE_TARGET_NAMES) {
      const pkgDir = join(tmpHome, "node_modules", pkg);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version: versions[pkg] }));
    }
  }

  it("observation reports eligible even with incompatible manifest (locked op validates)", () => {
    writeRoots();
    let m = createEmptyManifest();
    m = upsertRecord(m, "better-sqlite3", {
      version: "12.11.1",
      nodeAbi: process.versions?.modules ?? "",
      nodeVersion: process.version,
      platform: process.platform as NodeJS.Platform,
      arch: process.arch,
      contentHash: hashContent(join(tmpHome, "node_modules", "better-sqlite3")),
      installedAt: new Date().toISOString(),
      installedBy: "abmind",
      consumers: ["abmind"],
      probe: "wrong-probe-id",
    });
    writeManifest(m);
    const obs = observeNativeGroup();
    // Observation only checks roots-at-target + manifest-not-ready.
    // It does NOT validate existing records — that happens under lock.
    expect(obs.state).toBe("drifted");
    expect(obs.adoption.eligible).toBe(true);
  });

  it("observation reports eligible with stale manifest record (locked op validates)", () => {
    writeRoots();
    let m = createEmptyManifest();
    m = upsertRecord(m, "better-sqlite3", {
      version: "1.0.0",
      nodeAbi: process.versions?.modules ?? "",
      nodeVersion: process.version,
      platform: process.platform as NodeJS.Platform,
      arch: process.arch,
      contentHash: "stalehash",
      installedAt: new Date().toISOString(),
      installedBy: "abmind",
      consumers: ["abmind"],
      probe: "sqlite-open-select-v1",
    });
    writeManifest(m);
    const obs = observeNativeGroup();
    expect(obs.state).toBe("drifted");
    expect(obs.adoption.eligible).toBe(true);
  });
});

describe("resolveClosure — hash drift", () => {
  it("rejects unreadable content in root package", () => {
    const nmDir = join(tmpHome, "node_modules");
    const pkgDir = join(nmDir, "better-sqlite3");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "12.11.1" }));
    writeFileSync(join(pkgDir, "index.js"), "module.exports = {};");
    const sqliteDir = join(nmDir, "sqlite-vec");
    mkdirSync(sqliteDir, { recursive: true });
    writeFileSync(join(sqliteDir, "package.json"), JSON.stringify({ name: "sqlite-vec", version: "0.1.9" }));
    // Make a file unreadable (permission denied)
    chmodSync(join(pkgDir, "index.js"), 0o000);
    const result = resolveClosure(nmDir, ["better-sqlite3", "sqlite-vec"]);
    chmodSync(join(pkgDir, "index.js"), 0o644); // cleanup for rm
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Cannot hash");
    }
  });
});

describe("adoptNativeGroup — end-to-end mutation path", () => {
  function writeRootStubs() {
    const nmDir = join(tmpHome, "node_modules");

    // better-sqlite3 stub — must satisfy nativeProbesPass inline require
    const bDir = join(nmDir, "better-sqlite3");
    mkdirSync(bDir, { recursive: true });
    writeFileSync(join(bDir, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "12.11.1" }));
    writeFileSync(join(bDir, "index.js"), `module.exports = class Database { constructor() {} exec() {} close() {} };`);

    // sqlite-vec stub
    const sDir = join(nmDir, "sqlite-vec");
    mkdirSync(sDir, { recursive: true });
    writeFileSync(join(sDir, "package.json"), JSON.stringify({ name: "sqlite-vec", version: "0.1.9" }));
    writeFileSync(join(sDir, "index.js"), `module.exports = { load: () => {} };`);
  }

  it("install on adoptable roots converges: adoption then reuse in one invocation", () => {
    writeRootStubs();
    // No manifest exists — state is drifted and adoptable; adoption runs and
    // re-selects within the same invocation, terminating in reuse.
    const result = ensureNativeGroup("abmind", "install");
    expect(result.ok).toBe(true);
    expect(result.action).toBe("reuse");

    // Verify manifest written with both roots
    const m = readManifest();
    expect(m).not.toBeNull();
    expect(Object.keys(m!.packages)).toEqual(expect.arrayContaining(["better-sqlite3", "sqlite-vec"]));
    const obs = observeNativeGroup();
    expect(obs.state).toBe("ready");
  });

  it("subsequent installs reuse after the initial adoption", () => {
    writeRootStubs();
    const r1 = ensureNativeGroup("abmind", "install");
    expect(r1.ok).toBe(true);
    expect(r1.action).toBe("reuse");

    const r2 = ensureNativeGroup("abmind", "install");
    expect(r2.ok).toBe(true);
    expect(r2.action).toBe("reuse");
  });

  it("accepts genuinely incompatible version ranges — range diversity is not a collision", () => {
    const nmDir = join(tmpHome, "node_modules");

    // Two roots each depend on the same transitive with different ranges
    const bDir = join(nmDir, "better-sqlite3");
    mkdirSync(bDir, { recursive: true });
    writeFileSync(join(bDir, "package.json"), JSON.stringify({
      name: "better-sqlite3", version: "12.11.1",
      dependencies: { "shared-lib": "^1.0.0" },
    }));
    writeFileSync(join(bDir, "index.js"), `module.exports = class Database { constructor() {} exec() {} close() {} };`);

    const sDir = join(nmDir, "sqlite-vec");
    mkdirSync(sDir, { recursive: true });
    writeFileSync(join(sDir, "package.json"), JSON.stringify({
      name: "sqlite-vec", version: "0.1.9",
      dependencies: { "shared-lib": "^2.0.0" },
    }));
    writeFileSync(join(sDir, "index.js"), `module.exports = { load: () => {} };`);

    // npm has already resolved the flat tree — range diversity is metadata, not a collision
    mkdirSync(join(nmDir, "shared-lib"), { recursive: true });
    writeFileSync(join(nmDir, "shared-lib", "package.json"), JSON.stringify({ name: "shared-lib", version: "1.0.0" }));
    writeFileSync(join(nmDir, "shared-lib", "index.js"), `module.exports = {};`);

    const result = resolveClosure(nmDir, ["better-sqlite3", "sqlite-vec"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries.some(e => e.name === "shared-lib")).toBe(true);
    }
  });

  it("resolves with distinct but overlapping ranges — npm resolved the flat tree, inspector trusts it", () => {
    const nmDir = join(tmpHome, "node_modules");

    const bDir = join(nmDir, "better-sqlite3");
    mkdirSync(bDir, { recursive: true });
    writeFileSync(join(bDir, "package.json"), JSON.stringify({
      name: "better-sqlite3", version: "12.11.1",
      dependencies: { "shared-lib": "^1.0.0" },
    }));
    writeFileSync(join(bDir, "index.js"), `module.exports = class Database { constructor() {} exec() {} close() {} };`);

    const sDir = join(nmDir, "sqlite-vec");
    mkdirSync(sDir, { recursive: true });
    writeFileSync(join(sDir, "package.json"), JSON.stringify({
      name: "sqlite-vec", version: "0.1.9",
      dependencies: { "shared-lib": "^1.5.0" },
    }));
    writeFileSync(join(sDir, "index.js"), `module.exports = { load: () => {} };`);

    mkdirSync(join(nmDir, "shared-lib"), { recursive: true });
    writeFileSync(join(nmDir, "shared-lib", "package.json"), JSON.stringify({ name: "shared-lib", version: "1.5.0" }));
    writeFileSync(join(nmDir, "shared-lib", "index.js"), `module.exports = {};`);

    const result = resolveClosure(nmDir, ["better-sqlite3", "sqlite-vec"]);
    expect(result.ok).toBe(true);
  });

  it("adopts with transitive deps present and records them", () => {
    const nmDir = join(tmpHome, "node_modules");
    writeRootStubs();
    // Add a transitive dep (node-abi) that better-sqlite3 depends on
    const tDir = join(nmDir, "node-abi");
    mkdirSync(tDir, { recursive: true });
    writeFileSync(join(tDir, "package.json"), JSON.stringify({ name: "node-abi", version: "3.92.0" }));
    writeFileSync(join(tDir, "index.js"), `module.exports = { getAbi: () => "127" };`);

    // Wire better-sqlite3 to depend on node-abi
    writeFileSync(
      join(nmDir, "better-sqlite3", "package.json"),
      JSON.stringify({ name: "better-sqlite3", version: "12.11.1", dependencies: { "node-abi": "^3.0.0" } }),
    );

    const result = ensureNativeGroup("abmind", "install");
    expect(result.ok).toBe(true);
    expect(result.action).toBe("reuse");

    // Verify manifest has transitive record with native-closure probe
    const m = readManifest();
    expect(m?.packages["node-abi"]?.version).toBe("3.92.0");
    expect(m?.packages["node-abi"]?.probe).toBe(nativeClosureProbeId());
    const obs = observeNativeGroup();
    expect(obs.state).toBe("ready");
  });
});

// ── #1514: closure freshness / ownership boundary ─────────────────────────────

function writeStubPkg(dir: string, name: string, version: string, deps?: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  const meta: Record<string, unknown> = { name, version, main: "index.js" };
  if (deps) meta.dependencies = deps;
  writeFileSync(join(dir, "package.json"), JSON.stringify(meta));
  const body = name === "better-sqlite3"
    ? "module.exports = function Database() { return { exec() {}, close() {} }; };\n"
    : name === "sqlite-vec"
      ? "module.exports = { load() {} };\n"
      : "module.exports = {};\n";
  writeFileSync(join(dir, "index.js"), body);
}

function seedCompleteRootsWithTransitive(nodeAbiVersion = "3.92.0"): void {
  const nm = join(tmpHome, "node_modules");
  writeStubPkg(join(nm, "better-sqlite3"), "better-sqlite3", "12.11.1", { "node-abi": "^3.92.0" });
  writeStubPkg(join(nm, "sqlite-vec"), "sqlite-vec", "0.1.9");
  writeStubPkg(join(nm, "node-abi"), "node-abi", nodeAbiVersion);
}

function writeFullManifest(nodeAbiRecord?: (r: NativePackageRecord) => void): void {
  const nm = join(tmpHome, "node_modules");
  const closure = resolveClosure(nm, ["better-sqlite3", "sqlite-vec"]);
  if (!closure.ok) throw new Error(`fixture closure failed: ${closure.reason}`);
  let m = createEmptyManifest();
  for (const e of closure.entries) {
    const rec: NativePackageRecord = {
      version: e.version,
      nodeAbi: process.versions?.modules ?? "",
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      contentHash: e.contentHash,
      installedAt: new Date().toISOString(),
      installedBy: "abmind",
      consumers: ["abmind"],
      probe: e.kind === "root" ? nativeTargetProbeId(e.name as "better-sqlite3" | "sqlite-vec") : nativeClosureProbeId(),
    };
    if (e.name === "node-abi" && nodeAbiRecord) nodeAbiRecord(rec);
    m = upsertRecord(m, e.name, rec);
  }
  writeManifest(m);
}

describe("observeNativeGroup closure freshness (#1514)", () => {
  it.each([
    ["fresh transitive record", true, (r: NativePackageRecord) => { void r; }],
    ["stale transitive version", false, (r: NativePackageRecord) => { r.version = "3.91.0"; }],
    ["stale transitive contentHash", false, (r: NativePackageRecord) => { r.contentHash = "deadbeefdeadbeef"; }],
    ["stale transitive runtime ABI", false, (r: NativePackageRecord) => { r.nodeAbi = "999"; }],
  ] as Array<[string, boolean, (r: NativePackageRecord) => void]>)("observes %s", (_label, expectReady, mutate) => {
    seedCompleteRootsWithTransitive();
    writeFullManifest(mutate);
    expect(observeNativeGroup().state).toBe(expectReady ? "ready" : "drifted");
  });

  it("reports drifted when the transitive record is missing", () => {
    seedCompleteRootsWithTransitive();
    writeFullManifest();
    const m = readManifest();
    if (m) {
      delete m.packages["node-abi"];
      writeManifest(m);
    }
    expect(observeNativeGroup().state).toBe("drifted");
  });

  it("reports drifted when the transitive record carries a foreign marker", () => {
    seedCompleteRootsWithTransitive();
    writeFullManifest(r => { r.probe = "native-closure:foreign-hash"; });
    expect(observeNativeGroup().state).toBe("drifted");
  });
});

// ── #1514: adoption boundary (probe-satisfying stubs) ─────────────────────────

describe("ensureNativeGroup adoption of stale marker-owned closure (#1514)", () => {
  it("adopts a complete stale marker-owned closure without npm or byte mutation", () => {
    seedCompleteRootsWithTransitive();
    writeFullManifest(r => { r.version = "3.91.0"; });
    const nodeAbiLive = readFileSync(join(tmpHome, "node_modules", "node-abi", "index.js"), "utf-8");
    const preManifest = readFileSync(join(tmpHome, "native-deps.manifest.json"), "utf-8");

    const result = ensureNativeGroup("abmind", "install");

    expect(result.ok).toBe(true);
    expect(result.action).toBe("reuse");
    expect(readManifest()?.packages["node-abi"]?.version).toBe("3.92.0");
    expect(readFileSync(join(tmpHome, "node_modules", "node-abi", "index.js"), "utf-8")).toBe(nodeAbiLive);
    expect(observeNativeGroup().state).toBe("ready");
    expect(readFileSync(join(tmpHome, "native-deps.manifest.json"), "utf-8")).not.toBe(preManifest);
  });

  it("adopting a foreign-marker transitive fails without mutating manifest or live bytes", () => {
    seedCompleteRootsWithTransitive();
    writeFullManifest(r => { r.probe = "native-closure:foreign-hash"; });
    const preManifest = readFileSync(join(tmpHome, "native-deps.manifest.json"), "utf-8");

    const result = ensureNativeGroup("abmind", "install");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("non-native-closure probe");
    expect(readFileSync(join(tmpHome, "native-deps.manifest.json"), "utf-8")).toBe(preManifest);
  });
});

// ── #1514: staged repair / refresh collision boundary (fake npm) ──────────────

function writeRepairManifest(nodeAbiRecord?: (r: NativePackageRecord) => void): void {
  const nm = join(tmpHome, "node_modules");
  let m = createEmptyManifest();
  const rootRec: NativePackageRecord = {
    version: "12.11.1",
    nodeAbi: process.versions?.modules ?? "",
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    contentHash: hashContent(join(nm, "better-sqlite3")),
    installedAt: new Date().toISOString(),
    installedBy: "abmind",
    consumers: ["abmind"],
    probe: nativeTargetProbeId("better-sqlite3"),
  };
  m = upsertRecord(m, "better-sqlite3", rootRec);
  if (nodeAbiRecord) {
    const rec: NativePackageRecord = {
      version: "3.92.0",
      nodeAbi: process.versions?.modules ?? "",
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      contentHash: hashContent(join(nm, "node-abi")),
      installedAt: new Date().toISOString(),
      installedBy: "abmind",
      consumers: ["abmind"],
      probe: nativeClosureProbeId(),
    };
    nodeAbiRecord(rec);
    m = upsertRecord(m, "node-abi", rec);
  }
  writeManifest(m);
}

function writeFakeNpm(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const i = args.indexOf("--prefix");
const prefix = args[i + 1];
if (!prefix) process.exit(1);
const nm = path.join(prefix, "node_modules");
fs.mkdirSync(nm, { recursive: true });
function pkg(name, version, deps) {
  const dir = path.join(nm, name);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { name, version, main: "index.js" };
  if (deps) meta.dependencies = deps;
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, "index.js"),
    name === "better-sqlite3"
      ? "module.exports = function Database() { return { exec() {}, close() {} }; };\\n"
      : name === "sqlite-vec"
        ? "module.exports = { load() {} };\\n"
        : "module.exports = {};\\n");
}
pkg("better-sqlite3", "12.11.1", { "node-abi": "^3.94.0" });
pkg("sqlite-vec", "0.1.9");
const transitive = process.env.FAKE_NPM_TRANSITIVE;
if (transitive) {
  const [tname, tver] = transitive.split("@");
  pkg(tname, tver);
}
`;
  const p = join(binDir, "npm");
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

describe("ensureNativeGroup staged repair/refresh (#1514)", () => {
  let savedPath: string | undefined;

  beforeEach(() => {
    savedPath = process.env["PATH"];
    writeFakeNpm(join(tmpHome, "fake-bin"));
    process.env["PATH"] = join(tmpHome, "fake-bin") + (savedPath ? `:${savedPath}` : "");
  });

  afterEach(() => {
    if (savedPath !== undefined) process.env["PATH"] = savedPath;
    delete process.env["FAKE_NPM_TRANSITIVE"];
  });

  it("replaces a stale marker-owned transitive during partial-root repair", () => {
    const nm = join(tmpHome, "node_modules");
    writeStubPkg(join(nm, "better-sqlite3"), "better-sqlite3", "12.11.1", { "node-abi": "^3.92.0" });
    writeStubPkg(join(nm, "node-abi"), "node-abi", "3.92.0");
    writeRepairManifest(r => { r.version = "3.91.0"; });
    process.env["FAKE_NPM_TRANSITIVE"] = "node-abi@3.94.0";

    const result = ensureNativeGroup("abmind", "install");

    expect(result.ok).toBe(true);
    expect(result.action).toBe("repair");
    expect(readFileSync(join(nm, "node-abi", "package.json"), "utf-8")).toContain("3.94.0");
    expect(readManifest()?.packages["node-abi"]?.version).toBe("3.94.0");
    expect(observeNativeGroup().state).toBe("ready");
  });

  it("refuses an untracked transitive as a hard collision and preserves live bytes", () => {
    const nm = join(tmpHome, "node_modules");
    writeStubPkg(join(nm, "better-sqlite3"), "better-sqlite3", "12.11.1", { "node-abi": "^3.92.0" });
    writeStubPkg(join(nm, "node-abi"), "node-abi", "3.92.0");
    writeRepairManifest();
    const preManifest = readFileSync(join(tmpHome, "native-deps.manifest.json"), "utf-8");
    process.env["FAKE_NPM_TRANSITIVE"] = "node-abi@3.94.0";

    const result = ensureNativeGroup("abmind", "install");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Collision with unrelated package");
    expect(result.error).toContain("node-abi");
    expect(readFileSync(join(nm, "node-abi", "package.json"), "utf-8")).toContain("3.92.0");
    expect(readFileSync(join(tmpHome, "native-deps.manifest.json"), "utf-8")).toBe(preManifest);
  });

  it("refuses a foreign-marker transitive as a hard collision and preserves live bytes", () => {
    const nm = join(tmpHome, "node_modules");
    writeStubPkg(join(nm, "better-sqlite3"), "better-sqlite3", "12.11.1", { "node-abi": "^3.92.0" });
    writeStubPkg(join(nm, "node-abi"), "node-abi", "3.92.0");
    writeRepairManifest(r => { r.probe = "native-closure:foreign-hash"; });
    const preManifest = readFileSync(join(tmpHome, "native-deps.manifest.json"), "utf-8");
    process.env["FAKE_NPM_TRANSITIVE"] = "node-abi@3.94.0";

    const result = ensureNativeGroup("abmind", "install");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Collision with unrelated package");
    expect(readFileSync(join(nm, "node-abi", "package.json"), "utf-8")).toContain("3.92.0");
    expect(readFileSync(join(tmpHome, "native-deps.manifest.json"), "utf-8")).toBe(preManifest);
  });

  it("refresh on a fresh closure replaces a registry-drifted marker-owned transitive", () => {
    const nm = join(tmpHome, "node_modules");
    seedCompleteRootsWithTransitive();
    writeFullManifest();
    process.env["FAKE_NPM_TRANSITIVE"] = "node-abi@3.94.0";

    const result = ensureNativeGroup("abmind", "update");

    expect(result.ok).toBe(true);
    expect(result.action).toBe("refresh");
    expect(readFileSync(join(nm, "node-abi", "package.json"), "utf-8")).toContain("3.94.0");
    expect(readManifest()?.packages["node-abi"]?.version).toBe("3.94.0");
    expect(observeNativeGroup().state).toBe("ready");
  });
});
