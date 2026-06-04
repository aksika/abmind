/**
 * Safety-guarded destructive ops for `reset` / `uninstall`.
 *
 * Cleanup utilities for deploy operations.
 * Key primitive: isUnsafeRemovalTarget() rejects catastrophic paths ('/',
 * '~', empty, etc.) BEFORE any caller invokes rm. Caller must always check.
 */

import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * True if the path is something we refuse to remove, regardless of flags.
 *
 * Rejects:
 *   - empty / whitespace-only strings
 *   - '/', '\\', or any path that resolves to root
 *   - '~' (home), home dir itself, or parents of home
 *   - Anything not under the user's home dir (defense-in-depth against
 *     config pointing at /etc/... by mistake)
 *
 * Callers SHOULD still confirm with the user before removing even "safe"
 * paths; this function is a hard floor, not a substitute for confirmation.
 */
export function isUnsafeRemovalTarget(path: string): boolean {
  const trimmed = path.trim();
  if (trimmed === '') return true;
  if (trimmed === '~' || trimmed === '/' || trimmed === '\\') return true;
  const abs = resolve(trimmed);
  if (abs === '/' || abs === '') return true;
  const home = homedir();
  if (abs === home) return true;
  // Must be under home (defense in depth).
  const homeWithSep = home.endsWith('/') ? home : home + '/';
  if (!abs.startsWith(homeWithSep)) return true;
  return false;
}

export interface RemovePlan {
  readonly path: string;
  readonly willRemove: boolean;
  readonly reason: string;
}

/**
 * Plan a remove without executing. Used by --dry-run flows in reset/uninstall.
 */
export function planRemoval(path: string): RemovePlan {
  if (isUnsafeRemovalTarget(path)) {
    return { path, willRemove: false, reason: 'refused: unsafe target' };
  }
  return { path, willRemove: true, reason: 'would remove recursively' };
}

/**
 * Remove a path after validating safety. Throws if the target is unsafe.
 * Returns true if the path was removed, false if it didn't exist.
 */
export async function removePath(path: string, opts: { dryRun?: boolean } = {}): Promise<boolean> {
  if (isUnsafeRemovalTarget(path)) {
    throw new Error(`Refused to remove unsafe target: ${path}`);
  }
  if (opts.dryRun) return true;
  try {
    await rm(path, { recursive: true });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
