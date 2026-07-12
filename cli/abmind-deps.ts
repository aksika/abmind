#!/usr/bin/env node
/**
 * abmind deps — manage native dependencies (better-sqlite3, sqlite-vec).
 * Installs to ~/.local/lib/node_modules/ (shared with abtars).
 *
 * #1388: All shared-root mutations go through the native-deps lock + manifest
 * to prevent concurrent corruption and track consumers for safe uninstall.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import {
  acquireLock, releaseLock, generateLockToken,
} from "../src/deploy-lib/shared-native-deps-lock.js";
import {
  readManifest, createEmptyManifest, writeManifest, addConsumer,
} from "../src/deploy-lib/shared-native-deps-manifest.js";

const NATIVE_DEPS = ["better-sqlite3", "sqlite-vec"];

function libNmDir(): string {
  return join(homedir(), ".local", "lib", "node_modules");
}

function isInstalled(pkg: string): boolean {
  return existsSync(join(libNmDir(), pkg));
}

export function depsInstall(): void {
  const token = generateLockToken();
  acquireLock("abmind", "install:native", token);
  try {
    const dir = join(homedir(), ".local", "lib");
    mkdirSync(dir, { recursive: true });
    for (const pkg of NATIVE_DEPS) {
      if (isInstalled(pkg)) {
        process.stdout.write(`  ✓ ${pkg} already installed\n`);
        continue;
      }
      process.stdout.write(`  → Installing ${pkg}...\n`);
      execSync(`npm install --prefix "${dir}" ${NATIVE_DEPS.join(" ")} --no-audit --no-fund`, { stdio: "pipe" });
      // Track consumer
      const manifest = readManifest() ?? createEmptyManifest();
      for (const p of NATIVE_DEPS) {
        const updated = addConsumer(manifest, p, "abmind");
        Object.assign(manifest, updated);
      }
      writeManifest(manifest);
    }
    process.stdout.write(`✓ all native deps present\n`);
  } finally {
    releaseLock(token);
  }
}

function depsList(): void {
  process.stdout.write("Native deps (shared with abtars):\n\n");
  for (const pkg of NATIVE_DEPS) {
    const installed = isInstalled(pkg);
    const icon = installed ? "✓" : "○";
    process.stdout.write(`  ${icon} ${pkg}\n`);
  }
  process.stdout.write(`\nInstall: abmind deps install\n`);
}

export async function deps(args: string[]): Promise<number> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list": depsList(); return 0;
    case "install": depsInstall(); return 0;
    default:
      process.stderr.write(`Unknown: abmind deps ${sub}\nUsage: abmind deps [list|install]\n`);
      return 1;
  }
}
