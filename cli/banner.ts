/**
 * CLI banner — prints command name + version on every invocation.
 * Shared utility: mirrored in abtars/src/cli/commands/banner.ts
 */

import { packagePaths, readManifest } from '../src/deploy-lib/index.js';

export async function printBanner(command: string): Promise<void> {
  const paths = packagePaths('abmind');
  const manifest = await readManifest(paths.manifest);
  const version = manifest?.version ?? 'unknown';
  const commit = manifest?.commit ?? '?';
  process.stdout.write(`abmind ${command}\nVersion: ${version} (${commit})\n\n`);
}
