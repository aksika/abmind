import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { generateLockToken, acquireLock, releaseLock } from "./shared-native-deps-lock.js";
import { readManifest, readManifestRaw, createEmptyManifest, writeManifest, addConsumer, upsertRecord, upsertRecordGroup } from "./shared-native-deps-manifest.js";
import { stagingDirPath, packageLivePath, resolveSharedNativeRoot, manifestFilePath } from "./shared-native-deps-paths.js";
import type { NativeConsumer, NativePackageRecord, SharedNativeManifest } from "./shared-native-deps-types.js";
import { NATIVE_TARGET_CONTRACT, NATIVE_TARGET_NAMES, nativeTargetProbeId, nativeTargetVersion } from "../../cli/lib/native-dep-targets.js";
import type { NativeTargetPackage } from "../../cli/lib/native-dep-targets.js";

export type PkgObsState =
  | { state: "absent" }
  | { state: "invalid"; reason: string }
  | { state: "installed"; version: string };

export type NativeGroupState = "absent" | "partial" | "invalid" | "drifted" | "ready";
export type NativeGroupAction = "reuse" | "repair" | "refresh" | "instruct-install" | "adopt";

export interface NativePackageObs {
  name: NativeTargetPackage;
  target: string;
  observed: PkgObsState;
}

export interface NativeGroupObservation {
  packages: NativePackageObs[];
  state: NativeGroupState;
  adoption:
    | { eligible: false; reason?: string }
    | { eligible: true; closure: NativeClosureEntry[] };
}

export interface NativeGroupResult {
  action: NativeGroupAction;
  ok: boolean;
  error?: string;
  details?: { roots: number; transitives: number };
}

export interface NativeClosureEntry {
  name: string;
  version: string;
  path: string;
  contentHash: string;
  kind: "root" | "transitive";
}

export type ClosureResult =
  | { ok: true; entries: NativeClosureEntry[] }
  | { ok: false; reason: string };

export function nativeClosureProbeId(): string {
  return `native-closure:${NATIVE_TARGET_CONTRACT.contractHash}`;
}

function strictHashContent(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const hash = createHash("sha256");
  try {
    const entries = readdirSync(dir, { recursive: true }) as string[];
    for (const entry of entries.sort()) {
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        const content = readFileSync(full);
        hash.update(`${entry}:${content.length}:`);
        hash.update(content);
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }
  return hash.digest("hex").slice(0, 16);
}

export function resolveClosure(nmDir: string, seedNames: string[]): ClosureResult {
  const visited = new Map<string, NativeClosureEntry>();
  const queue: Array<{ name: string; kind: "root" | "transitive" }> =
    seedNames.map(n => ({ name: n, kind: "root" }));
  // Track all version ranges declared for each transitive dep name
  const depRanges = new Map<string, string[]>();

  while (queue.length > 0) {
    const { name, kind } = queue.shift()!;
    if (visited.has(name)) continue;

    const pkgPath = join(nmDir, name);
    const pkgJsonPath = join(pkgPath, "package.json");

    if (!existsSync(pkgJsonPath)) {
      if (kind === "root") {
        return { ok: false, reason: `Root package "${name}" not found at ${pkgPath}` };
      }
      continue;
    }

    let meta: { name?: string; version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    try {
      meta = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    } catch {
      return { ok: false, reason: `Cannot read or parse package.json for "${name}" at ${pkgJsonPath}` };
    }

    if (typeof meta.name !== "string" || meta.name !== name) {
      return { ok: false, reason: `Package name mismatch in ${pkgJsonPath}: expected "${name}", got "${String(meta.name)}"` };
    }
    if (typeof meta.version !== "string" || !meta.version) {
      return { ok: false, reason: `Missing or invalid "version" for "${name}" in ${pkgJsonPath}` };
    }

    const resolvedPath = realpathSync(pkgPath);
    const nmResolved = realpathSync(nmDir);
    if (!resolvedPath.startsWith(nmResolved + "/")) {
      return { ok: false, reason: `Package "${name}" escapes shared root: ${resolvedPath} not under ${nmResolved}` };
    }

    const h = strictHashContent(pkgPath);
    if (h === null) {
      return { ok: false, reason: `Cannot hash content of "${name}" at ${pkgPath}` };
    }

    visited.set(name, {
      name,
      version: meta.version,
      path: pkgPath,
      contentHash: h,
      kind,
    });

    const runtimeDeps = new Map<string, string>();
    if (meta.dependencies) {
      for (const [depName, range] of Object.entries(meta.dependencies)) {
        runtimeDeps.set(depName, range);
      }
    }
    if (meta.optionalDependencies) {
      for (const [depName, range] of Object.entries(meta.optionalDependencies)) {
        if (existsSync(join(nmDir, depName))) {
          runtimeDeps.set(depName, range);
        }
      }
    }

    // Detect incompatible version ranges for the same transitive name
    for (const [depName, range] of runtimeDeps) {
      const existing = depRanges.get(depName);
      if (existing && !existing.includes(range)) {
        return {
          ok: false,
          reason: `Incompatible version ranges for transitive "${depName}": "${existing[0]}" from prior dependent vs "${range}" from "${name}"`,
        };
      }
      if (!existing) {
        depRanges.set(depName, [range]);
      }
    }

    for (const [depName] of runtimeDeps) {
      if (!visited.has(depName)) {
        queue.push({ name: depName, kind: "transitive" });
      }
    }
  }

  const entries = [...visited.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, entries };
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
  if ((nodeMajor ?? 0) < NATIVE_TARGET_CONTRACT.nodeMajor) return false;
  for (const pkg of NATIVE_TARGET_NAMES) {
    const rec = manifest.packages[pkg];
    if (!rec) return false;
    if (rec.version !== nativeTargetVersion(pkg)) return false;
    if (rec.nodeAbi !== (process.versions?.modules ?? "")) return false;
    if (rec.platform !== process.platform) return false;
    if (rec.arch !== process.arch) return false;
    if (!rec.consumers.includes("abtars") && !rec.consumers.includes("abmind")) return false;
    if (rec.probe !== nativeTargetProbeId(pkg)) return false;
    if (rec.contentHash !== hashContent(packageLivePath(pkg))) return false;
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

  let adoption: { eligible: false; reason?: string } | { eligible: true; closure: NativeClosureEntry[] } = { eligible: false };
  if (state === "drifted" && allInstalledAtTarget) {
    const closureResult = resolveClosure(liveNmDir(), NATIVE_TARGET_NAMES);
    adoption = closureResult.ok
      ? { eligible: true, closure: closureResult.entries }
      : { eligible: false, reason: closureResult.reason };
  }

  return { packages, state, adoption };
}

export function selectNativeGroupAction(operation: "install" | "update", obs: NativeGroupObservation): NativeGroupAction {
  if (operation === "install") {
    switch (obs.state) {
      case "ready": return "reuse";
      case "drifted": return obs.adoption.eligible ? "adopt" : "repair";
      default: return "repair";
    }
  } else {
    switch (obs.state) {
      case "absent": return "instruct-install";
      case "ready": return "refresh";
      case "drifted": return obs.adoption.eligible ? "adopt" : "repair";
      default: return "repair";
    }
  }
}

export function hashContent(dir: string): string {
  if (!existsSync(dir)) return "";
  const hash = createHash("sha256");
  try {
    const entries = readdirSync(dir, { recursive: true }) as string[];
    for (const entry of entries.sort()) {
      const full = join(dir, entry);
      try {
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



type LiveCollisionOwner =
  | { kind: "native-root" }
  | { kind: "native-closure" }
  | { kind: "unrelated-or-untracked" };

function resolveCollisionOwner(
  livePkgDir: string,
  pkgName: string,
  manifest: SharedNativeManifest | null,
): LiveCollisionOwner {
  if (!manifest) return { kind: "unrelated-or-untracked" };
  const rec = manifest.packages[pkgName];
  if (!rec) return { kind: "unrelated-or-untracked" };

  // Root? Check by exact probe ID
  if (NATIVE_TARGET_NAMES.includes(pkgName as NativeTargetPackage)) {
    const expectedProbe = NATIVE_PROBE_IDS[pkgName];
    if (rec.probe === expectedProbe) {
      return { kind: "native-root" };
    }
    return { kind: "unrelated-or-untracked" };
  }

  // Native-closure transitive?
  if (rec.probe === nativeClosureProbeId()) {
    const liveHash = hashContent(livePkgDir);
    let liveVersion = "unknown";
    try {
      const raw = readFileSync(join(livePkgDir, "package.json"), "utf-8");
      liveVersion = (JSON.parse(raw) as { version?: string }).version ?? "unknown";
    } catch { /* fall through */ }
    const runtimeAbi = process.versions?.modules ?? "";
    if (rec.version === liveVersion && rec.contentHash === liveHash &&
        rec.nodeAbi === runtimeAbi &&
        rec.platform === process.platform &&
        rec.arch === process.arch) {
      return { kind: "native-closure" };
    }
  }

  return { kind: "unrelated-or-untracked" };
}

function checkCollisions(
  closure: NativeClosureEntry[],
  liveRoot: string,
  manifest: SharedNativeManifest | null,
): string | null {
  for (const pkg of closure) {
    const livePkgDir = join(liveRoot, pkg.name);
    if (!existsSync(livePkgDir)) continue;

    const owner = resolveCollisionOwner(livePkgDir, pkg.name, manifest);
    if (owner.kind !== "unrelated-or-untracked") continue;

    const liveHash = hashContent(livePkgDir);
    const livePkgJson = join(livePkgDir, "package.json");
    let liveVersion = "unknown";
    try {
      const raw = readFileSync(livePkgJson, "utf-8");
      liveVersion = (JSON.parse(raw) as { version?: string }).version ?? "unknown";
    } catch { /* ignore */ }
    if (pkg.contentHash !== liveHash || pkg.version !== liveVersion) {
      return `Collision with unrelated package "${pkg.name}": staged ${pkg.version}@${pkg.contentHash} conflicts with live ${liveVersion}@${liveHash}. Refusing to overwrite.`;
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

  const nodeMajor = Number(process.version.match(/^v(\d+)/)?.[1]);
  if ((nodeMajor ?? 0) < NATIVE_TARGET_CONTRACT.nodeMajor) {
    return {
      action,
      ok: false,
      error: `Native targets require Node ${NATIVE_TARGET_CONTRACT.nodeMajor}; running ${process.version}.`,
    };
  }

  if (action === "instruct-install") {
    return { action: "instruct-install", ok: false, error: "Native deps not installed. Run: abmind deps install" };
  }

  const token = generateLockToken();
  acquireLock(product, `native:${action}`, token);
  try {
    const lockedObs = observeNativeGroup();
    const lockedAction = selectNativeGroupAction(operation, lockedObs);

    if (lockedAction === "reuse") {
      if (!nativeProbesPass(liveNmDir())) {
        return repairNativeGroup(product, token);
      }
      const manifest = readManifest() ?? createEmptyManifest();
      for (const pkgName of Object.keys(manifest.packages)) {
        const updated = addConsumer(manifest, pkgName, product);
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

    if (lockedAction === "adopt") {
      return adoptNativeGroup(product, token);
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

  const stagedNmDir = stagingNmDir(stagingPrefix);
  const closureResult = resolveClosure(stagedNmDir, NATIVE_TARGET_NAMES);
  if (!closureResult.ok || closureResult.entries.length === 0) {
    cleanStaging(opId, stagingPrefix);
    return { action: actionLabel as NativeGroupAction, ok: false, error: closureResult.ok ? "npm produced no packages" : `Staged closure resolution failed: ${closureResult.reason}` };
  }

  for (const pkg of NATIVE_TARGET_NAMES) {
    if (!closureResult.entries.some(c => c.name === pkg)) {
      cleanStaging(opId, stagingPrefix);
      return { action: actionLabel as NativeGroupAction, ok: false, error: `Target package "${pkg}" not found in npm closure` };
    }
  }

  const manifest = readManifest();
  const collision = checkCollisions(closureResult.entries, liveRoot, manifest);
  if (collision) {
    cleanStaging(opId, stagingPrefix);
    return { action: actionLabel as NativeGroupAction, ok: false, error: collision };
  }

  if (!nativeProbesPass(stagedNmDir)) {
    cleanStaging(opId, stagingPrefix);
    return { action: actionLabel as NativeGroupAction, ok: false, error: "Staged native probes failed" };
  }

  return activateGroup(opId, product, closureResult.entries, stagingPrefix, token, actionLabel);
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

function adoptNativeGroup(product: NativeConsumer, token: string): NativeGroupResult {
  const liveRoot = liveNmDir();
  const nodeAbi = process.versions?.modules ?? "";
  const arch = process.arch;
  const platform = process.platform;
  const nv = process.version;

  const closureResult = resolveClosure(liveRoot, NATIVE_TARGET_NAMES);
  if (!closureResult.ok) {
    return { action: "adopt", ok: false, error: `Adoption closure resolution failed: ${closureResult.reason}` };
  }

  const rootCount = closureResult.entries.filter(e => e.kind === "root").length;
  const transitiveCount = closureResult.entries.filter(e => e.kind === "transitive").length;

  const manifest = readManifest() ?? createEmptyManifest();
  const probeMarker = nativeClosureProbeId();

  // Validate existing manifest records for closure packages
  for (const entry of closureResult.entries) {
    const existing = manifest.packages[entry.name];
    if (!existing) continue;

    const expectedProbe = entry.kind === "root"
      ? NATIVE_PROBE_IDS[entry.name] ?? ""
      : probeMarker;

    if (entry.kind === "root" && existing.probe !== expectedProbe) {
      return { action: "adopt", ok: false, error: `Root "${entry.name}" has unexpected probe "${existing.probe}"` };
    }
    if (entry.kind === "transitive" && existing.probe !== expectedProbe) {
      return { action: "adopt", ok: false, error: `Transitive "${entry.name}" has non-native-closure probe "${existing.probe}"` };
    }
    if (existing.version !== entry.version) {
      return { action: "adopt", ok: false, error: `Existing record for "${entry.name}" version mismatch: manifest ${existing.version}, live ${entry.version}` };
    }
    if (existing.contentHash !== entry.contentHash) {
      return { action: "adopt", ok: false, error: `Existing record for "${entry.name}" hash mismatch` };
    }
    if (existing.nodeAbi !== nodeAbi) {
      return { action: "adopt", ok: false, error: `Existing record for "${entry.name}" ABI mismatch: manifest ${existing.nodeAbi}, runtime ${nodeAbi}` };
    }
    if (existing.platform !== platform) {
      return { action: "adopt", ok: false, error: `Existing record for "${entry.name}" platform mismatch` };
    }
    if (existing.arch !== arch) {
      return { action: "adopt", ok: false, error: `Existing record for "${entry.name}" arch mismatch` };
    }
  }

  if (!nativeProbesPass(liveRoot)) {
    return { action: "adopt", ok: false, error: "Live native probes failed; cannot adopt" };
  }

  const now = new Date().toISOString();
  const records = new Map<string, NativePackageRecord>();

  for (const entry of closureResult.entries) {
    const probe = entry.kind === "root"
      ? NATIVE_PROBE_IDS[entry.name] ?? ""
      : probeMarker;

    const existingRecord = manifest.packages[entry.name];
    const existingConsumers = existingRecord?.consumers ?? [];
    const mergedConsumers = [...new Set([...existingConsumers, product])].sort();

    records.set(entry.name, {
      version: entry.version,
      nodeAbi,
      nodeVersion: nv,
      platform: platform as NodeJS.Platform,
      arch,
      contentHash: entry.contentHash,
      installedAt: now,
      installedBy: product,
      consumers: mergedConsumers,
      probe,
    });
  }

  // Preserve pre-commit manifest bytes for rollback
  const preCommitRaw = readManifestRaw();
  const updated = upsertRecordGroup(manifest, records, now);

  try {
    writeManifest(updated);
  } catch (err) {
    return { action: "adopt", ok: false, error: `Failed to write adopted manifest: ${err instanceof Error ? err.message : String(err)}` };
  }

  const postObs = observeNativeGroup();
  if (postObs.state !== "ready") {
    // Rollback: restore pre-commit manifest bytes atomically
    if (preCommitRaw !== null) {
      try {
        const p = manifestFilePath();
        const tmp = p + ".tmp." + process.pid + ".rollback";
        writeFileSync(tmp, preCommitRaw, { mode: 0o644 });
        renameSync(tmp, p);
      } catch {
        return { action: "adopt", ok: false, error: `Post-adoption observation expected "ready", got "${postObs.state}"; rollback attempted but may have failed` };
      }
    }
    return { action: "adopt", ok: false, error: `Post-adoption observation expected "ready", got "${postObs.state}"; rolled back` };
  }

  return { action: "adopt", ok: true, details: { roots: rootCount, transitives: transitiveCount } };
}

function activateGroup(
  opId: string,
  product: NativeConsumer,
  closure: NativeClosureEntry[],
  stagingPrefix: string,
  token: string,
  actionLabel: string,
): NativeGroupResult {
  const nodeAbi = process.versions?.modules ?? "";
  const arch = process.arch;
  const platform = process.platform;
  const nv = process.version;
  const liveRoot = liveNmDir();
  const journal: Array<{ pkg: string; prevPath: string | null }> = [];

  try {
    for (const entry of closure) {
      const live = join(liveRoot, entry.name);
      const staged = join(stagingNmDir(stagingPrefix), entry.name);

      if (!existsSync(staged)) continue;

      if (existsSync(live)) {
        const prev = live + ".prev." + opId;
        renameSync(live, prev);
        journal.push({ pkg: entry.name, prevPath: prev });
      } else {
        journal.push({ pkg: entry.name, prevPath: null });
      }
      renameSync(staged, live);
    }

    if (!nativeProbesPass(liveRoot)) {
      rollbackActivation(journal, opId);
      cleanStaging(opId, stagingPrefix);
      return { action: "repair", ok: false, error: "Live native probes failed after activation" };
    }

    const manifest = readManifest() ?? createEmptyManifest();
    const now = new Date().toISOString();
    const records = new Map<string, NativePackageRecord>();

    for (const entry of closure) {
      const probe = entry.kind === "root"
        ? (NATIVE_PROBE_IDS[entry.name] ?? "")
        : nativeClosureProbeId();

      const existingRecord = manifest.packages[entry.name];
      const existingConsumers = existingRecord?.consumers ?? [];
      const mergedConsumers = [...new Set([...existingConsumers, product])].sort();

      records.set(entry.name, {
        version: entry.version,
        nodeAbi,
        nodeVersion: nv,
        platform: platform as NodeJS.Platform,
        arch,
        contentHash: entry.contentHash,
        installedAt: now,
        installedBy: product,
        consumers: mergedConsumers,
        probe,
      });
    }

    const updated = upsertRecordGroup(manifest, records, now);
    writeManifest(updated);

    cleanupJournal(journal, opId);
    cleanStaging(opId, stagingPrefix);

    return { action: actionLabel as NativeGroupAction, ok: true };
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
