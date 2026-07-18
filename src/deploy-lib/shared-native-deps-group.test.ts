import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashContent, observeNativeGroup, selectNativeGroupAction } from "./shared-native-deps-group.js";
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
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: versions[pkg] }));
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
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    const obs = observeNativeGroup();
    expect(obs.state).toBe("drifted");
  });

  it("returns drifted when packages match targets but manifest is absent", () => {
    const versions: Record<string, string> = { "better-sqlite3": "12.11.1", "sqlite-vec": "0.1.9" };
    for (const pkg of NATIVE_TARGET_NAMES) {
      const pkgDir = join(tmpHome, "node_modules", pkg);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: versions[pkg] }));
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
});

describe("selectNativeGroupAction", () => {
  function makeObs(state: "absent" | "partial" | "invalid" | "drifted" | "ready") {
    const obs = observeNativeGroup();
    return { ...obs, state };
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

  it("install on drifted returns repair", () => {
    expect(selectNativeGroupAction("install", makeObs("drifted"))).toBe("repair");
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

  it("update on drifted returns repair", () => {
    expect(selectNativeGroupAction("update", makeObs("drifted"))).toBe("repair");
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
