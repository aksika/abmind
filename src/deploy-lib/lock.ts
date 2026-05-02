/**
 * Update lock: prevents concurrent `install` / `update` / `rollback` runs
 * in the same runtime from colliding.
 *
 * Mechanism: write a JSON pidfile at packagePaths().lock. If file exists and
 * the PID is alive and the mtime is recent (<1h), refuse to proceed. Otherwise
 * take the lock.
 *
 * Stale timeout matches plan: 1 hour (our updates take minutes). Compared to
 * claude-code's 7-day timeout which accommodates laptop sleep during a long
 * install — not applicable for our short-lived updates.
 */

import { readFile, unlink, writeFile } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { hostname } from 'node:os';

const STALE_MS = 60 * 60 * 1000; // 1 hour

export interface LockContent {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  readonly cmd: string;
}

export class LockHeldError extends Error {
  constructor(
    public readonly content: LockContent,
    public readonly isStale: boolean,
  ) {
    const staleMsg = isStale ? ' (appears stale — process may have crashed)' : '';
    super(
      `Lock held by pid ${content.pid} since ${content.startedAt} ` +
        `(cmd: ${content.cmd})${staleMsg}`,
    );
    this.name = 'LockHeldError';
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(path: string): Promise<LockContent | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as LockContent;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Acquire the lock or throw LockHeldError. Returns a release function.
 * Caller must call release() on both success and failure; the returned
 * function is idempotent.
 */
export async function acquireLock(path: string, cmd: string): Promise<() => Promise<void>> {
  const existing = await readLock(path);
  if (existing) {
    const alive = isPidAlive(existing.pid);
    const started = Date.parse(existing.startedAt);
    const age = Date.now() - (Number.isFinite(started) ? started : 0);
    const stale = !alive || age > STALE_MS;
    if (!stale) {
      throw new LockHeldError(existing, false);
    }
    // Stale: fall through and take it, but tell the caller so doctor can surface.
  }

  const content: LockContent = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    cmd,
  };
  await writeFile(path, JSON.stringify(content, null, 2) + '\n', 'utf-8');

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      await unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  };

  // Best-effort cleanup on unexpected exit.
  const exitHandler = (): void => {
    try {
      unlinkSync(path);
    } catch {
      /* ignore — stale detection handles orphans next run */
    }
  };
  process.once('exit', exitHandler);

  return release;
}

export async function inspectLock(path: string): Promise<
  | { held: false }
  | { held: true; content: LockContent; stale: boolean }
> {
  const content = await readLock(path);
  if (!content) return { held: false };
  const alive = isPidAlive(content.pid);
  const started = Date.parse(content.startedAt);
  const age = Date.now() - (Number.isFinite(started) ? started : 0);
  const stale = !alive || age > STALE_MS;
  return { held: true, content, stale };
}
