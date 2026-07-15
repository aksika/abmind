import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readReleaseJson,
  findExistingRelease,
  defaultDeps,
  installStandalone,
} from '../cli/lib/standalone-installer.js';

describe('standalone-installer', () => {
  let tmp: string;
  let home: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'standalone-installer-'));
    home = join(tmp, '.abmind');
    mkdirSync(join(home, 'packages', 'standalone'), { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('readReleaseJson', () => {
    it('returns null for missing file', () => {
      expect(readReleaseJson(join(home, 'no-such'))).toBeNull();
    });

    it('returns null for missing directory', () => {
      expect(readReleaseJson(join(home, 'packages', 'standalone', 'no-such'))).toBeNull();
    });

    it('reads valid release.json', () => {
      const releaseId = '0.3.0-stable-abc123def456';
      const releaseDir = join(home, 'packages', 'standalone', releaseId);
      mkdirSync(releaseDir, { recursive: true });
      const meta = {
        schemaVersion: 1 as const,
        packageName: 'abmind',
        releaseId,
        version: '0.3.0',
        channel: 'stable' as const,
        source: 'npm' as const,
        commit: null,
        artifactSha256: 'abc123def456',
        activatedAt: new Date().toISOString(),
        entrypoint: 'node_modules/abmind/dist/cli/abmind.js',
      };
      writeFileSync(join(releaseDir, 'release.json'), JSON.stringify(meta));
      expect(readReleaseJson(releaseDir)).toEqual(meta);
    });

    it('returns null for malformed JSON', () => {
      const releaseDir = join(home, 'packages', 'standalone', 'bad-json');
      mkdirSync(releaseDir, { recursive: true });
      writeFileSync(join(releaseDir, 'release.json'), 'not json');
      expect(readReleaseJson(releaseDir)).toBeNull();
    });
  });

  describe('findExistingRelease', () => {
    it('returns null for non-existent release id', () => {
      expect(findExistingRelease(home, 'no-such')).toBeNull();
    });

    it('returns directory for complete existing release', () => {
      const releaseId = '0.3.0-stable-abc123def456';
      const releaseDir = join(home, 'packages', 'standalone', releaseId);
      mkdirSync(join(releaseDir, 'node_modules', 'abmind', 'dist', 'cli'), { recursive: true });
      writeFileSync(
        join(releaseDir, 'node_modules', 'abmind', 'dist', 'cli', 'abmind.js'),
        'export {}',
      );
      writeFileSync(
        join(releaseDir, 'release.json'),
        JSON.stringify({
          schemaVersion: 1,
          packageName: 'abmind',
          releaseId,
          version: '0.3.0',
          channel: 'stable',
          source: 'npm',
          commit: null,
          artifactSha256: 'abc123def456',
          activatedAt: new Date().toISOString(),
          entrypoint: 'node_modules/abmind/dist/cli/abmind.js',
        }),
      );
      expect(findExistingRelease(home, releaseId)).toBe(releaseDir);
    });
  });

  describe('defaultDeps', () => {
    it('uses provided abmindHome', () => {
      const deps = defaultDeps(home);
      expect(deps.abmindHome).toBe(home);
    });

    it('exec helper returns result for valid command', () => {
      const deps = defaultDeps(home);
      const r = deps.exec('node', ['--version']);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^v/);
    });

    it('exec helper returns non-zero for invalid command', () => {
      const deps = defaultDeps(home);
      const r = deps.exec('node', ['--no-such-flag']);
      expect(r.status).not.toBe(0);
    });
  });

  describe('installStandalone with prereqs', () => {
    it('rejects artifact that does not exist', async () => {
      const deps = defaultDeps(home);
      const p = installStandalone(
        { channel: 'stable', artifactPath: join(tmp, 'no-such.tgz') },
        deps,
      );
      await expect(p).rejects.toThrow();
    });
  });

  describe('link chain validation', () => {
    it('finds existing release via current symlink and reads metadata', () => {
      const releaseId = '0.2.7-stable-abc123def456';
      const spDir = join(home, 'packages', 'standalone');
      const releaseDir = join(spDir, releaseId);
      mkdirSync(join(releaseDir, 'node_modules', 'abmind', 'dist', 'cli'), { recursive: true });
      writeFileSync(
        join(releaseDir, 'node_modules', 'abmind', 'dist', 'cli', 'abmind.js'),
        'export {}',
      );
      const meta = {
        schemaVersion: 1 as const,
        packageName: 'abmind',
        releaseId,
        version: '0.2.7',
        channel: 'stable' as const,
        source: 'npm' as const,
        commit: null,
        artifactSha256: 'abc123def456',
        activatedAt: new Date().toISOString(),
        entrypoint: 'node_modules/abmind/dist/cli/abmind.js',
      };
      writeFileSync(join(releaseDir, 'release.json'), JSON.stringify(meta));

      // Create current symlink
      symlinkSync(releaseId, join(spDir, 'current'));

      const found = findExistingRelease(home, releaseId);
      expect(found).toBe(releaseDir);

      const read = readReleaseJson(releaseDir);
      expect(read).toEqual(meta);
    });
  });
});
