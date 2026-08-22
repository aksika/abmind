import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { abmindHome } from "./mem-paths.js";

export interface OwnerLeaseRecordV1 {
  version: 1;
  instanceId: string;
  pid: number;
  processStartToken: string;
  mode: "embedded" | "daemon";
  acquiredAt: number;
}

export interface ProcessIdentityProvider {
  captureSelf(): Promise<{ pid: number; startToken: string }>;
  inspect(pid: number): Promise<
    | { state: "live"; startToken: string }
    | { state: "dead" }
    | { state: "unknown"; reason: string }
  >;
}

export class LinuxProcessIdentity implements ProcessIdentityProvider {
  async captureSelf(): Promise<{ pid: number; startToken: string }> {
    const pid = process.pid;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const startTime = this.parseStartTime(stat);
    if (startTime === null) throw new Error("Cannot parse /proc/self/stat");
    const bootId = this.readBootId();
    const startToken = `${bootId}-${startTime}`;
    return { pid, startToken };
  }

  async inspect(pid: number): Promise<{ state: "live"; startToken: string } | { state: "dead" } | { state: "unknown"; reason: string }> {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      const stateChar = this.parseState(stat);
      if (stateChar === null) return { state: "unknown", reason: "Cannot parse /proc/pid/stat" };
      if (stateChar === "Z" || stateChar === "X") return { state: "dead" };
      const startTime = this.parseStartTime(stat);
      if (startTime === null) return { state: "unknown", reason: "Cannot parse /proc/pid/stat start time" };
      const bootId = this.readBootId();
      const startToken = `${bootId}-${startTime}`;
      return { state: "live", startToken };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return { state: "dead" };
      if (e.code === "EACCES" || e.code === "EPERM") return { state: "unknown", reason: `Permission denied: ${e.message}` };
      return { state: "unknown", reason: e.message };
    }
  }

  private readBootId(): string {
    try {
      return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    } catch {
      return "unknown-boot";
    }
  }

  private parseState(stat: string): string | null {
    const spaceIdx = stat.indexOf(" ");
    if (spaceIdx === -1) return null;
    const afterPid = stat.slice(spaceIdx + 1);
    const closeParen = afterPid.lastIndexOf(")");
    if (closeParen === -1) return null;
    const afterComm = afterPid.slice(closeParen + 2);
    const fields = afterComm.split(/\s+/);
    return fields[0] ?? null;
  }

  private parseStartTime(stat: string): string | null {
    const spaceIdx = stat.indexOf(" ");
    if (spaceIdx === -1) return null;
    const afterPid = stat.slice(spaceIdx + 1);
    const closeParen = afterPid.lastIndexOf(")");
    if (closeParen === -1) return null;
    const afterComm = afterPid.slice(closeParen + 2);
    const fields = afterComm.split(/\s+/);
    // Field 21 (1-indexed in full stat) = starttime (jiffies after boot).
    // After removing pid+comm, this is fields[19] (0-indexed).
    // In kernels where itrealvalue (field 21) was removed, field 21 = starttime,
    // making it fields[18] after removal. Try 19 first, then 18.
    if (fields.length > 20) return fields[19] ?? null;
    if (fields.length > 19) return fields[18] ?? null;
    return null;
  }
}

interface MacPsRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

type MacPsRunner = (pid: number) => MacPsRunResult;

type MacProcessObservation =
  | { state: "live"; startTime: string }
  | { state: "dead" }
  | { state: "unknown"; reason: string };

function runMacPs(pid: number): MacPsRunResult {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf-8",
    timeout: 5000,
    env: { LC_ALL: "C" },
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  return result.error
    ? { status: result.status, signal: result.signal, stdout, stderr, error: result.error }
    : { status: result.status, signal: result.signal, stdout, stderr };
}

function classifyMacPs(result: MacPsRunResult): MacProcessObservation {
  if (result.error) return { state: "unknown", reason: "spawn_failed" };
  if (result.signal !== null) return { state: "unknown", reason: "probe_terminated" };
  if (result.status === null) return { state: "unknown", reason: "unexpected_result" };
  if (result.stderr.trim() !== "") return { state: "unknown", reason: "stderr_output" };
  if (result.status === 0) {
    const lines = result.stdout.trim().split("\n").filter((line) => line.trim() !== "");
    const startTime = lines.length === 1 ? lines[0]?.trim() : undefined;
    if (startTime) return { state: "live", startTime };
    return { state: "unknown", reason: "malformed_live_output" };
  }
  if (result.status === 1 && result.stdout.trim() === "") return { state: "dead" };
  return { state: "unknown", reason: "unexpected_result" };
}

export class MacOsProcessIdentity implements ProcessIdentityProvider {
  private readonly runPs: MacPsRunner;

  constructor(runner?: MacPsRunner) {
    this.runPs = runner ?? runMacPs;
  }

  async captureSelf(): Promise<{ pid: number; startToken: string }> {
    const pid = process.pid;
    const observation = classifyMacPs(this.runPs(pid));
    if (observation.state !== "live") {
      const detail = observation.state === "dead" ? "process not found" : observation.reason;
      throw new Error(`Cannot establish current process identity (pid ${pid}): ${detail}`);
    }
    return { pid, startToken: `mac-${pid}-${observation.startTime}` };
  }

  async inspect(pid: number): Promise<{ state: "live"; startToken: string } | { state: "dead" } | { state: "unknown"; reason: string }> {
    const observation = classifyMacPs(this.runPs(pid));
    if (observation.state === "live") return { state: "live", startToken: `mac-${pid}-${observation.startTime}` };
    if (observation.state === "dead") return { state: "dead" };
    return { state: "unknown", reason: observation.reason };
  }
}

export class InjectableProcessIdentity implements ProcessIdentityProvider {
  private self: { pid: number; startToken: string };
  private inspections: Map<number, { state: "live"; startToken: string } | { state: "dead" } | { state: "unknown"; reason: string }> = new Map();

  constructor(self: { pid: number; startToken: string }) {
    this.self = self;
  }

  setInspectResult(pid: number, result: { state: "live"; startToken: string } | { state: "dead" } | { state: "unknown"; reason: string }): void {
    this.inspections.set(pid, result);
  }

  async captureSelf(): Promise<{ pid: number; startToken: string }> {
    return this.self;
  }

  async inspect(pid: number): Promise<{ state: "live"; startToken: string } | { state: "dead" } | { state: "unknown"; reason: string }> {
    return this.inspections.get(pid) ?? { state: "unknown", reason: "No mock set" };
  }
}

export function createProcessIdentityProvider(): ProcessIdentityProvider {
  if (process.platform === "darwin") return new MacOsProcessIdentity();
  return new LinuxProcessIdentity();
}

export interface OwnerLeaseConfig {
  runRoot: string;
  databasePath: string;
  mode: "embedded" | "daemon";
  processIdentity: ProcessIdentityProvider;
}

export interface OwnerLease {
  readonly instanceId: string;
  readonly state: "acquired" | "released";
  acquire(): Promise<void>;
  release(): Promise<void>;
}

function canonicalDatabaseIdentity(databasePath: string): string {
  const resolved = resolve(databasePath);
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    try {
      const parent = realpathSync(dirname(resolved));
      real = join(parent, basename(resolved));
    } catch {
      real = resolved;
    }
  }
  return createHash("sha256").update(real, "utf-8").digest("hex");
}

function leasePath(leaseRoot: string, hash: string): string {
  return join(leaseRoot, "owners", `${hash}.lease`);
}

function candidatePath(leaseRoot: string, hash: string, instanceId: string): string {
  return join(leaseRoot, "owners", `.candidate-${instanceId}-${hash}`);
}

function tombstonePath(leaseRoot: string, hash: string, instanceId: string): string {
  const random = randomUUID().slice(0, 8);
  return join(leaseRoot, "owners", `.stale-${instanceId}-${hash}-${random}`);
}

export async function createOwnerLease(config: OwnerLeaseConfig): Promise<OwnerLease> {
  const instanceId = randomUUID();
  const dbHash = canonicalDatabaseIdentity(config.databasePath);
  // Lease identity must not depend on a caller's spelling of runRoot. The
  // service host normally passes its memory directory, which may be a
  // symlink/alias in different processes. Canonicalize it once so all
  // instances contend on the same filesystem lease path.
  const resolvedRunRoot = resolve(config.runRoot);
  const leaseRoot = (() => {
    try { return realpathSync(resolvedRunRoot); }
    catch {
      try { return join(realpathSync(dirname(resolvedRunRoot)), basename(resolvedRunRoot)); }
      catch { return resolvedRunRoot; }
    }
  })();
  mkdirSync(join(leaseRoot, "owners"), { recursive: true, mode: 0o700 });

  let state: "acquired" | "released" = "released";

  const doAcquire = async (): Promise<void> => {
    const self = await config.processIdentity.captureSelf();
    const record: OwnerLeaseRecordV1 = {
      version: 1,
      instanceId,
      pid: self.pid,
      processStartToken: self.startToken,
      mode: config.mode,
      acquiredAt: Date.now(),
    };

    const target = leasePath(leaseRoot, dbHash);
    const candidate = candidatePath(leaseRoot, dbHash, instanceId);

    mkdirSync(candidate, { recursive: true });
    writeFileSync(join(candidate, "owner.json"), JSON.stringify(record, null, 2) + "\n", "utf-8");

    if (existsSync(target)) {
      const existing = JSON.parse(readFileSync(join(target, "owner.json"), "utf-8")) as OwnerLeaseRecordV1;

      if (existing.instanceId === instanceId) {
        rmSync(candidate, { recursive: true, force: true });
        state = "acquired";
        return;
      }

      const inspection = await config.processIdentity.inspect(existing.pid);

      if (inspection.state === "live" && inspection.startToken === existing.processStartToken) {
        rmSync(candidate, { recursive: true, force: true });
        throw new OwnerLeaseError(`Database ${config.databasePath} is already owned by pid ${existing.pid} (${existing.mode})`);
      }

      if (inspection.state === "unknown") {
        rmSync(candidate, { recursive: true, force: true });
        throw new OwnerLeaseError(`Cannot verify whether pid ${existing.pid} is alive: ${inspection.reason}. Failing closed.`);
      }

      const tombstone = tombstonePath(leaseRoot, dbHash, instanceId);
      renameSync(target, tombstone);

      // Re-read the tombstone and verify it's still the same owner we inspected.
      // If another process acquired in the gap, restore from tombstone and yield.
      try {
        const tombstoneRecord = JSON.parse(readFileSync(join(tombstone, "owner.json"), "utf-8")) as OwnerLeaseRecordV1;
        if (tombstoneRecord.pid !== existing.pid || tombstoneRecord.processStartToken !== existing.processStartToken || tombstoneRecord.instanceId !== existing.instanceId) {
          renameSync(tombstone, target);
          rmSync(candidate, { recursive: true, force: true });
          throw new OwnerLeaseError(`Database ${config.databasePath} was acquired by another process during stale recovery`);
        }
      } catch (err) {
        if (err instanceof OwnerLeaseError) throw err;
        // Can't read tombstone — likely racing, yield safely
        try { renameSync(tombstone, target); } catch { /* best effort */ }
        rmSync(candidate, { recursive: true, force: true });
        throw new OwnerLeaseError(`Database ${config.databasePath} had an unreadable tombstone — yielding`);
      }
    }

    try {
      renameSync(candidate, target);
      state = "acquired";
    } catch {
      rmSync(candidate, { recursive: true, force: true });
      throw new OwnerLeaseError(`Database ${config.databasePath} was acquired by another process`);
    }
  };

  const doRelease = async (): Promise<void> => {
    if (state !== "acquired") return;
    const target = leasePath(leaseRoot, dbHash);
    try {
      if (!existsSync(join(target, "owner.json"))) return;
      const existing = JSON.parse(readFileSync(join(target, "owner.json"), "utf-8")) as OwnerLeaseRecordV1;
      if (existing.instanceId !== instanceId) return;
      rmSync(target, { recursive: true, force: true });
    } catch {
      // best effort
    }
    state = "released";
  };

  return {
    get instanceId() { return instanceId; },
    get state() { return state; },
    acquire: doAcquire,
    release: doRelease,
  };
}

export class OwnerLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerLeaseError";
  }
}

export function getCanonicalLeaseDir(): string {
  return join(abmindHome(), "run", "leases");
}

/**
 * Read the current owner-lease record for the standard memory database,
 * without acquiring or contending for it. Returns null if no lease is held.
 * Used by service lifecycle code to detect an unsupervised daemon process
 * before install/start so it can be stopped rather than silently competing
 * with a newly launchd-supervised instance for the same lease.
 */
export function readCurrentOwnerLease(memoryDbPath: string): OwnerLeaseRecordV1 | null {
  const leaseRoot = getCanonicalLeaseDir();
  const dbHash = canonicalDatabaseIdentity(memoryDbPath);
  const target = leasePath(leaseRoot, dbHash);
  try {
    return JSON.parse(readFileSync(join(target, "owner.json"), "utf-8")) as OwnerLeaseRecordV1;
  } catch {
    return null;
  }
}

export function cleanTombstones(leaseDir?: string): void {
  const ownersDir = leaseDir ?? getCanonicalLeaseDir();
  if (!existsSync(ownersDir)) return;
  try {
    for (const entry of readdirSync(ownersDir)) {
      if (entry.startsWith(".stale-")) {
        const fullPath = join(ownersDir, entry);
        try { rmSync(fullPath, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }
}
