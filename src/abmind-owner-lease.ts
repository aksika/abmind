import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

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

export class MacOsProcessIdentity implements ProcessIdentityProvider {
  async captureSelf(): Promise<{ pid: number; startToken: string }> {
    const pid = process.pid;
    const startTime = this.getStartTime(pid);
    return { pid, startToken: `mac-${pid}-${startTime}` };
  }

  async inspect(pid: number): Promise<{ state: "live"; startToken: string } | { state: "dead" } | { state: "unknown"; reason: string }> {
    try {
      const stdout = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "axo", "pid"], {
        encoding: "utf-8",
        timeout: 5000,
        env: { LC_ALL: "C" },
      }).trim();
      if (!stdout) return { state: "dead" };
      const startTime = this.getStartTime(pid);
      return { state: "live", startToken: `mac-${pid}-${startTime}` };
    } catch (err) {
      const e = err as Error;
      return { state: "unknown", reason: e.message };
    }
  }

  private getStartTime(pid: number): string {
    try {
      const stdout = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf-8",
        timeout: 5000,
        env: { LC_ALL: "C" },
      }).trim();
      return stdout || String(Date.now());
    } catch {
      return String(Date.now());
    }
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
    real = resolved;
  }
  return createHash("sha256").update(real, "utf-8").digest("hex");
}

function leasePath(runRoot: string, hash: string): string {
  return join(runRoot, "owners", `${hash}.lease`);
}

function candidatePath(runRoot: string, hash: string, instanceId: string): string {
  return join(runRoot, "owners", `.candidate-${instanceId}-${hash}`);
}

function tombstonePath(runRoot: string, hash: string, instanceId: string): string {
  const random = randomUUID().slice(0, 8);
  return join(runRoot, "owners", `.stale-${instanceId}-${hash}-${random}`);
}

export async function createOwnerLease(config: OwnerLeaseConfig): Promise<OwnerLease> {
  const instanceId = randomUUID();
  const dbHash = canonicalDatabaseIdentity(config.databasePath);
  const ownersDir = join(config.runRoot, "owners");
  mkdirSync(ownersDir, { recursive: true });

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

    const target = leasePath(config.runRoot, dbHash);
    const candidate = candidatePath(config.runRoot, dbHash, instanceId);

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

      const tombstone = tombstonePath(config.runRoot, dbHash, instanceId);
      renameSync(target, tombstone);
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
    const target = leasePath(config.runRoot, dbHash);
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

export function cleanTombstones(runRoot: string): void {
  const ownersDir = join(runRoot, "owners");
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
