#!/usr/bin/env node
/**
 * abmind update — install a new abmind build to the global npm location.
 *
 * Channels:
 *   --dev <DIR>     build from <DIR>, install globally
 *   --alpha         npm install -g abmind@alpha
 *   --stable        npm install -g abmind@latest
 *
 * #863: writes ONLY to the global install. No release slot, no rollback.
 * #1268: writes manifest (version + commit + source) after successful install
 * so the /update slash command can detect channel changes and skip no-op deploys.
 *
 * CLI shape mirrors `abtars update`. The only difference: --dev requires
 * a <DIR> argument (no auto-pull from GitHub — user pulls first).
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, unlinkSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, resolve, dirname } from "node:path";
import { acquireLock, packagePaths, readManifest, writeManifest, emptyManifest } from "../src/deploy-lib/index.js";
import type { Manifest } from "../src/deploy-lib/index.js";

type Channel = "dev" | "alpha" | "stable";

function runCmd(cmd: string, args: readonly string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with status ${r.status ?? -1}`);
  }
}

function runCmdStdout(cmd: string, args: readonly string[], cwd?: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with status ${r.status}`);
  return r.stdout.trim();
}

function parseArgs(argv: readonly string[]): { channel: Channel; localDir?: string } | "help" | "error" {
  let channel: Channel | null = null;
  let localDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dev") {
      channel = "dev";
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) return "error";
      localDir = isAbsolute(next) ? next : resolve(process.cwd(), next);
      i++;
    } else if (a === "--alpha") {
      channel = "alpha";
    } else if (a === "--stable") {
      channel = "stable";
    } else if (a === "--help" || a === "-h") {
      return "help";
    } else {
      return "error";
    }
  }
  if (!channel) return "error";
  return { channel, localDir };
}

function printHelp(): void {
  process.stdout.write(`abmind update — install a new abmind build

Usage:
  abmind update --dev <DIR>     Build from local source at <DIR>, install globally
  abmind update --alpha         Install latest alpha from npm
  abmind update --stable        Install latest stable from npm

Updates the global abmind install at \$(npm root -g)/abmind. The \`abmind\`
command on PATH picks up the new code immediately. Writes manifest
(version + commit + source) for /update slash command coordination.
`);
}

/**
 * One-shot cleanup of the old release slot system, removed by #863.
 * Runs once per host, guarded by a marker file.
 */
function cleanupOldReleaseSlot(home: string): void {
  const marker = join(home, ".update-v2-cleanup-done");
  if (existsSync(marker)) return;

  const currentLink = join(home, "current");
  const releasesDir = join(home, "releases");

  try {
    if (lstatSync(currentLink).isSymbolicLink()) unlinkSync(currentLink);
  } catch { /* not present */ }

  try {
    rmSync(releasesDir, { recursive: true, force: true });
  } catch { /* not present */ }

  try {
    writeFileSync(marker, new Date().toISOString());
  } catch { /* non-fatal — best-effort cleanup */ }
}

async function run(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    printHelp();
    return 0;
  }
  if (parsed === "error") {
    printHelp();
    return 2;
  }

  const { printBanner } = await import("./banner.js");
  await printBanner("update");

  // One-shot cleanup of the old release slot (best-effort, non-fatal).
  const home = process.env["ABMIND_HOME"] ?? join(homedir(), ".abmind");
  cleanupOldReleaseSlot(home);

  // Acquire the update lock to serialize concurrent updates.
  // The lock is at ~/.abmind/.update.lock and is released on exit.
  const paths = packagePaths("abmind");
  const release = await acquireLock(paths.lock, `update --${parsed.channel}`);
  let version: string;
  let commit: string;
  let source: "local" | "npm";

  try {
    if (parsed.channel === "dev") {
      const dir = parsed.localDir!;
      if (!existsSync(dir) || !existsSync(`${dir}/package.json`)) {
        process.stderr.write(`Not an abmind source tree: ${dir}\n`);
        return 2;
      }
      process.stdout.write(`Building abmind from ${dir}...\n`);
      runCmd("npm", ["install", "--no-audit", "--no-fund"], dir);
      runCmd("npm", ["run", "build"], dir);
      process.stdout.write(`Installing to global location...\n`);
      runCmd("npm", ["install", "-g", "--no-audit", "--no-fund", "."], dir);
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { version: string };
      version = pkg.version;
      commit = runCmdStdout("git", ["-C", dir, "rev-parse", "--short", "HEAD"]);
      source = "local";
    } else if (parsed.channel === "alpha") {
      process.stdout.write(`Installing abmind@alpha from npm...\n`);
      runCmd("npm", ["install", "-g", "--no-audit", "--no-fund", "abmind@alpha"], process.cwd());
      const globalRoot = runCmdStdout("npm", ["root", "-g"]);
      const globalPkg = JSON.parse(readFileSync(join(globalRoot, "abmind", "package.json"), "utf-8")) as { version: string };
      version = globalPkg.version;
      commit = `npm:${version}`;
      source = "npm";
    } else {
      process.stdout.write(`Installing abmind@latest from npm...\n`);
      runCmd("npm", ["install", "-g", "--no-audit", "--no-fund", "abmind@latest"], process.cwd());
      const globalRoot = runCmdStdout("npm", ["root", "-g"]);
      const globalPkg = JSON.parse(readFileSync(join(globalRoot, "abmind", "package.json"), "utf-8")) as { version: string };
      version = globalPkg.version;
      commit = `npm:${version}`;
      source = "npm";
    }

    // Write manifest — best-effort (#1268: partial revert of #863)
    try {
      mkdirSync(dirname(paths.manifest), { recursive: true });
      const prior = await readManifest(paths.manifest);
      const base: Manifest = prior ?? emptyManifest("abmind", hostname());
      await writeManifest(paths.manifest, {
        ...base,
        version,
        commit,
        source,
        activatedAt: new Date().toISOString(),
      });
    } catch { /* best-effort — update succeeded even if manifest write fails */ }

    process.stdout.write(`\u2713 abmind update complete\n`);
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
