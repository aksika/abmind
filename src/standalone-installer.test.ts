import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readlinkSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readReleaseJson,
  findExistingRelease,
  defaultDeps,
  installStandalone,
} from '../cli/lib/standalone-installer.js';

function createStandaloneArtifact(root: string): string {
  const packageRoot = join(root, 'package');
  mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
  mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
  mkdirSync(join(packageRoot, 'templates', 'config'), { recursive: true });
  mkdirSync(join(packageRoot, 'templates', 'prompts', 'sleep'), { recursive: true });

  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'abmind', version: '0.0.1-test', type: 'module' }, null, 2),
  );
  writeFileSync(
    join(packageRoot, 'dist', 'cli', 'abmind.js'),
    '#!/usr/bin/env node\nprocess.stdout.write("0.0.1-test\\n");\n',
  );
  writeFileSync(join(packageRoot, 'scripts', 'repair-cli.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(
    join(packageRoot, 'templates', 'config', 'sleep.json'),
    '{"version":1,"defaults":{"timeoutSec":300},"steps":[]}\n',
  );
  writeFileSync(join(packageRoot, 'templates', 'prompts', 'sleep', 'step.md'), '# packaged prompt\n');

  const artifact = join(root, 'abmind-test.tgz');
  execFileSync('tar', ['-czf', artifact, '-C', root, 'package']);
  return artifact;
}

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

  describe('template reconciliation', () => {
    it('reconciles a changed and then unchanged release', async () => {
      const artifact = createStandaloneArtifact(tmp);
      const baseDeps = defaultDeps(home);
      const deps = {
        ...baseDeps,
        userBinDir: join(tmp, 'bin'),
        userLibDir: join(tmp, 'lib', 'node_modules'),
      };
      const request = { channel: 'stable' as const, artifactPath: artifact };

      const first = await installStandalone(request, deps);
      expect(first.changed).toBe(true);

      const configPath = join(home, 'config', 'sleep.json');
      const promptPath = join(home, 'prompts', 'sleep', 'step.md');
      expect(readFileSync(configPath, 'utf-8')).toContain('"timeoutSec":300');
      expect(readFileSync(promptPath, 'utf-8')).toBe('# packaged prompt\n');

      rmSync(configPath);
      writeFileSync(promptPath, 'STALE PROMPT\n');

      const second = await installStandalone(request, deps);
      expect(second.changed).toBe(false);
      expect(readFileSync(configPath, 'utf-8')).toContain('"timeoutSec":300');
      expect(readFileSync(promptPath, 'utf-8')).toBe('# packaged prompt\n');

      const operatorConfig = '{"version":1,"defaults":{"timeoutSec":600},"steps":[]}\n';
      writeFileSync(configPath, operatorConfig);
      writeFileSync(promptPath, 'STALE PROMPT\n');

      const third = await installStandalone(request, deps);
      expect(third.changed).toBe(false);
      expect(readFileSync(configPath, 'utf-8')).toBe(operatorConfig);
      expect(readFileSync(promptPath, 'utf-8')).toBe('# packaged prompt\n');
    });

    it('keeps the activated result when template reconciliation fails', async () => {
      const artifact = createStandaloneArtifact(tmp);
      const blockedHome = join(tmp, 'blocked-home');
      mkdirSync(join(blockedHome, 'packages', 'standalone'), { recursive: true, mode: 0o700 });
      writeFileSync(join(blockedHome, 'config'), 'not a directory\n');

      const baseDeps = defaultDeps(blockedHome);
      const deps = {
        ...baseDeps,
        userBinDir: join(tmp, 'blocked-bin'),
        userLibDir: join(tmp, 'blocked-lib', 'node_modules'),
      };

      const result = await installStandalone(
        { channel: 'stable', artifactPath: artifact },
        deps,
      );

      expect(result.changed).toBe(true);
      expect(readlinkSync(join(blockedHome, 'packages', 'standalone', 'current'))).toBe(result.releaseDir);
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
