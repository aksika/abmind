import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyManifest, readManifest, writeManifest, type Manifest } from './manifest.js';

describe('deploy-lib/manifest', () => {
  let tmp: string;
  beforeEach(async () => {
    const base = join(homedir(), '.cache', 'abmind-test');
    await mkdir(base, { recursive: true });
    tmp = await mkdtemp(join(base, 'deploy-lib-manifest-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('readManifest returns null if file is missing', async () => {
    expect(await readManifest(join(tmp, 'absent.json'))).toBeNull();
  });

  it('round-trips a manifest', async () => {
    const path = join(tmp, 'manifest.json');
    const original: Manifest = {
      ...emptyManifest('abtars', 'test-host'),
      version: 'v1.2.3',
      commit: 'abc1234',
      branch: 'dev',
      packageLockHash: 'deadbeef',
      source: 'local',
      migrationsApplied: ['001-env-memory-to-config'],
      priorReleases: [
        { version: 'v1.2.2', commit: 'abc1233', activatedAt: '2026-04-01T00:00:00Z', packageLockHash: 'cafebabe' },
      ],
    };
    await writeManifest(path, original);
    const round = await readManifest(path);
    expect(round).toEqual(original);
  });

  it('emptyManifest produces a fresh-install shape', () => {
    const m = emptyManifest('abmind', 'kp');
    expect(m.package).toBe('abmind');
    expect(m.host).toBe('kp');
    expect(m.version).toBe('');
    expect(m.migrationsApplied).toHaveLength(0);
    expect(m.priorReleases).toHaveLength(0);
    expect(m.preMigrationBackup).toBeNull();
  });

  it('written manifest is human-readable pretty JSON', async () => {
    const path = join(tmp, 'manifest.json');
    await writeManifest(path, emptyManifest('abmind', 'h'));
    const raw = await readFile(path, 'utf-8');
    expect(raw).toMatch(/\n {2}"package": "abmind"/);
  });

  it('readManifest rejects malformed JSON', async () => {
    const path = join(tmp, 'manifest.json');
    await writeFile(path, 'not json', 'utf-8');
    await expect(readManifest(path)).rejects.toThrow();
  });
});
