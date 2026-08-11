import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, inspectLock, LockHeldError } from './lock.js';
import { randomUUID } from 'node:crypto';

function lockDir(path: string): string {
  return path + ".lockdir";
}

function ownerFile(path: string): string {
  return join(lockDir(path), "owner.json");
}

function currentStartIdentity(): string {
  try {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf-8");
    const rp = stat.lastIndexOf(")");
    const fields = rp >= 0 ? stat.slice(rp + 2).split(" ") : stat.split(" ");
    const startTime = fields[19];
    return `${process.pid}:${startTime ?? "0"}`;
  } catch {
    return `${process.pid}:0`;
  }
}

const STALE_MS = 60 * 60 * 1000;

function lockOptions() {
  return { staleMs: STALE_MS, ensureParentDir: true };
}

describe('deploy-lib/lock', () => {
  let tmp: string;
  let lockPath: string;
  beforeEach(async () => {
    const base = join(homedir(), '.cache', 'abmind-test');
    await mkdir(base, { recursive: true });
    tmp = await mkdtemp(join(base, 'deploy-lib-lock-'));
    lockPath = join(tmp, '.update.lock');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('acquireLock succeeds when no lock exists', async () => {
    const release = await acquireLock(lockPath, 'test', lockOptions());
    const content = JSON.parse(await readFile(ownerFile(lockPath), 'utf-8'));
    expect(content.pid).toBe(process.pid);
    expect(content.cmd).toBe('test');
    await release();
  });

  it('acquireLock throws LockHeldError when another live process holds it', async () => {
    const owner = { token: randomUUID(), pid: process.pid, startIdentity: currentStartIdentity(), host: 'h', startedAt: new Date().toISOString(), cmd: 'other-command' };
    mkdirSync(lockDir(lockPath), { recursive: true });
    writeFileSync(ownerFile(lockPath), JSON.stringify(owner));
    await expect(acquireLock(lockPath, 'test', lockOptions())).rejects.toBeInstanceOf(LockHeldError);
  });

  it('acquireLock steals stale lock from dead PID', async () => {
    const owner = { token: randomUUID(), pid: 999_999_999, startIdentity: '999999999:0', host: 'h', startedAt: new Date().toISOString(), cmd: 'crashed' };
    mkdirSync(lockDir(lockPath), { recursive: true });
    writeFileSync(ownerFile(lockPath), JSON.stringify(owner));
    const release = await acquireLock(lockPath, 'test', lockOptions());
    const after = JSON.parse(await readFile(ownerFile(lockPath), 'utf-8'));
    expect(after.pid).toBe(process.pid);
    await release();
  });

  it('acquireLock steals stale lock from old timestamp', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * STALE_MS).toISOString();
    const owner = { token: randomUUID(), pid: process.pid, startIdentity: currentStartIdentity(), host: 'h', startedAt: twoHoursAgo, cmd: 'stuck' };
    mkdirSync(lockDir(lockPath), { recursive: true });
    writeFileSync(ownerFile(lockPath), JSON.stringify(owner));
    const release = await acquireLock(lockPath, 'test', lockOptions());
    const after = JSON.parse(await readFile(ownerFile(lockPath), 'utf-8'));
    expect(after.startedAt).not.toBe(twoHoursAgo);
    await release();
  });

  it('ensureParentDir creates missing parent', async () => {
    const deepPath = join(tmp, 'nested', 'dir', '.update.lock');
    const release = await acquireLock(deepPath, 'test', lockOptions());
    const content = JSON.parse(await readFile(ownerFile(deepPath), 'utf-8'));
    expect(content.pid).toBe(process.pid);
    await release();
  });

  it('release is idempotent', async () => {
    const release = await acquireLock(lockPath, 'test', lockOptions());
    await release();
    await expect(release()).resolves.toBeUndefined();
  });

  it('release removes the lockfile', async () => {
    const release = await acquireLock(lockPath, 'test', lockOptions());
    await release();
    const { stat } = await import('node:fs/promises');
    await expect(stat(lockDir(lockPath))).rejects.toThrow();
  });

  it('inspectLock reports not held when absent', async () => {
    const r = await inspectLock(lockPath);
    expect(r).toEqual({ held: false });
  });

  it('inspectLock reports held + live for fresh lock', async () => {
    const release = await acquireLock(lockPath, 'test', lockOptions());
    const r = await inspectLock(lockPath);
    expect(r.held).toBe(true);
    if (r.held) {
      expect(r.stale).toBe(false);
      expect(r.content.pid).toBe(process.pid);
    }
    await release();
  });

  it('inspectLock reports stale for dead PID', async () => {
    const owner = { token: randomUUID(), pid: 999_999_999, startIdentity: '999999999:0', host: 'h', startedAt: new Date().toISOString(), cmd: 'crashed' };
    mkdirSync(lockDir(lockPath), { recursive: true });
    writeFileSync(ownerFile(lockPath), JSON.stringify(owner));
    const r = await inspectLock(lockPath);
    expect(r.held).toBe(true);
    if (r.held) expect(r.stale).toBe(true);
  });

  it('inspectLock respects staleMs option', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * STALE_MS).toISOString();
    const owner = { token: randomUUID(), pid: process.pid, startIdentity: currentStartIdentity(), host: 'h', startedAt: twoHoursAgo, cmd: 'old' };
    mkdirSync(lockDir(lockPath), { recursive: true });
    writeFileSync(ownerFile(lockPath), JSON.stringify(owner));
    const r = await inspectLock(lockPath, { staleMs: STALE_MS });
    expect(r.held).toBe(true);
    if (r.held) expect(r.stale).toBe(true);
  });
});
