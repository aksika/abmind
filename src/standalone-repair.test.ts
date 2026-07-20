import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isolatedChildEnv } from './test-support/runtime-isolation.js';

describe('standalone-repair (repair-cli.sh)', () => {
  let tmp: string;
  let abmindHome: string;
  let currentLink: string;
  let releaseDir: string;
  let publicBin: string;
  let publicMod: string;
  let repairScript: string;
  let launcherPath: string;
  let entrypointPath: string;

  function runRepair(): { status: number; stdout: string; stderr: string } {
    const r = spawnSync('sh', [repairScript], {
      cwd: tmp,
      encoding: 'utf-8',
      env: isolatedChildEnv({ ABMIND_HOME: abmindHome, HOME: tmp }),
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  function setupValidRelease(): void {
    mkdirSync(join(releaseDir, 'bin'), { recursive: true });
    mkdirSync(join(releaseDir, 'node_modules', 'abmind', 'dist', 'cli'), { recursive: true });
    writeFileSync(join(releaseDir, 'release.json'), JSON.stringify({
      schemaVersion: 1,
      packageName: 'abmind',
      releaseId: '0.3.0-dev-abc123def456',
      version: '0.3.0',
      channel: 'dev',
      source: 'git',
      commit: 'abc123',
      artifactSha256: 'abc123def456',
      activatedAt: new Date().toISOString(),
      entrypoint: 'node_modules/abmind/dist/cli/abmind.js',
    }));
    writeFileSync(entrypointPath, 'console.log("ok");');
    writeFileSync(launcherPath, '#!/bin/sh\n# abmind-standalone-launcher:v1\nset -eu\nexec node placeholder\n');
    chmodSync(launcherPath, 0o755);
    symlinkSync(releaseDir, currentLink);
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'standalone-repair-'));
    abmindHome = join(tmp, '.abmind');
    publicBin = join(tmp, '.local', 'bin', 'abmind');
    publicMod = join(tmp, '.local', 'lib', 'node_modules', 'abmind');
    currentLink = join(abmindHome, 'packages', 'standalone', 'current');
    releaseDir = join(abmindHome, 'packages', 'standalone', '0.3.0-dev-abc123def456');
    repairScript = join(abmindHome, 'scripts', 'repair-cli.sh');
    launcherPath = join(releaseDir, 'bin', 'abmind');
    entrypointPath = join(releaseDir, 'node_modules', 'abmind', 'dist', 'cli', 'abmind.js');
    mkdirSync(join(abmindHome, 'packages', 'standalone'), { recursive: true, mode: 0o700 });
    mkdirSync(join(abmindHome, 'scripts'), { recursive: true, mode: 0o700 });
    // Copy the real repair script into the sandbox
    const realRepair = join(import.meta.dirname, '..', 'scripts', 'repair-cli.sh');
    const content = spawnSync('cat', [realRepair], { encoding: 'utf-8' }).stdout;
    writeFileSync(repairScript, content);
    chmodSync(repairScript, 0o644); // mode not relied upon
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('repairs missing launcher permissions', () => {
    setupValidRelease();
    chmodSync(launcherPath, 0o644);

    const r = runRepair();
    expect(r.status).toBe(0);

    expect(statSync(launcherPath).mode & 0o777).toBe(0o755);
  });

  it('repairs missing public bin link', () => {
    setupValidRelease();
    // No public bin link exists

    const r = runRepair();
    expect(r.status).toBe(0);
    expect(spawnSync('readlink', [publicBin], { encoding: 'utf-8' }).stdout.trim()).toBe(launcherPath);
  });

  it('repairs public bin link pointing to wrong target', () => {
    setupValidRelease();
    mkdirSync(join(tmp, '.local', 'bin'), { recursive: true });
    symlinkSync('/wrong/target', publicBin);

    const r = runRepair();
    expect(r.status).toBe(0);
    expect(spawnSync('readlink', [publicBin], { encoding: 'utf-8' }).stdout.trim()).toBe(launcherPath);
  });

  it('refuses to overwrite foreign file at public bin path', () => {
    setupValidRelease();
    mkdirSync(join(tmp, '.local', 'bin'), { recursive: true });
    writeFileSync(publicBin, 'foreign content');

    const r = runRepair();
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('foreign');
  });

  it('fails when current symlink is missing', () => {
    // No current symlink set up

    const r = runRepair();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('missing');
  });

  it('fails when current symlink target is missing', () => {
    symlinkSync('/nonexistent/path', currentLink);

    const r = runRepair();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('missing');
  });

  it('fails when release.json is missing in current', () => {
    setupValidRelease();
    rmSync(join(releaseDir, 'release.json'), { force: true });

    const r = runRepair();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('release.json');
  });

  it('fails when launcher marker is missing', () => {
    setupValidRelease();
    writeFileSync(launcherPath, '#!/bin/sh\necho "not our launcher"\n');
    chmodSync(launcherPath, 0o755);

    const r = runRepair();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('marker');
  });

  it('fails when JS entrypoint is missing', () => {
    setupValidRelease();
    rmSync(entrypointPath, { force: true });

    const r = runRepair();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('entrypoint');
  });

  it('repairs public module link', () => {
    setupValidRelease();
    // No public module link exists

    const r = runRepair();
    expect(r.status).toBe(0);

    const modTarget = join(releaseDir, 'node_modules', 'abmind');
    expect(spawnSync('readlink', [publicMod], { encoding: 'utf-8' }).stdout.trim()).toBe(modTarget);
  });

  it('refuses to overwrite foreign directory on public module path', () => {
    setupValidRelease();
    mkdirSync(join(tmp, '.local', 'lib', 'node_modules'), { recursive: true });
    mkdirSync(join(tmp, '.local', 'lib', 'node_modules', 'abmind'), { recursive: true });
    writeFileSync(join(tmp, '.local', 'lib', 'node_modules', 'abmind', 'test.txt'), 'foreign');

    const r = runRepair();
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('foreign');
  });

  it('handles spaces in ABMIND_HOME', () => {
    const spacedDir = join(tmp, 'my home', '.abmind');
    mkdirSync(join(spacedDir, 'packages', 'standalone'), { recursive: true, mode: 0o700 });
    mkdirSync(join(spacedDir, 'scripts'), { recursive: true, mode: 0o700 });
    const spacedCurrentLink = join(spacedDir, 'packages', 'standalone', 'current');
    const spacedReleaseDir = join(spacedDir, 'packages', 'standalone', '0.3.0-spaced');
    const spacedLauncher = join(spacedReleaseDir, 'bin', 'abmind');
    mkdirSync(join(spacedReleaseDir, 'bin'), { recursive: true });
    mkdirSync(join(spacedReleaseDir, 'node_modules', 'abmind', 'dist', 'cli'), { recursive: true });
    writeFileSync(join(spacedReleaseDir, 'release.json'), JSON.stringify({
      schemaVersion: 1,
      packageName: 'abmind',
      releaseId: '0.3.0-spaced',
      version: '0.3.0',
      channel: 'dev',
      source: 'git',
      commit: 'abc123',
      artifactSha256: 'abc123def456',
      activatedAt: new Date().toISOString(),
      entrypoint: 'node_modules/abmind/dist/cli/abmind.js',
    }));
    writeFileSync(join(spacedReleaseDir, 'node_modules', 'abmind', 'dist', 'cli', 'abmind.js'), 'console.log("ok");');
    writeFileSync(spacedLauncher, '#!/bin/sh\n# abmind-standalone-launcher:v1\nset -eu\nexec node placeholder\n');
    chmodSync(spacedLauncher, 0o755);
    symlinkSync(spacedReleaseDir, spacedCurrentLink);

    // Copy repair script into spaced home
    const spacedRepair = join(spacedDir, 'scripts', 'repair-cli.sh');
    const content = spawnSync('cat', [repairScript], { encoding: 'utf-8' }).stdout;
    writeFileSync(spacedRepair, content);

    const r = spawnSync('sh', [spacedRepair], {
      cwd: tmp,
      encoding: 'utf-8',
      env: isolatedChildEnv({ ABMIND_HOME: spacedDir, HOME: tmp }),
    });
    expect(r.status).toBe(0);
  });
});
