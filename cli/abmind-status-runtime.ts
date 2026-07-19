#!/usr/bin/env node
/**
 * abmind status-runtime — print runtime state (version, lock, key, SOUL, memory, daemon, hooks).
 *
 * Reads active release metadata from `current/release.json` (authoritative).
 * Contacts the daemon for service stats when available.
 * Falls back to manifest.json when the standalone layout has not been initialized.
 *
 * No MemoryManager or SQLite initialization — daemon is the DB owner.
 */

import { inspectLock, standalonePaths, readManifest } from '../src/deploy-lib/index.js';
import { readReleaseJson } from './lib/standalone-installer.js';
import type { Manifest } from '../src/deploy-lib/manifest.js';
import { getPackageVersion, printBanner } from './banner.js';
import { join } from 'node:path';
import { existsSync, lstatSync, readlinkSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

interface StatusInstall {
  home: string;
  version: string | null;
  releaseId: string | null;
  commit: string | null;
  branch: string | null;
  source: string | null;
  activatedAt: string | null;
  host: string | null;
  keyPresent: boolean;
  soulBytes: number | null;
  deploymentLock: "free" | "held" | "stale";
}

type StatusService = {
  state: "ready";
  mode: string;
  instanceId: string;
  uptimeMs: number;
  memoryEnabled: boolean;
  totalMessages: number;
  extractedMemories: number;
  consolidationDaily: number;
  consolidationWeekly: number;
  consolidationQuarterly: number;
  dbSizeBytes: number;
} | {
  state: "unavailable" | "incompatible" | "unauthorized";
  message: string;
}

interface StatusHooks {
  errorCount: number;
  lastError: string | null;
  activeSidecars: number;
}

interface AbmindStatusView {
  install: StatusInstall;
  service: StatusService;
  hooks: StatusHooks;
}

async function collectInstall(home: string, sp: ReturnType<typeof standalonePaths>, manifest: Manifest | null): Promise<StatusInstall> {
  let activeVersion: string | null = null;
  let activeCommit: string | null = null;
  let activeSource: string | null = null;
  let activeActivatedAt: string | null = null;
  let activeReleaseId: string | null = null;

  try {
    const st = lstatSync(sp.currentLink);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(sp.currentLink);
      const releaseDir = target.startsWith("/") ? target : join(sp.packagesStandalone, target);
      const meta = readReleaseJson(releaseDir);
      if (meta) {
        activeVersion = meta.version;
        activeCommit = meta.commit;
        activeSource = meta.source;
        activeActivatedAt = meta.activatedAt;
        activeReleaseId = meta.releaseId;
      }
    }
  } catch {}

  const version = activeVersion ?? (manifest ? getPackageVersion() : null);
  const commit = activeCommit ?? (manifest && manifest.commit !== '(unknown)' ? manifest.commit : null);
  const source = activeSource ?? (manifest ? manifest.source : null);
  const activatedAt = activeActivatedAt ?? (manifest ? manifest.activatedAt : null);
  const host = manifest ? manifest.host : null;

  const lock = await inspectLock(sp.lock);

  const branch = manifest ? (manifest.branch || null) : null;
  return {
    home: sp.home,
    version,
    releaseId: activeReleaseId,
    commit,
    branch,
    source,
    activatedAt,
    host,
    keyPresent: existsSync(join(sp.home, 'secret', 'abmind.key')),
    soulBytes: getSoulBytes(sp.home),
    deploymentLock: lock.held ? (lock.stale ? "stale" : "held") : "free",
  };
}

function getSoulBytes(homeDir: string): number | null {
  const soulPath = join(homeDir, 'memory', 'core', 'SOUL.md');
  try { return statSync(soulPath).size; } catch { return null; }
}

async function collectService(): Promise<StatusService> {
  try {
    const { AbmindClient } = await import('../src/abmind-client.js');
    const { LocalTransport } = await import('../src/local-transport.js');
    const envMod = await import('../src/env-schema.js');
    const endpoint = envMod.getAbmindEnv().localEndpoint;
    const transport = new LocalTransport(endpoint);
    const client = new AbmindClient(transport);
    await client.negotiate();
    const [health, runtime, memory] = await Promise.all([
      client.system.health(),
      client.system.status(),
      client.privateMemory.getRuntimeStatus({}).catch(() => null),
    ]);
    await client.close().catch(() => {});
    return {
      state: "ready",
      mode: runtime.mode,
      instanceId: runtime.instanceId,
      uptimeMs: health.uptimeMs,
      memoryEnabled: health.memoryEnabled,
      totalMessages: memory?.totalMessages ?? 0,
      extractedMemories: memory?.extractedMemories ?? 0,
      consolidationDaily: memory?.consolidationFiles?.daily ?? 0,
      consolidationWeekly: memory?.consolidationFiles?.weekly ?? 0,
      consolidationQuarterly: memory?.consolidationFiles?.quarterly ?? 0,
      dbSizeBytes: memory?.dbSizeBytes ?? 0,
    };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (msg.includes("unauthorized")) return { state: "unauthorized" as const, message: msg };
    if (msg.includes("version") || msg.includes("incompatible")) return { state: "incompatible" as const, message: msg };
    return { state: "unavailable" as const, message: msg };
  }
}

function collectHooks(homeDir: string): StatusHooks {
  try {
    const errLog = join(homeDir, 'logs', 'hook-errors.log');
    const hooksDir = join(homeDir, 'hooks');
    let errorCount = 0;
    let lastError: string | null = null;
    if (existsSync(errLog)) {
      const lines = readFileSync(errLog, 'utf-8').trim().split('\n').filter(Boolean);
      errorCount = lines.length;
      lastError = lines[lines.length - 1] ?? null;
    }
    const activeSidecars = existsSync(hooksDir)
      ? readdirSync(hooksDir).filter(f => f.startsWith('last-prompt-')).length
      : 0;
    return { errorCount, lastError, activeSidecars };
  } catch { return { errorCount: 0, lastError: null, activeSidecars: 0 }; }
}

function renderStatus(view: AbmindStatusView): string {
  const { install, service, hooks } = view;
  const lines: string[] = [
    'abmind status',
    `  home:          ${install.home}`,
  ];
  if (install.version) lines.push(`  version:       ${install.version}`);
  if (install.releaseId) lines.push(`  release:       ${install.releaseId}`);
  if (install.commit) lines.push(`  commit:        ${install.commit}`);
  if (install.branch && install.branch !== '(unknown)') lines.push(`  branch:        ${install.branch}`);
  if (install.source) lines.push(`  source:        ${install.source}`);
  if (install.activatedAt) lines.push(`  activated:     ${install.activatedAt}`);
  if (install.host) lines.push(`  host:          ${install.host}`);
  lines.push(`  key:           ${install.keyPresent ? '✓ abmind.key' : '✗ missing'}`);
  if (install.soulBytes !== null) lines.push(`  SOUL:          ✓ (${(install.soulBytes / 1024).toFixed(1)} KB)`);
  else lines.push(`  SOUL:          ✗ missing`);
  lines.push(`  lock:          ${install.deploymentLock === "free" ? "not held" : `HELD${install.deploymentLock === "stale" ? " — STALE" : ""}`}`);

  if (service.state === "ready") {
    const dbMb = (service.dbSizeBytes / 1024 / 1024).toFixed(1);
    const cDaily = String(service.consolidationDaily).padStart(2, '0');
    const cWeekly = String(service.consolidationWeekly).padStart(2, '0');
    const cQuarterly = String(service.consolidationQuarterly).padStart(2, '0');
    lines.push(
      '',
      '  ── Service ──',
      `  mode:          ${service.mode}`,
      `  instance:      ${service.instanceId}`,
      `  uptime:        ${(service.uptimeMs / 1000).toFixed(0)}s`,
      `  memory:        ${service.memoryEnabled ? 'enabled' : 'disabled'}`,
      `  messages:      ${service.totalMessages}`,
      `  memories:      ${service.extractedMemories}`,
      `  consolidation: q${cQuarterly}/w${cWeekly}/d${cDaily}`,
      `  DB size:       ${dbMb} MB`,
    );
  } else {
    lines.push(
      '',
      '  ── Service ──',
      `  state:         ${service.state}`,
      `  ${service.message}`,
    );
  }

  if (hooks.errorCount > 0 || hooks.activeSidecars > 0) {
    lines.push('', '  ── Hooks (#344) ──');
    if (hooks.errorCount > 0) {
      lines.push(`  errors:        ${hooks.errorCount} total`);
      if (hooks.lastError) lines.push(`  last error:    ${hooks.lastError.slice(0, 100)}`);
      lines.push(`                 run 'abmind hook-doctor' for details`);
    }
    if (hooks.activeSidecars > 0) lines.push(`  active sidecars: ${hooks.activeSidecars}`);
  }

  return lines.join('\n');
}

async function run(): Promise<number> {
  const sp = standalonePaths();
  const manifest = await readManifest(sp.manifest);
  await printBanner("status");

  if (!manifest && !existsSync(sp.currentLink)) {
    process.stdout.write(
      `abmind: not installed (no manifest at ${sp.manifest})\nRun 'abmind install' to set up.\n`,
    );
    return 1;
  }

  const install = await collectInstall(sp.home, sp, manifest);
  const service = await collectService();
  const hooks = collectHooks(sp.home);
  process.stdout.write(renderStatus({ install, service, hooks }) + '\n');
  return 0;
}

try {
  const exitCode = await run();
  process.exit(exitCode);
} catch (err) {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
}
