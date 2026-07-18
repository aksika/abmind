import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { generateLockToken, acquireLock, releaseLock } from "./shared-native-deps-lock.js";
import { readManifest, createEmptyManifest, writeManifest, addConsumer, removeConsumer, upsertRecord } from "./shared-native-deps-manifest.js";
import { stagingDirPath, packageLivePath, packageStagingPath, resolveSharedNativeRoot } from "./shared-native-deps-paths.js";
import type { NativeConsumer, NativePackageRecord } from "./shared-native-deps-types.js";
import { NATIVE_TARGET_CONTRACT, NATIVE_TARGET_NAMES, nativeTargetVersion } from "../../cli/lib/native-dep-targets.js";
import type { NativeTargetPackage } from "../../cli/lib/native-dep-targets.js";

export type PkgObsState =
  | { state: "absent" }
  | { state: "invalid"; reason: string }
  | { state: "installed"; version: string };

export type NativeGroupState = "absent" | "partial" | "invalid" | "drifted" | "ready";
export type NativeGroupAction = "reuse" | "repair" | "refresh" | "instruct-install";

export interface NativePackageObs {
  name: NativeTargetPackage;
  target: string;
  observed: PkgObsState;
}

export interface NativeGroupObservation {
  packages: NativePackageObs[];
  state: NativeGroupState;
}

export interface NativeGroupResult {
  action: NativeGroupAction;
  ok: boolean;
  error?: string;
}

function observeOne(pkg: NativeTargetPackage): PkgObsState {
  const liveDir = packageLivePath(pkg);
  const pkgJsonPath = join(liveDir, "package.json");
  if (!existsSync(pkgJsonPath)) return { state: "absent" };
  try {
    const raw = readFileSync(pkgJsonPath, "utf-8");
    const meta = JSON.parse(raw) as { version?: string };
    if (typeof meta.version !== "string" || !meta.version) {
      return { state: "invalid", reason: "missing-version" };
    }
    return { state: "installed", version: meta.version };
  } catch {
    return { state: "invalid", reason: "invalid-json" };
  }
}

export function observeNativeGroup(): NativeGroupObservation {
  const packages: NativePackageObs[] = NATIVE_TARGET_NAMES.map(name => ({
    name,
    target: nativeTargetVersion(name),
    observed: observeOne(name),
  }));

  const absent = packages.every(p => p.observed.state === "absent");
  const allReady = packages.every(p => p.observed.state === "installed" && p.observed.version === p.target);
  const anyInvalid = packages.some(p => p.observed.state === "invalid");
  const anyInstalled = packages.some(p => p.observed.state === "installed");

  let state: NativeGroupState;
  if (absent) state = "absent";
  else if (anyInvalid) state = "invalid";
  else if (allReady) state = "ready";
  else if (anyInstalled) state = "drifted";
  else state = "partial";

  return { packages, state };
}

export function selectNativeGroupAction(operation: "install" | "update", obs: NativeGroupObservation): NativeGroupAction {
  if (operation === "install") {
    switch (obs.state) {
      case "ready": return "reuse";
      default: return "repair";
    }
  } else {
    switch (obs.state) {
      case "absent": return "instruct-install";
      case "ready": return "refresh";
      default: return "repair";
    }
  }
}

function hashDirectory(dir: string): string {
  if (!existsSync(dir)) return "";
  const hash = createHash("sha256");
  hash.update(`dir:${dir}`);
  try {
    const entries = readdirSync(dir, { recursive: true }) as string[];
    for (const entry of entries.sort()) {
      const full = join(dir, entry);
      try {
        const content = readFileSync(full);
        hash.update(`${entry}:${content.length}:`);
        hash.update(content);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return hash.digest("hex").slice(0, 16);
}

function enumerateClosure(stagingPrefix: string): Array<{ name: string; version: string; hash: string }> {
  const nmDir = join(stagingPrefix, "node_modules");
  if (!existsSync(nmDir)) return [];
  const closure: Array<{ name: string; version: string; hash: string }> = [];
  const entries = readdirSync(nmDir);
  for (const entry of entries) {
    const pkgDir = join(nmDir, entry);
    const pkgJsonPath = join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    try {
      const raw = readFileSync(pkgJsonPath, "utf-8");
      const meta = JSON.parse(raw) as { version?: string };
      if (typeof meta.version !== "string") continue;
      closure.push({ name: entry, version: meta.version, hash: hashDirectory(pkgDir) });
    } catch { /* skip unreadable */ }
  }
  return closure;
}

function checkCollisions(closure: Array<{ name: string; version: string; hash: string }>, liveRoot: string): string | null {
  for (const pkg of closure) {
    const livePkgDir = join(liveRoot, pkg.name);
    if (!existsSync(livePkgDir)) continue;
    if (NATIVE_TARGET_NAMES.includes(pkg.name as NativeTargetPackage)) continue;
    const liveHash = hashDirectory(livePkgDir);
    const livePkgJson = join(livePkgDir, "package.json");
    let liveVersion = "unknown";
    try {
      const raw = readFileSync(livePkgJson, "utf-8");
      liveVersion = (JSON.parse(raw) as { version?: string }).version ?? "unknown";
    } catch { /* ignore */ }
    if (pkg.hash !== liveHash || pkg.version !== liveVersion) {
      return `Collision with unrelated package "${pkg.name}": staged ${pkg.version}@${pkg.hash} conflicts with live ${liveVersion}@${liveHash}. Refusing to overwrite.`;
    }
  }
  return null;
}

const NATIVE_PROBE_IDS: Record<string, string> = {
  "better-sqlite3": NATIVE_TARGET_CONTRACT.packages["better-sqlite3"].probeId,
  "sqlite-vec": NATIVE_TARGET_CONTRACT.packages["sqlite-vec"].probeId,
};

function nativeProbesPass(pkgDir: string): boolean {
  try {
    const code = `
const Database = require(${JSON.stringify(join(pkgDir, "better-sqlite3"))});
const db = new Database(":memory:");
db.exec("select 1");
try {
  const sqliteVec = require(${JSON.stringify(join(pkgDir, "sqlite-vec"))});
  sqliteVec.load(db);
  db.exec("select 1");
} catch (e) {
  console.log("sqlite-vec-probe-fail:" + e.message);
}
db.close();
console.log("ok");
`;
    const result = spawnSync(process.execPath, ["-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env, NODE_PATH: "" },
    });
    const out = (result.stdout ?? "").trim();
    return out === "ok";
  } catch {
    return false;
  }
}

export function ensureNativeGroup(product: NativeConsumer, operation: "install" | "update"): NativeGroupResult {
  const action = selectNativeGroupAction(operation, observeNativeGroup());

  if (action === "instruct-install") {
    return { action: "instruct-install", ok: false, error: "Native deps not installed. Run: abmind deps install" };
  }

  const token = generateLockToken();
  acquireLock(product, `native:${action}`, token);
  try {
    const lockedObs = observeNativeGroup();
    const lockedAction = selectNativeGroupAction(operation, lockedObs);

    if (lockedAction === "reuse") {
      const manifest = readManifest() ?? createEmptyManifest();
      for (const pkg of NATIVE_TARGET_NAMES) {
        const updated = addConsumer(manifest, pkg, product);
        Object.assign(manifest, updated);
      }
      writeManifest(manifest);
      return { action: "reuse", ok: true };
    }

    if (lockedAction === "instruct-install") {
      return { action: "instruct-install", ok: false, error: "Native deps not installed. Run: abmind deps install" };
    }

    if (lockedAction === "refresh") {
      return refreshNativeGroup(product, token);
    }

    return repairNativeGroup(product, token);
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    releaseLock(token);
  }
}

function refreshNativeGroup(product: NativeConsumer, token: string): NativeGroupResult {
  const opId = `refresh_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const stagingPrefix = join(stagingDirPath(), opId);
  mkdirSync(join(stagingPrefix, "node_modules"), { recursive: true });

  const liveRoot = resolveSharedNativeRoot();
  try {
    const npmArgs: string[] = [
      "install", "--prefix", stagingPrefix,
      "--no-audit", "--no-fund",
    ];
    for (const pkg of NATIVE_TARGET_NAMES) {
      npmArgs.push(`${pkg}@${nativeTargetVersion(pkg)}`);
    }

    const npmResult = spawnSync("npm", npmArgs, {
      stdio: "pipe",
      shell: false,
      encoding: "utf-8",
      timeout: 120000,
    });

    if (npmResult.error || npmResult.status !== 0) {
      const msg = npmResult.error?.message ?? npmResult.stderr?.slice(0, 200) ?? `exit code ${npmResult.status}`;
      return { action: "refresh", ok: false, error: `npm install failed: ${msg}` };
    }

    const closure = enumerateClosure(stagingPrefix);
    if (closure.length === 0) {
      return { action: "refresh", ok: false, error: "npm produced no packages" };
    }

    const collision = checkCollisions(closure, liveRoot);
    if (collision) return { action: "refresh", ok: false, error: collision };

    if (!nativeProbesPass(stagingPrefix)) {
      rmSync(stagingPrefix, { recursive: true, force: true });
      return { action: "refresh", ok: false, error: "Staged native probes failed" };
    }

    return activateGroup(opId, product, closure, stagingPrefix, token);
  } catch (err) {
    if (existsSync(stagingPrefix)) rmSync(stagingPrefix, { recursive: true, force: true });
    return { action: "refresh", ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function repairNativeGroup(product: NativeConsumer, token: string): NativeGroupResult {
  const opId = `repair_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const stagingPrefix = join(stagingDirPath(), opId);
  mkdirSync(join(stagingPrefix, "node_modules"), { recursive: true });

  const liveRoot = resolveSharedNativeRoot();
  try {
    const npmArgs: string[] = [
      "install", "--prefix", stagingPrefix,
      "--no-audit", "--no-fund",
    ];
    for (const pkg of NATIVE_TARGET_NAMES) {
      npmArgs.push(`${pkg}@${nativeTargetVersion(pkg)}`);
    }

    const npmResult = spawnSync("npm", npmArgs, {
      stdio: "pipe",
      shell: false,
      encoding: "utf-8",
      timeout: 120000,
    });

    if (npmResult.error || npmResult.status !== 0) {
      const msg = npmResult.error?.message ?? npmResult.stderr?.slice(0, 200) ?? `exit code ${npmResult.status}`;
      return { action: "repair", ok: false, error: `npm install failed: ${msg}` };
    }

    const closure = enumerateClosure(stagingPrefix);
    if (closure.length === 0) {
      return { action: "repair", ok: false, error: "npm produced no packages" };
    }

    const collision = checkCollisions(closure, liveRoot);
    if (collision) return { action: "repair", ok: false, error: collision };

    if (!nativeProbesPass(stagingPrefix)) {
      rmSync(stagingPrefix, { recursive: true, force: true });
      return { action: "repair", ok: false, error: "Staged native probes failed" };
    }

    return activateGroup(opId, product, closure, stagingPrefix, token);
  } catch (err) {
    if (existsSync(stagingPrefix)) rmSync(stagingPrefix, { recursive: true, force: true });
    return { action: "repair", ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function activateGroup(
  opId: string,
  product: NativeConsumer,
  closure: Array<{ name: string; version: string; hash: string }>,
  stagingPrefix: string,
  token: string,
): NativeGroupResult {
  const nodeAbi = process.versions?.modules ?? "";
  const arch = process.arch;
  const platform = process.platform;
  const nv = process.version;
  const liveRoot = resolveSharedNativeRoot();
  const journal: Array<{ pkg: string; prevPath?: string; stagedPath: string }> = [];

  try {
    for (const pkg of closure) {
      const live = join(liveRoot, pkg.name);
      const staged = join(stagingPrefix, "node_modules", pkg.name);
      const prev = live + ".prev." + opId;

      if (!existsSync(staged)) continue;

      if (existsSync(live)) {
        renameSync(live, prev);
        journal.push({ pkg: pkg.name, prevPath: prev, stagedPath: staged });
      } else {
        journal.push({ pkg: pkg.name, stagedPath: staged });
      }
      renameSync(staged, live);
    }

    if (!nativeProbesPass(liveRoot)) {
      rollbackActivation(journal, opId);
      return { action: "repair", ok: false, error: "Live native probes failed after activation" };
    }

    const manifest = readManifest() ?? createEmptyManifest();
    for (const pkg of NATIVE_TARGET_NAMES) {
      const closureEntry = closure.find(c => c.name === pkg);
      if (!closureEntry) {
        rollbackActivation(journal, opId);
        return { action: "repair", ok: false, error: `Target package "${pkg}" not found in npm closure` };
      }
      const record: NativePackageRecord = {
        version: nativeTargetVersion(pkg),
        nodeAbi,
        nodeVersion: nv,
        platform: platform as NodeJS.Platform,
        arch,
        contentHash: closureEntry.hash,
        installedAt: new Date().toISOString(),
        installedBy: product,
        consumers: [product],
        probe: NATIVE_PROBE_IDS[pkg] ?? "",
      };
      const updated = upsertRecord(manifest, pkg, record);
      Object.assign(manifest, updated);
    }
    writeManifest(manifest);

    cleanupJournal(journal, opId);
    const markerDir = join(stagingDirPath(), opId);
    if (existsSync(markerDir)) rmSync(markerDir, { recursive: true, force: true });

    return { action: "repair", ok: true };
  } catch (err) {
    rollbackActivation(journal, opId);
    return { action: "repair", ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function rollbackActivation(
  journal: Array<{ pkg: string; prevPath?: string; stagedPath: string }>,
  opId: string,
): void {
  const liveRoot = resolveSharedNativeRoot();
  for (const entry of journal.reverse()) {
    const live = join(liveRoot, entry.pkg);
    const prev = live + ".prev." + opId;
    if (entry.prevPath && existsSync(prev) && !existsSync(live)) {
      try { renameSync(prev, live); } catch { /* best-effort */ }
    } else if (!entry.prevPath && existsSync(live)) {
      try { rmSync(live, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

function cleanupJournal(
  journal: Array<{ pkg: string; prevPath?: string; stagedPath: string }>,
  opId: string,
): void {
  for (const entry of journal) {
    if (!entry.prevPath) continue;
    const prev = entry.prevPath;
    if (existsSync(prev)) {
      try { rmSync(prev, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
