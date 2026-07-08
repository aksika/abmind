/**
 * CLI banner — prints command name + version on every invocation.
 *
 * #863: version is read from the local package.json (the global install's
 * package.json, which is the bin's adjacent file). No manifest read, no
 * git rev-parse fallback — the global install isn't a git checkout and
 * the manifest's version is no longer the source of truth.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function printBanner(command: string): Promise<void> {
  const version = getPackageVersion();
  process.stdout.write(`abmind ${command}\nVersion: ${version}\n\n`);
}

export function getPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch { return "unknown"; }
}
