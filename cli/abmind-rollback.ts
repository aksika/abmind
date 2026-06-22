#!/usr/bin/env node
/**
 * abmind rollback [--to vX.Y.Z] — flip current to prior release.
 * Mirrors abtars rollback. Validates target exists; refuses if
 * package_lock_hash mismatches.
 */

import { acquireLock, activate, packagePaths, readManifest, releaseExists, writeManifest, type PriorRelease } from '../src/deploy-lib/index.js';

async function run(): Promise<number> {
  const argv = process.argv.slice(2);
  const to = argv.includes('--to') ? argv[argv.indexOf('--to') + 1] : undefined;

  const paths = packagePaths('abmind');
  const manifest = await readManifest(paths.manifest);
  process.stdout.write(`abmind rollback\nVersion: ${manifest?.version ?? "unknown"} (${manifest?.commit ?? "?"})\n\n`);
  if (!manifest || !manifest.version) {
    process.stderr.write(`No active abmind release; nothing to roll back.\n`);
    return 2;
  }
  if (manifest.priorReleases.length === 0 && to === undefined) {
    process.stderr.write(`No prior releases recorded.\n`);
    return 2;
  }

  const target: string = to ?? manifest.priorReleases[0]!.version;
  if (target === manifest.version) {
    process.stdout.write(`Already at ${target}; no-op.\n`);
    return 0;
  }

  if (!(await releaseExists(paths.releases, target))) {
    const available = [manifest.version, ...manifest.priorReleases.map((r) => r.version)];
    process.stderr.write(
      `Target '${target}' does not exist.\nAvailable: ${available.join(', ')}\n` +
        `If pruned, rebuild from the target's git SHA with 'abmind update --from-local'.\n`,
    );
    return 2;
  }

  const targetRecord: PriorRelease | null =
    manifest.priorReleases.find((r) => r.version === target) ?? null;
  if (
    manifest.packageLockHash &&
    targetRecord?.packageLockHash &&
    manifest.packageLockHash !== targetRecord.packageLockHash
  ) {
    process.stderr.write(
      `v${manifest.version} pinned different deps than v${target}.\n` +
        `Rollback via symlink is unsafe. Instead:\n` +
        `  git checkout ${targetRecord.commit ?? '<commit>'}\n` +
        `  abmind update --from-local\n`,
    );
    return 3;
  }

  const release = await acquireLock(paths.lock, `rollback --to ${target}`);
  try {
    await activate(paths.current, target);
    process.stdout.write(`✓ current -> releases/${target}\n`);

    const newPrior: PriorRelease = {
      version: manifest.version,
      commit: manifest.commit,
      activatedAt: manifest.activatedAt,
      packageLockHash: manifest.packageLockHash,
    };
    const remainingPriors = manifest.priorReleases.filter((r) => r.version !== target);
    await writeManifest(paths.manifest, {
      ...manifest,
      version: target,
      commit: targetRecord?.commit ?? null,
      packageLockHash: targetRecord?.packageLockHash ?? null,
      activatedAt: new Date().toISOString(),
      priorReleases: [newPrior, ...remainingPriors],
    });
    process.stdout.write(`\nabmind rollback complete: ${target}\n`);
    return 0;
  } finally {
    await release();
  }
}

try {
  const exitCode = await run();
  process.exit(exitCode);
} catch (err) {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
