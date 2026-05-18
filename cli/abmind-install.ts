#!/usr/bin/env node
/**
 * abmind install [--upgrade] [--force] — first-time setup of ~/.abmind.
 *
 * Phase 4 of #158. Mirrors abtars install, retargeted to the abmind
 * runtime root. Seeds config/.env.memory from repo example; creates
 * PATH symlinks for abmind CLI entries in ~/.local/bin/.
 */

import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { emptyManifest, packagePaths, readManifest, resolveUserBinDir, writeManifest } from '../src/deploy-lib/index.js';

// Must match the abmind bin entries in package.json. Keep small; add more here
// if we extract more CLI scripts to ~/.abmind/bin/ wrappers.
const CLI_WRAPPERS = ['abmind', 'abmind-embed'] as const;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** True for any fs entry, incl. dangling symlinks (unlike exists() which follows). */
async function existsAny(p: string): Promise<boolean> {
  try {
    const { lstat } = await import('node:fs/promises');
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function isFlatLayout(home: string): Promise<boolean> {
  // abmind never had a releases/ layout pre-158. "Flat" for abmind means
  // an existing ~/.abmind/ without manifest.json. No dist/ shipped to the
  // runtime root previously — abmind always ran from the repo or npm install.
  const hasManifest = await exists(join(home, 'manifest.json'));
  const hasHome = await exists(home);
  return hasHome && !hasManifest;
}

async function createSkeleton(home: string, dryRun: boolean): Promise<void> {
  const dirs = [
    join(home, 'config'),
    join(home, 'memory'),
    join(home, 'secret'),
    join(home, 'topics'),
    join(home, 'prompts', 'sleep'),
    join(home, 'bin'),
    join(home, 'releases'),
  ];
  if (dryRun) {
    process.stdout.write(`[dry-run] mkdir -p:\n  ${dirs.join('\n  ')}\n`);
    return;
  }
  for (const d of dirs) await mkdir(d, { recursive: true });
}

async function seedConfig(repoRoot: string, configDir: string, dryRun: boolean): Promise<readonly string[]> {
  const src = join(repoRoot, 'config', '.env.memory.example');
  const dst = join(configDir, '.env.memory');
  if (!(await exists(src))) return [];
  if (await exists(dst)) return [];
  if (dryRun) return [`[dry-run] cp ${src} ${dst}`];
  const content = await readFile(src, 'utf-8');
  await writeFile(dst, content, { mode: 0o600 });
  return [basename(dst)];
}

/** Seed/refresh deploy-shipped files into $ABMIND_HOME/memory/core/. */
function seedCoreFiles(repoRoot: string, home: string): void {
  const dst = join(home, 'memory', 'core');
  mkdirSync(dst, { recursive: true });
  const mtSrc = join(repoRoot, 'core', 'memory-tools.md');
  if (existsSync(mtSrc)) copyFileSync(mtSrc, join(dst, 'memory-tools.md'));
  const soulDst = join(dst, 'SOUL.md');
  if (!existsSync(soulDst)) {
    const soulSrc = join(repoRoot, 'core', 'SOUL.md');
    if (existsSync(soulSrc)) copyFileSync(soulSrc, soulDst);
  }
}

async function seedSleepPrompts(repoRoot: string, home: string, dryRun: boolean): Promise<number> {
  const src = join(repoRoot, 'prompts', 'sleep');
  if (!(await exists(src))) return 0;
  const dst = join(home, 'prompts', 'sleep');
  if (dryRun) return 0;
  const { readdir, copyFile } = await import('node:fs/promises');
  const files = await readdir(src);
  await mkdir(dst, { recursive: true });
  let n = 0;
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    await copyFile(join(src, f), join(dst, f));
    n++;
  }
  return n;
}

async function writeWrapper(binDir: string, name: string): Promise<void> {
  const cliFile = name === 'abmind' ? 'abmind.js' : `${name}.js`;
  const target = join('$HOME', '.abmind', 'current', 'dist', 'cli', cliFile);
  const content = `#!/usr/bin/env bash\nexec node "${target}" "$@"\n`;
  await writeFile(join(binDir, name), content, { mode: 0o755 });
}

async function reconcilePathLink(
  binDir: string,
  userBinDir: string,
  name: string,
  force: boolean,
  dryRun: boolean,
): Promise<{ action: string; message?: string }> {
  const linkPath = join(userBinDir, name);
  const targetPath = join(binDir, name);
  const linkExists = await existsAny(linkPath);
  if (!linkExists) {
    if (dryRun) return { action: `[dry-run] ln -s ${targetPath} ${linkPath}` };
    await symlink(targetPath, linkPath);
    return { action: `created ${linkPath}` };
  }
  const { lstat, readlink, unlink } = await import('node:fs/promises');
  const s = await lstat(linkPath);
  if (s.isSymbolicLink()) {
    const current = await readlink(linkPath);
    // Own-target check: exact match only. A smoke-test install at a custom
    // ABMIND_HOME must NOT clobber the real ~/.abmind symlinks just because
    // both paths contain '/.abmind/bin/'. Compare full target paths.
    const ownsIt = current === targetPath;
    if (ownsIt) {
      if (dryRun) return { action: `[dry-run] overwrite ${linkPath} (we own it)` };
      await unlink(linkPath);
      await symlink(targetPath, linkPath);
      return { action: `updated ${linkPath}` };
    }
    if (force) {
      if (dryRun) return { action: `[dry-run] --force overwrite ${linkPath}` };
      await unlink(linkPath);
      await symlink(targetPath, linkPath);
      return { action: `forced overwrite ${linkPath} (was -> ${current})` };
    }
    return {
      action: 'refused',
      message: `${linkPath} is a symlink to ${current} (not ours). Pass --force to overwrite.`,
    };
  }
  if (force) {
    if (dryRun) return { action: `[dry-run] --force overwrite ${linkPath} (regular file)` };
    await unlink(linkPath);
    await symlink(targetPath, linkPath);
    return { action: `forced overwrite ${linkPath} (was regular file)` };
  }
  return {
    action: 'refused',
    message: `${linkPath} exists as a regular file. Pass --force to overwrite.`,
  };
}

function isPathOnPATH(userBinDir: string): boolean {
  const PATH = process.env['PATH'] ?? '';
  return PATH.split(':').some((p) => p === userBinDir);
}

function parseFlags(argv: readonly string[]): { upgrade: boolean; force: boolean; dryRun: boolean } {
  return {
    upgrade: argv.includes('--upgrade'),
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
  };
}

async function run(): Promise<number> {
  const opts = parseFlags(process.argv.slice(3));
  const paths = packagePaths('abmind');
  const home = paths.home;
  const userBinDir = resolveUserBinDir();
  const repoRoot = process.cwd();

  const homeExists = await exists(home);
  const flat = homeExists ? await isFlatLayout(home) : false;
  const manifest = homeExists ? await readManifest(paths.manifest) : null;

  if (homeExists && !flat && manifest && !opts.force && !opts.upgrade) {
    process.stderr.write(
      `~/.abmind already installed at version ${manifest.version || '(unset)'}.\n` +
        `Use 'abmind update' to upgrade, or --force to re-seed missing config.\n`,
    );
    return 2;
  }

  await createSkeleton(home, opts.dryRun);
  process.stdout.write(`✓ skeleton at ${home}\n`);

  const seeded = await seedConfig(repoRoot, paths.config, opts.dryRun);
  if (seeded.length > 0) {
    process.stdout.write(`✓ seeded config: ${seeded.join(', ')}\n`);
  }

  const promptsCount = await seedSleepPrompts(repoRoot, home, opts.dryRun);
  if (promptsCount > 0) {
    process.stdout.write(`✓ seeded ${promptsCount} sleep prompt(s)\n`);
  }

  if (!opts.dryRun) seedCoreFiles(repoRoot, home);

  if (!opts.dryRun) await mkdir(paths.bin, { recursive: true });
  for (const name of CLI_WRAPPERS) {
    await writeWrapper(paths.bin, name);
  }
  process.stdout.write(`✓ wrappers in ${paths.bin}\n`);

  if (!opts.dryRun) await mkdir(userBinDir, { recursive: true });
  const refused: string[] = [];
  for (const name of CLI_WRAPPERS) {
    const r = await reconcilePathLink(paths.bin, userBinDir, name, opts.force, opts.dryRun);
    if (r.action === 'refused') refused.push(r.message ?? name);
  }
  if (refused.length > 0) {
    process.stderr.write(`\nPATH symlink conflicts:\n  ${refused.join('\n  ')}\n`);
    return 4;
  }
  process.stdout.write(`✓ PATH symlinks in ${userBinDir}\n`);

  if (!isPathOnPATH(userBinDir)) {
    process.stderr.write(
      `\nWarning: ${userBinDir} is not on $PATH. Add to your shell config:\n  export PATH="${userBinDir}:$PATH"\n`,
    );
  }

  // Re-read manifest: if migration (future) wrote one, don't clobber it.
  const manifestAfter = await readManifest(paths.manifest);
  if (manifestAfter === null && !opts.dryRun) {
    await writeManifest(paths.manifest, {
      ...emptyManifest('abmind', hostname()),
      version: '',
      preMigrationBackup: flat ? join(dirname(home), '.abmind.pre-158.bak') : null,
    });
    process.stdout.write(`✓ manifest initialized at ${paths.manifest}\n`);
  }

  process.stdout.write(`\nabmind install complete.\n`);
  if (!manifestAfter || manifestAfter.version === '') {
    process.stdout.write(`Next: 'abmind update' to build and activate the first release.\n`);
  }
  return 0;
}

const exitCode = await run();
process.exit(exitCode);
