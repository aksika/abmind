/**
 * soul-seeder.ts — single source of truth for SOUL.md lifecycle.
 *
 * The persona file at ~/.abmind/memory/core/SOUL.md is *personalized* — it
 * embeds the agent's display name via the `<agentName>` placeholder, which
 * `reconcile()` (template sync) must NOT touch, and which install/restore
 * must write via this module.
 *
 * Three callers, one writer:
 *   1. `cli/abmind-install.ts` — first install, after `reconcile()`.
 *   2. `cli/abmind-restore.ts` — restore from backup, after `reconcile()`.
 *   3. `src/ensure-initialized.ts` — lazy init for library consumers that
 *      never run `abmind install` (defense in depth).
 *
 * See #1323 (bug) and #1324 (refactor).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const PLACEHOLDER = '<agentName>';

/** Canonical SOUL.md path inside an abmind home. */
export function soulPath(home: string): string {
  return join(home, 'memory', 'core', 'SOUL.md');
}

/** Canonical SOUL.md template path inside an abmind source tree. */
export function templateSoulPath(repoRoot: string): string {
  return join(repoRoot, 'templates', 'memory', 'core', 'SOUL.md');
}

/** Read the deployed SOUL.md, or null if absent. */
export function readSoul(home: string): string | null {
  const p = soulPath(home);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}

/**
 * Personalize the SOUL.md template and write it to the abmind home.
 * Idempotent — overwrites any existing file. Caller decides when to invoke.
 *
 * Returns true if the file was written, false if the template was missing.
 */
export function writeSoulPersonalized(
  repoRoot: string,
  home: string,
  agentName: string,
): boolean {
  const src = templateSoulPath(repoRoot);
  if (!existsSync(src)) return false;
  const dst = soulPath(home);
  mkdirSync(dirname(dst), { recursive: true });
  const content = readFileSync(src, 'utf-8').replaceAll(PLACEHOLDER, agentName);
  writeFileSync(dst, content, { mode: 0o600 });
  return true;
}

/**
 * Resolve the agent display name to use for SOUL.md substitution.
 * Tries in order: explicit arg → ~/.abtars/config/peers.json → default "Agent".
 * Used by install and restore when the user has not provided --agent-name.
 */
export function discoverAgentName(explicit?: string | null): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  try {
    const peersPath = join(homedir(), '.abtars', 'config', 'peers.json');
    if (existsSync(peersPath)) {
      const peers = JSON.parse(readFileSync(peersPath, 'utf-8')) as { self?: { name?: string } };
      if (peers.self?.name && peers.self.name.trim().length > 0) return peers.self.name.trim();
    }
  } catch { /* malformed or missing — fall through */ }
  return 'Agent';
}
