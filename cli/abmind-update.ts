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
import { existsSync, copyFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
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

/** Seed/refresh deploy-shipped files into $ABMIND_HOME/memory/core/. */
function seedCoreFiles(repoRoot: string, home: string): void {
  const dst = join(home, 'memory', 'core');
  mkdirSync(dst, { recursive: true });
  // memory-tools.md: always overwrite (deploy-shipped documentation)
  const mtSrc = join(repoRoot, 'core', 'memory-tools.md');
  if (existsSync(mtSrc)) copyFileSync(mtSrc, join(dst, 'memory-tools.md'));
  // SOUL.md: seed only if missing (human-owned)
  const soulDst = join(dst, 'SOUL.md');
  if (!existsSync(soulDst)) {
    const soulSrc = join(repoRoot, 'core', 'SOUL.md');
    if (existsSync(soulSrc)) copyFileSync(soulSrc, soulDst);
  }
  // core_facts.md, agent_notes.md: seed if missing, .template.md if exists
  for (const file of ['core_facts.md', 'agent_notes.md']) {
    const src = join(repoRoot, 'templates', 'core', file);
    if (!existsSync(src)) continue;
    const livePath = join(dst, file);
    if (!existsSync(livePath)) {
      copyFileSync(src, livePath);
    } else {
      copyFileSync(src, join(dst, file.replace('.md', '.template.md')));
    }
  }
}

/** Sync sleep prompts from repo to $ABMIND_HOME/prompts/sleep/. Always overwrites — these are deploy-shipped. */
function seedSleepPrompts(repoRoot: string, home: string): number {
  const src = join(repoRoot, 'prompts', 'sleep');
  if (!existsSync(src)) return 0;
  const dst = join(home, 'prompts', 'sleep');
  mkdirSync(dst, { recursive: true });
  const files = readdirSync(src).filter(f => f.endsWith('.md'));
  for (const f of files) copyFileSync(join(src, f), join(dst, f));
  return files.length;
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
  const source = argv.includes('--source')
    ? argv[argv.indexOf('--source') + 1]
    : 'local';
  const fromLocal = argv.includes('--from-local');

  if (source !== 'local' && source !== 'npm') {
    process.stderr.write(`--source ${source} is not yet supported.\nUse --source local (default) or --source npm.\n`);
    return 2;
  }

  const paths = packagePaths('abmind');
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

    await writeManifest(paths.manifest, {
      ...(prior ?? emptyManifest('abmind', hostname())),
      version,
      commit,
      branch,
      packageLockHash,
      activatedAt: now,
      source: 'local',
      priorReleases: newPriorReleases,
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

    // Seed/refresh deploy-shipped core files into memory/core/.
    // memory-tools.md: always overwrite (documentation, ships with abmind).
    // SOUL.md: seed only if missing (human-owned, Dreamy evolves).
    await seedCoreFiles(repoRoot, paths.home);

    // Sync sleep prompts — always overwrite (deploy-shipped, new steps must land on update).
    const promptCount = seedSleepPrompts(repoRoot, paths.home);
    if (promptCount > 0) process.stdout.write(`✓ synced ${promptCount} sleep prompt(s)\n`);

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
