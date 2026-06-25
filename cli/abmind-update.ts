#!/usr/bin/env node
/**
 * abmind update [--source local|npm|github] [--from-local]
 *
 * Phase 4 of #158. Mirrors abtars update with a local build source
 * aware that abmind has NO build step in the traditional sense — abmind's
 * "build" is just `tsc`, producing dist/. Stage dist/ + node_modules/,
 * flip current symlink. Same atomic semantics as abtars.
 */

import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock,
  activate,
  emptyManifest,
  hashFile,
  packagePaths,
  pruneReleases,
  readManifest,
  RETENTION,
  writeManifest,
} from '../src/deploy-lib/index.js';

function runCmd(cmd: string, args: readonly string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with status ${r.status ?? -1}`);
  }
}

function tryCmd(cmd: string, args: readonly string[], cwd: string): string | null {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

function checkStaleness(repoRoot: string, fromLocal: boolean): { commit: string; branch: string | null } {
  const commit = tryCmd('git', ['rev-parse', '--short', 'HEAD'], repoRoot);
  if (commit === null) {
    if (!fromLocal) throw new Error('Not a git repo; pass --from-local to proceed.');
    return { commit: 'unknown', branch: null };
  }
  const branch = tryCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  if (fromLocal) return { commit, branch: branch === 'HEAD' ? null : branch };

  if (branch === 'HEAD' || branch === null) {
    throw new Error('Detached HEAD (no current branch). Pass --from-local to proceed.');
  }
  runCmd('git', ['fetch', '--quiet'], repoRoot);
  const upstream = tryCmd('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], repoRoot);
  if (upstream === null) {
    throw new Error(`Branch '${branch}' has no upstream. Pass --from-local to proceed.`);
  }
  const behindStr = tryCmd('git', ['rev-list', '--count', `HEAD..${upstream}`], repoRoot);
  const behind = behindStr === null ? null : Number(behindStr);
  if (behind === null || !Number.isFinite(behind)) {
    throw new Error(`Could not determine how far HEAD is behind ${upstream}. Pass --from-local.`);
  }
  if (behind > 0) {
    throw new Error(
      `Current branch: ${branch} (${commit})\n${upstream} is ahead by ${behind} commit${behind === 1 ? '' : 's'}.\nRun 'git pull' first, or pass --from-local.`,
    );
  }
  return { commit, branch };
}

async function run(): Promise<number> {
  const argv = process.argv.slice(2);

  const paths = packagePaths('abmind');
  const m = await readManifest(paths.manifest);
  const { printBanner } = await import("./banner.js");
  await printBanner("update");

  const source = argv.includes('--source')
    ? argv[argv.indexOf('--source') + 1]
    : 'local';
  const fromLocal = argv.includes('--from-local');

  if (source !== 'local' && source !== 'npm') {
    process.stderr.write(`--source ${source} is not yet supported.\nUse --source local (default) or --source npm.\n`);
    return 2;
  }

  const release = await acquireLock(paths.lock, `update --source ${source}`);
  try {
    if (source === 'npm') {
      const latest = tryCmd('npm', ['view', 'abmind', 'version'], process.cwd());
      if (!latest) throw new Error('Failed to fetch latest version from npm registry');
      let current: string | null = null;
      try { current = JSON.parse(await readFile(join(paths.home, 'current', 'package.json'), 'utf-8')).version; } catch {}
      if (latest === current) { process.stdout.write(`Already at latest version (${latest}). Nothing to update.\n`); return 0; }

      const stagedPath = join(paths.releases, latest);
      await rm(stagedPath, { recursive: true, force: true });
      await mkdir(stagedPath, { recursive: true });
      runCmd('npm', ['pack', `abmind@${latest}`, '--pack-destination', stagedPath], stagedPath);
      const tgzName = `abmind-${latest}.tgz`;
      runCmd('tar', ['-xzf', join(stagedPath, tgzName), '--strip-components=1'], stagedPath);
      try { (await import('node:fs')).unlinkSync(join(stagedPath, tgzName)); } catch {}
      runCmd('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], stagedPath);

      await activate(join(paths.home, 'current'), latest);
      await pruneReleases(paths.releases, [], latest);
      process.stdout.write(`✓ abmind updated to ${latest} (npm)\n`);
      return 0;
    }

    const repoRoot = process.cwd();
    const { commit, branch } = checkStaleness(repoRoot, fromLocal);
    const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf-8')) as { version?: string };
    if (typeof pkg.version !== 'string') throw new Error('package.json missing version');
    const version = `${pkg.version}-${commit}`;
    process.stdout.write(`Building abmind from ${repoRoot}...\n`);

    runCmd('npm', ['install', '--no-audit', '--no-fund'], repoRoot);
    runCmd('npm', ['run', 'build'], repoRoot);

    const stagedPath = join(paths.releases, version);
    await rm(stagedPath, { recursive: true, force: true });
    await mkdir(stagedPath, { recursive: true });
    await cp(join(repoRoot, 'dist'), join(stagedPath, 'dist'), { recursive: true });

    // Sync node_modules/ via rsync -aL to dereference symlinks (the
    // "abmind": "file:../abmind" package dep becomes a symlink that we
    // must materialize into the release, or the runtime runs live code
    // from the dev workspace. Also contends with npm test for SQLite locks.)
    await rm(paths.nodeModules, { recursive: true, force: true });
    await mkdir(paths.nodeModules, { recursive: true });
    const rsyncResult = spawnSync(
      'rsync',
      ['-aL', '--quiet', `${join(repoRoot, 'node_modules')}/`, `${paths.nodeModules}/`],
      { stdio: 'inherit' },
    );
    if (rsyncResult.status !== 0) {
      throw new Error(`rsync of node_modules failed (status ${rsyncResult.status ?? -1})`);
    }

    const packageLockHash = await hashFile(join(repoRoot, 'package-lock.json'));
    process.stdout.write(`✓ staged ${version} at ${stagedPath}\n`);

    await activate(paths.current, version);
    process.stdout.write(`✓ current -> releases/${version}\n`);

    const prior = await readManifest(paths.manifest);
    const now = new Date().toISOString();
    const newPriorReleases = prior?.version
      ? [
          {
            version: prior.version,
            commit: prior.commit,
            activatedAt: prior.activatedAt,
            packageLockHash: prior.packageLockHash,
          },
          ...(prior.priorReleases ?? []),
        ].slice(0, RETENTION - 1)
      : prior?.priorReleases ?? [];

    // Sync native deps (better-sqlite3, sqlite-vec) into ~/.abmind/lib/
    const nativeDeps = { ...prior?.nativeDeps };
    const ABMIND_NATIVE_DEPS = ["better-sqlite3", "sqlite-vec"];
    const libDir = join(paths.home, "lib");
    const nativeUpdated: string[] = [];
    for (const dep of ABMIND_NATIVE_DEPS) {
      const srcPkg = join(repoRoot, "node_modules", dep, "package.json");
      if (!existsSync(srcPkg)) continue;
      const srcVer = JSON.parse(await readFile(srcPkg, "utf-8")).version as string;
      if (nativeDeps[dep] === srcVer) continue;
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(libDir, { recursive: true });
      if (!existsSync(join(libDir, "package.json"))) {
        writeFileSync(join(libDir, "package.json"), '{"private":true}\n');
      }
      const { execSync } = await import("node:child_process");
      execSync(`npm install ${dep}@${srcVer} --no-audit --no-fund --loglevel=error`, { cwd: libDir, stdio: "pipe", timeout: 120_000 });
      nativeDeps[dep] = srcVer;
      nativeUpdated.push(`${dep}@${srcVer}`);
    }
    if (nativeUpdated.length) process.stdout.write(`✓ native deps: ${nativeUpdated.join(", ")}\n`);

    await writeManifest(paths.manifest, {
      ...(prior ?? emptyManifest('abmind', hostname())),
      version,
      commit,
      branch,
      packageLockHash,
      activatedAt: now,
      source: 'local',
      priorReleases: newPriorReleases,
      nativeDeps,
    });
    process.stdout.write(`✓ manifest updated\n`);

    const pruned = await pruneReleases(
      paths.releases,
      [version, ...newPriorReleases.map((r) => r.version)],
      version,
      RETENTION,
    );
    if (pruned.length > 0) {
      process.stdout.write(`✓ pruned ${pruned.length} old release(s): ${pruned.join(', ')}\n`);
    }

    process.stdout.write(`\nabmind update complete: ${version}\n`);

    // Reconcile templates → runtime tree
    const { reconcile } = await import('../src/reconcile.js');
    reconcile(join(repoRoot, 'templates'), paths.home);
    process.stdout.write(`✓ reconciled templates\n`);

    // Remove stale CLI entries from legacy install paths (#958).
    // These shadow ~/.abtars/bin/abmind which is the correct wrapper.
    const home = process.env.HOME ?? '';
    const stalePaths = [
      join(home, '.npm-global', 'bin', 'abmind'),
      join(home, '.local', 'bin', 'abmind'),
    ];
    for (const p of stalePaths) {
      try { unlinkSync(p); process.stdout.write(`✓ removed stale ${p}\n`); } catch { /* ENOENT — already gone */ }
    }

    return 0;
  } finally {
    await release();
  }
}

try {
  const exitCode = await run();
  process.exit(exitCode);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}
