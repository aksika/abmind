/**
 * reconcile.ts — ensure ~/.abmind/ runtime tree matches source templates.
 * OVERWRITE: source-controlled dirs (prompts/sleep) — always fresh.
 * SEED: user-owned dirs (memory/core, config) — only if file missing.
 */

import { existsSync, cpSync, rmSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";

const OVERWRITE: string[][] = [["prompts", "sleep"]];
const SEED: string[] = ["memory/core", "config"];

export function reconcile(templatesSrc: string, home: string): void {
  for (const parts of OVERWRITE) {
    const src = join(templatesSrc, ...parts);
    const dst = join(home, ...parts);
    if (!existsSync(src)) continue;
    rmSync(dst, { recursive: true, force: true });
    mkdirSync(dst, { recursive: true });
    cpSync(src, dst, { recursive: true });
  }
  for (const dir of SEED) {
    const src = join(templatesSrc, dir);
    if (!existsSync(src)) continue;
    for (const f of walkFiles(src)) {
      const rel = relative(src, f);
      const dst = join(home, dir, rel);
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
