#!/usr/bin/env node
/**
 * abmind update — install a new abmind build to standalone layout.
 *
 * Channels:
 *   --dev [<DIR>]   pull dev into ~/.abmind/src/abmind (no <DIR>), or build
 *                   the tree at <DIR> as-is, then stage and activate
 *   --alpha         acquire abmind@alpha from npm, stage, and activate
 *   --stable        acquire abmind@latest from npm, stage, and activate
 *
 * All channels converge through the shared standalone installer. No global npm
 * writes, no npm-prefix lookup.
 */

import { acquireLock, packagePaths } from "../src/deploy-lib/index.js";
import { parseArgs } from "./abmind-update-args.js";
import { installStandalone, defaultDeps } from "./lib/standalone-installer.js";

function printHelp(): void {
  process.stdout.write(`abmind update — install a new abmind build

Usage:
  abmind update --dev [<DIR>]   Pull dev into ~/.abmind/src/abmind (no <DIR>),
                                build, stage, and activate. With <DIR>, build
                                that tree as-is (no git fetch).
  abmind update --alpha         Acquire and activate latest alpha from npm
  abmind update --stable        Acquire and activate latest stable from npm

Uses the standalone release layout under $ABMIND_HOME/packages/standalone/.
The \`abmind\` command resolves through the active release's launcher.
`);
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

  const paths = packagePaths("abmind");
  const release = await acquireLock(paths.lock, `update --${parsed.channel}`);

  try {
    const deps = defaultDeps();
    const result = await installStandalone(
      {
        channel: parsed.channel,
        explicitDevDir: parsed.localDir,
      },
      deps,
    );

    // Service reconciliation (#1453)
    const svcLib = await import('../src/deploy-lib/abmind-daemon-service.js');
    const serviceResult = svcLib.ensureDaemonService(svcLib.defaultDeps(), { dryRun: false, releaseChanged: result.changed, start: true });
    if (serviceResult.state === "ready") {
      process.stdout.write(`  Service: ${serviceResult.action}\n`);
    } else if (serviceResult.state === "existing-owner") {
      process.stdout.write(`  Service: waiting for manual daemon to exit\n`);
    } else if (serviceResult.state === "needs-linger") {
      process.stdout.write(`  Service: ready, but daemon stops on logout — run: ${serviceResult.remediation}\n`);
    } else if (serviceResult.state === "unsupported") {
      process.stdout.write(`  Service: ${serviceResult.reason} (skipped)\n`);
    }

    if (!result.changed) {
      process.stdout.write(`abmind already up to date (${result.release.releaseId}) — skipping\n`);
      return 0;
    }

    process.stdout.write(`\u2713 abmind update complete\n`);
    process.stdout.write(`  Release: ${result.release.releaseId}\n`);
    process.stdout.write(`  Version: ${result.release.version}\n`);
    process.stdout.write(`  Source:  ${result.release.source}\n`);
    if (result.release.commit) {
      process.stdout.write(`  Commit:  ${result.release.commit}\n`);
    }

    if (result.shadowedBy) {
      process.stderr.write(
        `\n! WARNING: another abmind shadows the standalone install at:\n` +
          `  ${result.shadowedBy}\n` +
          `  Ensure ~/.local/bin is before npm/nvm bin directories in your PATH.\n`,
      );
      return 1;
    }

    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
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
