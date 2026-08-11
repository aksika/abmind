import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync, statSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export interface AcquireLockOptions {
  readonly staleMs?: number;
  readonly ensureParentDir?: boolean;
}

export interface LockContent {
  readonly token: string;
  readonly pid: number;
  readonly startIdentity: string;
  readonly host: string;
  readonly startedAt: string;
  readonly cmd: string;
}

export class LockHeldError extends Error {
  constructor(
    public readonly content: LockContent,
    public readonly isStale: boolean,
  ) {
    const staleMsg = isStale ? " (appears stale — process may have crashed)" : "";
    super(
      `Lock held by pid ${content.pid} since ${content.startedAt} ` +
        `(cmd: ${content.cmd})${staleMsg}`,
    );
    this.name = "LockHeldError";
  }
}

function processStartIdentity(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const rp = stat.lastIndexOf(")");
    if (rp < 0) return `${pid}:0`;
    const fields = stat.slice(rp + 2).split(" ");
    const startTime = fields[19];
    return `${pid}:${startTime ?? "0"}`;
  } catch {
    return `${pid}:0`;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeAtomic(target: string, data: string): void {
  const tmp = target + ".tmp." + randomUUID().slice(0, 8);
  writeFileSync(tmp, data, "utf-8");
  const fd = openSync(tmp, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, target);
}

const LOCK_OWNER_FILE = "owner.json";

function releaseLockDirectory(lockDir: string, token: string): void {
  const ownerPath = lockDir + "/" + LOCK_OWNER_FILE;
  const owner = readJsonSafe<LockContent>(ownerPath);
  if (owner && owner.token === token) {
    const releasedPath = lockDir + ".released." + randomUUID().slice(0, 8);
    try { renameSync(lockDir, releasedPath); } catch { return; }
    rmSync(releasedPath, { recursive: true, force: true });
  }
}

function isLockStale(_lockDir: string, content: LockContent, staleMs?: number): boolean {
  const alive = isPidAlive(content.pid);
  const startOk = processStartIdentity(content.pid) === content.startIdentity;
  if (!alive || !startOk) return true;
  if (staleMs !== undefined) {
    const started = Date.parse(content.startedAt);
    const age = Date.now() - (Number.isFinite(started) ? started : 0);
    if (age > staleMs) return true;
  }
  return false;
}

export async function acquireLock(path: string, cmd: string, options?: AcquireLockOptions): Promise<() => Promise<void>> {
  const lockDir = path + ".lockdir";
  const staleMs = options?.staleMs;
  const ensureParentDir = options?.ensureParentDir;

  if (ensureParentDir) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const existing = readJsonSafe<LockContent>(lockDir + "/" + LOCK_OWNER_FILE);
  if (existing) {
    if (!isLockStale(lockDir, existing, staleMs)) {
      throw new LockHeldError(existing, false);
    }
    const tombstone = lockDir + ".stale." + randomUUID().slice(0, 8);
    try {
      renameSync(lockDir, tombstone);
    } catch {
      // Another contender took it
    }
  }

  const content: LockContent = {
    token: randomUUID(),
    pid: process.pid,
    startIdentity: processStartIdentity(process.pid),
    host: hostname(),
    startedAt: new Date().toISOString(),
    cmd,
  };

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      mkdirSync(lockDir);
      writeAtomic(lockDir + "/" + LOCK_OWNER_FILE, JSON.stringify(content, null, 2) + "\n");
      break;
    } catch {
      const recheck = readJsonSafe<LockContent>(lockDir + "/" + LOCK_OWNER_FILE);
      if (recheck) {
        if (isLockStale(lockDir, recheck, staleMs)) {
          const tombstone = lockDir + ".stale." + randomUUID().slice(0, 8);
          try {
            renameSync(lockDir, tombstone);
            continue;
          } catch {
            // Another contender renamed it
          }
        }
      } else {
        try {
          if (Date.now() - statSync(lockDir).mtimeMs > 1000) {
            const tombstone = lockDir + ".stale." + randomUUID().slice(0, 8);
            try { renameSync(lockDir, tombstone); rmSync(tombstone, { recursive: true, force: true }); continue; } catch { /* contender won */ }
          }
        } catch { /* lock disappeared */ }
      }
      if (attempt < 50) {
        await new Promise((r) => setTimeout(r, 50));
      } else {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  const verify = readJsonSafe<LockContent>(lockDir + "/" + LOCK_OWNER_FILE);
  if (!verify || verify.token !== content.token) {
    throw new LockHeldError(verify ?? content, false);
  }

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    releaseLockDirectory(lockDir, content.token);
  };

  const exitHandler = (): void => {
    releaseLockDirectory(lockDir, content.token);
  };
  process.once("exit", exitHandler);

  return release;
}

export async function inspectLock(path: string, options?: { staleMs?: number }): Promise<
  | { held: false }
  | { held: true; content: LockContent; stale: boolean }
> {
  const lockDir = path + ".lockdir";
  const content = readJsonSafe<LockContent>(lockDir + "/" + LOCK_OWNER_FILE);
  if (!content) return { held: false };
  const stale = !isPidAlive(content.pid) ||
    processStartIdentity(content.pid) !== content.startIdentity ||
    (options?.staleMs !== undefined && (Date.now() - (Number.isFinite(Date.parse(content.startedAt)) ? Date.parse(content.startedAt) : 0)) > options.staleMs);
  return { held: true, content, stale };
}
