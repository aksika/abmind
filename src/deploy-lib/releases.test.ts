import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activate, hashFile, listReleases, pruneReleases, readCurrent, releaseExists, RETENTION } from './releases.js';

describe('deploy-lib/releases', () => {
  let tmp: string;
  beforeEach(async () => {
    const base = join(homedir(), '.cache', 'abmind-test');
    await mkdir(base, { recursive: true });
    tmp = await mkdtemp(join(base, 'deploy-lib-releases-'));
    await mkdir(join(tmp, 'releases'), { recursive: true });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('listReleases returns empty for missing dir', async () => {
    expect(await listReleases(join(tmp, 'no-such'))).toEqual([]);
  });

  it('listReleases returns sorted version dirs', async () => {
    await mkdir(join(tmp, 'releases', 'v0.2.0'));
    await mkdir(join(tmp, 'releases', 'v0.1.0'));
    await mkdir(join(tmp, 'releases', 'v0.3.0'));
    expect(await listReleases(join(tmp, 'releases'))).toEqual(['v0.1.0', 'v0.2.0', 'v0.3.0']);
  });

  it('activate creates current symlink pointing at relative releases/<v>', async () => {
    await mkdir(join(tmp, 'releases', 'v1'), { recursive: true });
    await activate(join(tmp, 'current'), 'v1');
    const { readlink } = await import('node:fs/promises');
    expect(await readlink(join(tmp, 'current'))).toBe(join('releases', 'v1'));
    expect(await readCurrent(join(tmp, 'current'))).toBe('v1');
  });

  it('activate is atomic (flips over existing symlink)', async () => {
    await mkdir(join(tmp, 'releases', 'v1'));
    await mkdir(join(tmp, 'releases', 'v2'));
    await activate(join(tmp, 'current'), 'v1');
    await activate(join(tmp, 'current'), 'v2');
    expect(await readCurrent(join(tmp, 'current'))).toBe('v2');
    // No leftover .new file.
    await expect(stat(join(tmp, 'current.new'))).rejects.toThrow();
  });

  it('activate cleans up stale .new from a crashed prior run', async () => {
    await mkdir(join(tmp, 'releases', 'v1'));
    // Simulate prior crash: .new exists, pointing nowhere useful.
    const { symlink } = await import('node:fs/promises');
    await symlink('stale-target', join(tmp, 'current.new'));
    await activate(join(tmp, 'current'), 'v1');
    expect(await readCurrent(join(tmp, 'current'))).toBe('v1');
  });

  it('readCurrent returns null if current symlink is absent', async () => {
    expect(await readCurrent(join(tmp, 'current'))).toBeNull();
  });

  it('pruneReleases keeps retained + current, removes the rest', async () => {
    const versions = ['v1', 'v2', 'v3', 'v4', 'v5'];
    for (const v of versions) await mkdir(join(tmp, 'releases', v));
    // v5 is current, activation order is v5 newest first.
    const pruned = await pruneReleases(
      join(tmp, 'releases'),
      ['v5', 'v4', 'v3', 'v2', 'v1'],
      'v5',
      3,
    );
    expect(pruned.sort()).toEqual(['v1', 'v2']);
    expect(await listReleases(join(tmp, 'releases'))).toEqual(['v3', 'v4', 'v5']);
  });

  it('pruneReleases never removes currentVersion', async () => {
    await mkdir(join(tmp, 'releases', 'v1'));
    await mkdir(join(tmp, 'releases', 'v2'));
    // Activation order doesn't include v1 — but v1 is current.
    const pruned = await pruneReleases(join(tmp, 'releases'), ['v2'], 'v1', 1);
    expect(pruned).toEqual([]);
    expect(await listReleases(join(tmp, 'releases'))).toEqual(['v1', 'v2']);
  });

  it('releaseExists requires dist/ subdir', async () => {
    await mkdir(join(tmp, 'releases', 'v1'));
    expect(await releaseExists(join(tmp, 'releases'), 'v1')).toBe(false);
    await mkdir(join(tmp, 'releases', 'v1', 'dist'));
    expect(await releaseExists(join(tmp, 'releases'), 'v1')).toBe(true);
    expect(await releaseExists(join(tmp, 'releases'), 'v99')).toBe(false);
  });

  it('hashFile returns null for missing file', async () => {
    expect(await hashFile(join(tmp, 'missing'))).toBeNull();
  });

  it('hashFile is stable for same content', async () => {
    const p = join(tmp, 'f');
    await writeFile(p, 'hello');
    const h1 = await hashFile(p);
    const h2 = await hashFile(p);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('RETENTION is 3 (matches plan)', () => {
    expect(RETENTION).toBe(3);
  });
});
