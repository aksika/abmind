import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, inspectLock, LockHeldError } from './lock.js';

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
    const release = await acquireLock(lockPath, 'test');
    const content = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(content.pid).toBe(process.pid);
    expect(content.cmd).toBe('test');
    await release();
  });

  it('acquireLock throws LockHeldError when another live process holds it', async () => {
    // Write a lock with our own PID so isPidAlive returns true.
    const content = {
      pid: process.pid,
      host: 'h',
      startedAt: new Date().toISOString(),
      cmd: 'other-command',
    };
    await writeFile(lockPath, JSON.stringify(content), 'utf-8');
    await expect(acquireLock(lockPath, 'test')).rejects.toBeInstanceOf(LockHeldError);
  });

  it('acquireLock steals stale lock from dead PID', async () => {
    // PID 1 might be init and alive on some systems; use a very high one that's
    // essentially guaranteed not to exist.
    const content = {
      pid: 999_999_999,
      host: 'h',
      startedAt: new Date().toISOString(),
      cmd: 'crashed',
    };
    await writeFile(lockPath, JSON.stringify(content), 'utf-8');
    const release = await acquireLock(lockPath, 'test');
    const after = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(after.pid).toBe(process.pid);
    await release();
  });

  it('acquireLock steals stale lock from old timestamp', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const content = {
      pid: process.pid, // Our PID is alive, but timestamp is too old.
      host: 'h',
      startedAt: twoHoursAgo,
      cmd: 'stuck',
    };
    await writeFile(lockPath, JSON.stringify(content), 'utf-8');
    const release = await acquireLock(lockPath, 'test');
    const after = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(after.startedAt).not.toBe(twoHoursAgo);
    await release();
  });

  it('release is idempotent', async () => {
    const release = await acquireLock(lockPath, 'test');
    await release();
    await expect(release()).resolves.toBeUndefined();
  });

  it('release removes the lockfile', async () => {
    const release = await acquireLock(lockPath, 'test');
    await release();
    const { stat } = await import('node:fs/promises');
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('inspectLock reports not held when absent', async () => {
    const r = await inspectLock(lockPath);
    expect(r).toEqual({ held: false });
  });

  it('inspectLock reports held + live for fresh lock', async () => {
    const release = await acquireLock(lockPath, 'test');
    const r = await inspectLock(lockPath);
    expect(r.held).toBe(true);
    if (r.held) {
      expect(r.stale).toBe(false);
      expect(r.content.pid).toBe(process.pid);
    }
    await release();
  });

  it('inspectLock reports stale for dead PID', async () => {
    const content = {
      pid: 999_999_999,
      host: 'h',
      startedAt: new Date().toISOString(),
      cmd: 'crashed',
    };
    await writeFile(lockPath, JSON.stringify(content), 'utf-8');
    const r = await inspectLock(lockPath);
    expect(r.held).toBe(true);
    if (r.held) expect(r.stale).toBe(true);
  });
});
