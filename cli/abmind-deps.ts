#!/usr/bin/env node
/**
 * abmind deps — manage native dependencies (better-sqlite3, sqlite-vec).
 * Installs to ~/.local/lib/node_modules/ (shared with abtars).
 *
 * #1388: All shared-root mutations go through the native-deps lock + manifest
 * to prevent concurrent corruption and track consumers for safe uninstall.
 * #1436: Uses exact tested targets (better-sqlite3@12.11.1, sqlite-vec@0.1.9)
 * with staged npm transactions, closure collision checks, native probes,
 * atomic activation, and rollback.
 */

import { NATIVE_TARGET_CONTRACT, NATIVE_TARGET_NAMES, nativeTargetVersion } from "../cli/lib/native-dep-targets.js";
import type { NativeTargetPackage } from "../cli/lib/native-dep-targets.js";
import { observeNativeGroup, selectNativeGroupAction, ensureNativeGroup } from "../src/deploy-lib/shared-native-deps-group.js";

const GROUP_LABEL = "Native deps (shared with abtars)";

function stateIcon(state: string): string {
  switch (state) {
    case "ready": return "✓";
    case "absent": return "○";
    case "partial": case "drifted": return "◐";
    case "invalid": return "✗";
    default: return "?";
  }
}

function depsList(): void {
  const obs = observeNativeGroup();
  process.stdout.write(`${GROUP_LABEL}:\n\n`);
  process.stdout.write(`  Contract: ${NATIVE_TARGET_CONTRACT.contractHash}\n`);
  process.stdout.write(`  Node: >=${NATIVE_TARGET_CONTRACT.nodeMajor}\n\n`);
  for (const pkg of obs.packages) {
    const icon = stateIcon(pkg.observed.state);
    const target = `target ${pkg.target}`;
    let stateStr: string;
    if (pkg.observed.state === "absent") {
      stateStr = "not installed";
    } else if (pkg.observed.state === "invalid") {
      stateStr = `invalid (${pkg.observed.reason})`;
    } else {
      stateStr = `${pkg.observed.version}`;
    }
    process.stdout.write(`  ${icon} ${pkg.name.padEnd(20)} ${stateStr} (${target})\n`);
  }
  process.stdout.write(`\n  Group state: ${obs.state}\n`);
  process.stdout.write(`\nInstall: abmind deps install\n`);
  process.stdout.write(`Update:  abmind deps update\n`);
}

function doInstall(): number {
  const obs = observeNativeGroup();
  const action = selectNativeGroupAction("install", obs);

  if (action === "reuse") {
    const result = ensureNativeGroup("abmind", "install");
    if (result.ok) {
      process.stdout.write(`✓ native deps already installed at exact targets\n`);
      return 0;
    }
    process.stderr.write(`✗ native deps install failed: ${result.error}\n`);
    return 1;
  }

  process.stdout.write(`→ Installing native deps (${obs.state})...\n`);
  const result = ensureNativeGroup("abmind", "install");
  if (result.ok) {
    process.stdout.write(`✓ native deps installed\n`);
    return 0;
  }
  process.stderr.write(`✗ native deps install failed: ${result.error}\n`);
  return 1;
}

function doUpdate(): number {
  const obs = observeNativeGroup();
  const action = selectNativeGroupAction("update", obs);

  if (action === "instruct-install") {
    process.stdout.write(`○ native deps not installed. Run: abmind deps install\n`);
    return 1;
  }

  const label = (action === "refresh" || action === "reuse") ? "Refreshing" : "Repairing";
  process.stdout.write(`→ ${label} native deps...\n`);
  const result = ensureNativeGroup("abmind", "update");
  if (result.ok) {
    process.stdout.write(`✓ native deps ${label.toLowerCase()}ed\n`);
    return 0;
  }
  process.stderr.write(`✗ native deps ${label.toLowerCase()} failed: ${result.error}\n`);
  return 1;
}

export async function deps(args: string[]): Promise<number> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list": depsList(); return 0;
    case "install": return doInstall();
    case "update": return doUpdate();
    default:
      process.stderr.write(`Unknown: abmind deps ${sub}\nUsage: abmind deps [list|install|update]\n`);
      return 1;
  }
}

/**
 * Synchronous install for use from abmind-install.ts setup flow.
 * Exits the process on failure.
 */
export function depsInstall(): void {
  const code = doInstall();
  if (code !== 0) process.exit(code);
}
