/**
 * CLI banner — prints command name + version on every invocation.
 */

import { packagePaths, readManifest } from '../src/deploy-lib/index.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function printBanner(command: string): Promise<void> {
  const paths = packagePaths('abmind');
  const manifest = await readManifest(paths.manifest);
  const version = manifest?.version || getPackageVersion();
  let commit = manifest?.commit ?? null;
  if (!commit) {
    // Fallback: git rev-parse in the abmind source dir
    const here = dirname(fileURLToPath(import.meta.url));
    const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, encoding: "utf-8", timeout: 3000 });
    if (result.status === 0) commit = result.stdout.trim();
  }
  const display = commit ? `${version}-${commit}` : version;
  process.stdout.write(`abmind ${command}\nVersion: ${display}\n\n`);
}

function getPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch { return 'unknown'; }
}
