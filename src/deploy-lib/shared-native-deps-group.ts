import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { generateLockToken, acquireLock, releaseLock } from "./shared-native-deps-lock.js";
import { readManifest, createEmptyManifest, writeManifest, addConsumer, upsertRecord } from "./shared-native-deps-manifest.js";
import { stagingDirPath, packageLivePath, resolveSharedNativeRoot } from "./shared-native-deps-paths.js";
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

function manifestReady(manifest: NonNullable<ReturnType<typeof readManifest>>): boolean {
  const nodeMajor = Number(process.version.match(/^v(\d+)/)?.[1]);
  if (nodeMajor !== NATIVE_TARGET_CONTRACT.nodeMajor) return false;
  for (const pkg of NATIVE_TARGET_NAMES) {
    const rec = manifest.packages[pkg];
    if (!rec) return false;
    if (rec.version !== nativeTargetVersion(pkg)) return false;
    if (rec.nodeAbi !== (process.versions?.modules ?? "")) return false;
    if (rec.platform !== process.platform) return false;
    if (rec.arch !== process.arch) return false;
  }
  return true;
}

export function observeNativeGroup(): NativeGroupObservation {
  const packages: NativePackageObs[] = NATIVE_TARGET_NAMES.map(name => ({
    name,
    target: nativeTargetVersion(name),
    observed: observeOne(name),
  }));

  const absent = packages.every(p => p.observed.state === "absent");
  const allInstalledAtTarget = packages.every(p => p.observed.state === "installed" && p.observed.version === p.target);
  const anyInvalid = packages.some(p => p.observed.state === "invalid");
  const anyInstalled = packages.some(p => p.observed.state === "installed");

  const manifest = readManifest();
  const manifestOk = manifest ? manifestReady(manifest) : false;

  let state: NativeGroupState;
  if (absent) state = "absent";
  else if (anyInvalid) state = "invalid";
  else if (allInstalledAtTarget && manifestOk) state = "ready";
  else if (allInstalledAtTarget && !manifestOk) state = "drifted";
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

function hashContent(dir: string): string {
  if (!existsSync(dir)) return "";
  const hash = createHash("sha256");
  try {
    const entries = readdirSync(dir, { recursive: true }) as string[];
    for (const entry of entries.sort()) {
      const full = join(dir, entry);
      try {
        const stat = readdirSync.length > 0; // force import reference
        const content = readFileSync(full);
        hash.update(`${entry}:${content.length}:`);
        hash.update(content);
      } catch { /* skip unreadable entries */ }
    }
  } catch { /* skip */ }
  return hash.digest("hex").slice(0, 16);
}

function liveNmDir(): string {
  return resolveSharedNativeRoot();
}

function stagingNmDir(stagingPrefix: string): string {
  return join(stagingPrefix, "node_modules");
}

function enumerateClosure(stagingPrefix: string): Array<{ name: string; version: string; hash: string }> {
  const nmDir = stagingNmDir(stagingPrefix);
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
      closure.push({ name: entry, version: meta.version, hash: hashContent(pkgDir) });
    } catch { /* skip unreadable */ }
  }
  return closure;
}

function checkCollisions(closure: Array<{ name: string; version: string; hash: string }>, liveRoot: string): string | null {
  for (const pkg of closure) {
    const livePkgDir = join(liveRoot, pkg.name);
    if (!existsSync(livePkgDir)) continue;
    if (NATIVE_TARGET_NAMES.includes(pkg.name as NativeTargetPackage)) continue;
    const liveHash = hashContent(livePkgDir);
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

function cleanStaging(opId: string, stagingPrefix: string): void {
  if (existsSync(stagingPrefix)) {
    try { rmSync(stagingPrefix, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  const markerDir = join(stagingDirPath(), opId);
  if (existsSync(markerDir)) {
    try { rmSync(markerDir, { recursive: true, force: true }); } catch { /* best-effort */ }
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

function runStagedNpm(stagingPrefix: string, actionLabel: string): { ok: boolean; error?: string } {
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
    return { ok: false, error: `npm install failed: ${msg}` };
  }
  return { ok: true };
}

function stageTransaction(
  opId: string,
  stagingPrefix: string,
  product: NativeConsumer,
  token: string,
  actionLabel: string,
): NativeGroupResult {
  const liveRoot = liveNmDir();
  mkdirSync(stagingNmDir(stagingPrefix), { recursive: true });

  const npmResult = runStagedNpm(stagingPrefix, actionLabel);
  if (!npmResult.ok) {
    cleanStaging(opId, stagingPrefix);
    return { action: actionLabel as NativeGroupAction, ok: false, error: npmResult.error };
  }

  const closure = enumerateClosure(stagingPrefix);
  if (closure.length === 0) {
    cleanStaging(opId, stagingPrefix);
    return { action: actionLabel as NativeGroupAction, ok: false, error: "npm produced no packages" };
  }

  for (const pkg of NATIVE_TARGET_NAMES) {
    if (!closure.some(c => c.name === pkg)) {
      cleanStaging(opId, stagingPrefix);
      return { action: actionLabel as NativeGroupAction, ok: false, error: `Target package "${pkg}" not found in npm closure` };
    }
  }

  const collision = checkCollisions(closure, liveRoot);
  if (collision) {
    cleanStaging(opId, stagingPrefix);
    return { action: actionLabel as NativeGroupAction, ok: false, error: collision };
  }

  const nmDir = stagingNmDir(stagingPrefix);
  if (!nativeProbesPass(nmDir)) {
    cleanStaging(opId, stagingPrefix);
    return { action: actionLabel as NativeGroupAction, ok: false, error: "Staged native probes failed" };
  }

  return activateGroup(opId, product, closure, stagingPrefix, token);
}

function refreshNativeGroup(product: NativeConsumer, token: string): NativeGroupResult {
  const opId = `refresh_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const stagingPrefix = join(stagingDirPath(), opId);
  return stageTransaction(opId, stagingPrefix, product, token, "refresh");
}

function repairNativeGroup(product: NativeConsumer, token: string): NativeGroupResult {
  const opId = `repair_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const stagingPrefix = join(stagingDirPath(), opId);
  return stageTransaction(opId, stagingPrefix, product, token, "repair");
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
  const liveRoot = liveNmDir();
  const journal: Array<{ pkg: string; prevPath: string | null }> = [];

  try {
    for (const pkg of closure) {
      const live = join(liveRoot, pkg.name);
      const staged = join(stagingNmDir(stagingPrefix), pkg.name);

      if (!existsSync(staged)) continue;

      if (existsSync(live)) {
        const prev = live + ".prev." + opId;
        renameSync(live, prev);
        journal.push({ pkg: pkg.name, prevPath: prev });
      } else {
        journal.push({ pkg: pkg.name, prevPath: null });
      }
      renameSync(staged, live);
    }

    if (!nativeProbesPass(liveRoot)) {
      rollbackActivation(journal, opId);
      cleanStaging(opId, stagingPrefix);
      return { action: "repair", ok: false, error: "Live native probes failed after activation" };
    }

    const manifest = readManifest() ?? createEmptyManifest();
    for (const pkg of NATIVE_TARGET_NAMES) {
      const closureEntry = closure.find(c => c.name === pkg);
      if (!closureEntry) {
        rollbackActivation(journal, opId);
        cleanStaging(opId, stagingPrefix);
        return { action: "repair", ok: false, error: `Target package "${pkg}" not found in npm closure` };
      }

      const existingRecord = manifest.packages[pkg];
      const existingConsumers = existingRecord?.consumers ?? [];
      const mergedConsumers = [...new Set([...existingConsumers, product])].sort();

      const record: NativePackageRecord = {
        version: nativeTargetVersion(pkg),
        nodeAbi,
        nodeVersion: nv,
        platform: platform as NodeJS.Platform,
        arch,
        contentHash: closureEntry.hash,
        installedAt: new Date().toISOString(),
        installedBy: product,
        consumers: mergedConsumers,
        probe: NATIVE_PROBE_IDS[pkg] ?? "",
      };
      const updated = upsertRecord(manifest, pkg, record);
      Object.assign(manifest, updated);
    }
    writeManifest(manifest);

    cleanupJournal(journal, opId);
    cleanStaging(opId, stagingPrefix);

    return { action: "repair", ok: true };
  } catch (err) {
    rollbackActivation(journal, opId);
    cleanStaging(opId, stagingPrefix);
    return { action: "repair", ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function rollbackActivation(
  journal: Array<{ pkg: string; prevPath: string | null }>,
  opId: string,
): void {
  const liveRoot = liveNmDir();
  for (const entry of journal.reverse()) {
    const live = join(liveRoot, entry.pkg);
    if (entry.prevPath) {
      if (existsSync(live)) {
        try { rmSync(live, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      if (existsSync(entry.prevPath)) {
        try { renameSync(entry.prevPath, live); } catch { /* best-effort */ }
      }
    } else {
      if (existsSync(live)) {
        try { rmSync(live, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }
}

function cleanupJournal(
  journal: Array<{ pkg: string; prevPath: string | null }>,
  opId: string,
): void {
  for (const entry of journal) {
    if (!entry.prevPath) continue;
    if (existsSync(entry.prevPath)) {
      try { rmSync(entry.prevPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
