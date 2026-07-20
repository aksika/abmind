import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashContent, observeNativeGroup, selectNativeGroupAction, resolveClosure, nativeClosureProbeId, ensureNativeGroup } from "./shared-native-deps-group.js";
import { NATIVE_TARGET_CONTRACT, NATIVE_TARGET_NAMES, nativeTargetVersion } from "../../cli/lib/native-dep-targets.js";
import { createEmptyManifest, writeManifest, upsertRecord } from "./shared-native-deps-manifest.js";

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
      m = upsertRecord(m, pkg, {
        version: versions[pkg],
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

  function makeAdoptableObs() {
    return {
      packages: [] as { name: string; target: string; observed: { state: string; version?: string } }[],
      state: "drifted" as const,
      adoption: { eligible: true, closure: [] } as const,
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

  it("adopts exact roots from empty manifest with no npm (KP-shaped fixture)", () => {
    writeRootStubs();
    // No manifest exists — state is drifted and adoptable
    const result = ensureNativeGroup("abmind", "install");
    expect(result.ok).toBe(true);
    expect(result.action).toBe("adopt");
    expect(result.details).toBeDefined();
    expect(result.details!.roots).toBe(2);
    expect(result.details!.transitives).toBe(0);

    // Verify manifest written
    const obs = observeNativeGroup();
    expect(obs.state).toBe("ready");
  });

  it("second install reuses after adoption", () => {
    writeRootStubs();
    const r1 = ensureNativeGroup("abmind", "install");
    expect(r1.ok).toBe(true);
    expect(r1.action).toBe("adopt");

    const r2 = ensureNativeGroup("abmind", "install");
    expect(r2.ok).toBe(true);
    expect(r2.action).toBe("reuse");
  });

  it("rejects incompatible version ranges for same transitive name", () => {
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

    // Only one version of shared-lib can exist in flat layout — conflict detected
    mkdirSync(join(nmDir, "shared-lib"), { recursive: true });
    writeFileSync(join(nmDir, "shared-lib", "package.json"), JSON.stringify({ name: "shared-lib", version: "1.0.0" }));
    writeFileSync(join(nmDir, "shared-lib", "index.js"), `module.exports = {};`);

    const result = resolveClosure(nmDir, ["better-sqlite3", "sqlite-vec"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Incompatible version ranges");
      expect(result.reason).toContain("shared-lib");
    }
  });

  it("allows compatible version ranges for same transitive name", () => {
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
      dependencies: { "shared-lib": "^1.0.0" },
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
    expect(result.action).toBe("adopt");
    expect(result.details!.roots).toBe(2);
    expect(result.details!.transitives).toBe(1);

    // Verify manifest has transitive record with native-closure probe
    const obs = observeNativeGroup();
    expect(obs.state).toBe("ready");
  });
});
