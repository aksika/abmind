/**
 * reconcile.ts — ensure ~/.abmind/ runtime tree matches source templates.
 * OVERWRITE: source-controlled dirs (prompts/sleep) — always fresh.
 * MANAGED: repo-owned files inside user-owned dirs (config/sleep.json) —
 *   always fresh, so shipped sleep steps reach existing homes on update.
 * SEED: user-owned dirs (memory/core, config) — only if file missing.
 * EXCEPTIONS: personalized files (memory/core/SOUL.md) — handled by
 *   `src/soul-seeder.ts`, not by this module. See #1323, #1324.
 */

import { existsSync, cpSync, rmSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";

const OVERWRITE: string[][] = [["prompts", "sleep"]];

/**
 * Repo-owned files that live inside user-owned SEED dirs but must still
 * refresh on every run. `config/sleep.json` owns the shipped sleep step
 * list — SEED-only left existing homes on the pre-#1912 12-step manifest
 * (no review-and-repair), so normal sleeps recorded `unreviewed` forever.
 * Operator edits to this file do not survive `abmind update`; tune timeouts
 * or eligibility by other means, not by editing the shipped manifest.
 */
const MANAGED_FILES: string[][] = [["config", "sleep.json"]];
const MANAGED_KEYS: ReadonlySet<string> = new Set(MANAGED_FILES.map((p) => p.join("/")));

/** SEED dirs walked recursively; missing files copied if dst is absent. */
const SEED: string[][] = [
  ["memory", "core"],
  ["config"],
];

/**
 * Files in SEED dirs that reconcile() must NOT copy. Paths are forward-slash,
 * relative to the package root, e.g. "memory/core/SOUL.md". Today only
 * SOUL.md is exempt; keep this list short and named individually.
 */
const SEED_EXCEPTIONS: ReadonlySet<string> = new Set([
  "memory/core/SOUL.md",
]);

export function reconcile(templatesSrc: string, home: string): void {
  for (const parts of OVERWRITE) {
    const src = join(templatesSrc, ...parts);
    const dst = join(home, ...parts);
    if (!existsSync(src)) continue;
    rmSync(dst, { recursive: true, force: true });
    mkdirSync(dst, { recursive: true });
    cpSync(src, dst, { recursive: true });
  }
  for (const parts of MANAGED_FILES) {
    const src = join(templatesSrc, ...parts);
    if (!existsSync(src)) continue;
    const dst = join(home, ...parts);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  for (const parts of SEED) {
    const src = join(templatesSrc, ...parts);
    if (!existsSync(src)) continue;
    for (const f of walkFiles(src)) {
      const rel = relative(src, f);
      const key = [...parts, rel].join("/");
      if (MANAGED_KEYS.has(key)) continue;
      if (SEED_EXCEPTIONS.has(key)) continue;
      const dst = join(home, ...parts, rel);
      if (existsSync(dst)) continue;
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(f, dst);
    }
  }
}

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full));
    else results.push(full);
  }
  return results;
}
