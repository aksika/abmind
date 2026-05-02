/**
 * Release management: stage / activate (flip symlink) / prune.
 *
 * Invariants (per plan §"Directory layout"):
 *   - releases/<version>/dist/ holds only compiled code, no node_modules
 *   - node_modules/ lives at the package home root, shared across releases
 *   - current is a symlink to releases/<version>/
 *   - Retention = 3 (plan §"Key invariants"); oldest pruned on activate
 *
 * Activation is atomic via rename(2): write current.new → rename to current.
 * This replaces the existing symlink in one syscall; readers never see a
 * broken state.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, rename, rm, stat, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const RETENTION = 3;

export interface StagedRelease {
  readonly version: string;
  readonly stagedPath: string;
  readonly commit: string | null;
  readonly packageLockHash: string | null;
  readonly source: 'local' | 'npm' | 'github';
}

/**
 * List release versions in a releases/ dir, newest-activation-first as
 * reported by the caller (this function sorts lexicographically; callers
 * with a preferred order should rely on manifest priorReleases).
 */
export async function listReleases(releasesDir: string): Promise<string[]> {
  try {
    const entries = await readdir(releasesDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Resolve the currently active release version from the `current` symlink.
 * Returns null if the symlink is missing or dangling.
 */
export async function readCurrent(currentLink: string): Promise<string | null> {
  try {
    const s = await stat(currentLink);
    if (!s.isDirectory()) return null;
    const { readlink } = await import('node:fs/promises');
    const target = await readlink(currentLink);
    // Target is like "releases/vX.Y.Z" or absolute path ending in vX.Y.Z.
    return basename(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Atomically flip the `current` symlink to point at releases/<version>/.
 * Link target is relative (so moves of the package home don't break it).
 */
export async function activate(currentLink: string, version: string): Promise<void> {
  const tmp = `${currentLink}.new`;
  // Relative symlink target: "releases/<version>"
  const target = join('releases', version);
  // Clear any leftover tmp from a crashed prior run.
  try {
    await unlink(tmp);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await symlink(target, tmp);
  await rename(tmp, currentLink);
}

/**
 * Prune old releases, keeping the `keep` newest (by activation order provided
 * by caller, most-recent-first). Never removes the currently-active release
 * even if it falls outside the window.
 */
export async function pruneReleases(
  releasesDir: string,
  activatedOrder: readonly string[],
  currentVersion: string,
  keep: number = RETENTION,
): Promise<string[]> {
  const retained = new Set<string>([currentVersion]);
  for (const v of activatedOrder.slice(0, keep)) retained.add(v);
  const all = await listReleases(releasesDir);
  const pruned: string[] = [];
  for (const version of all) {
    if (retained.has(version)) continue;
    await rm(join(releasesDir, version), { recursive: true, force: true });
    pruned.push(version);
  }
  return pruned;
}

export async function hashFile(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path);
    return createHash('sha256').update(buf).digest('hex');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Validate that `releases/<version>/` exists and has a dist/ subdir. Used by
 * rollback to refuse flipping to a pruned or partial release.
 */
export async function releaseExists(releasesDir: string, version: string): Promise<boolean> {
  try {
    const s = await stat(join(releasesDir, version, 'dist'));
    return s.isDirectory();
  } catch {
    return false;
  }
}

export { RETENTION };
// dirname import preserves tree-shake correctness with downstream tooling
export const _dirname = dirname;
