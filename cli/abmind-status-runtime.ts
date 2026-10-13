#!/usr/bin/env node
/**
 * Suppress logger stderr output during status display.
 * Memory modules log to stderr during import/init.
 */
const _origErr = console.error;
console.error = () => {};
/**
 * abmind status — print runtime state (install, daemon, system1/laya, hooks).
 *
 * Reads active release metadata from `current/release.json` (authoritative).
 * Contacts the daemon for service stats when available; the supervisor
 * (launchd/systemd) is the source of truth for whether the daemon is
 * running. Falls back to manifest.json when the standalone layout has not
 * been initialized.
 *
 * No MemoryManager or SQLite initialization — daemon is the DB owner.
 */

import { inspectLock, standalonePaths, readManifest } from '../src/deploy-lib/index.js';
import { readReleaseJson } from './lib/standalone-installer.js';
import type { Manifest } from '../src/deploy-lib/manifest.js';
import { loadMemoryEnv } from '../src/mem-config-env.js';
import { getAbmindEnv } from '../src/env-schema.js';
import { resolveSystem1Config, describeSystem1Config } from '../src/system1-config.js';
import { queryLayaServiceState, describeLayaServiceState } from '../src/deploy-lib/laya-sidecar-service.js';
import { queryDaemonServiceState, describeDaemonServiceState } from '../src/deploy-lib/daemon-service-state.js';
import { renderStatus, type StatusHooks, type StatusInstall, type StatusService } from '../src/deploy-lib/status-view.js';
import { join } from 'node:path';
import { existsSync, lstatSync, readlinkSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

async function collectInstall(home: string, sp: ReturnType<typeof standalonePaths>, manifest: Manifest | null): Promise<StatusInstall> {
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
        activeCommit = meta.commit;
        activeSource = meta.source;
        activeActivatedAt = meta.activatedAt;
        activeReleaseId = meta.releaseId;
      }
    }
  } catch {
    // No current link yet — fall through to manifest values below.
  }

  const commit = activeCommit ?? (manifest && manifest.commit !== '(unknown)' ? manifest.commit : null);
  const source = activeSource ?? (manifest ? manifest.source : null);
  const activatedAt = activeActivatedAt ?? (manifest ? manifest.activatedAt : null);
  const host = manifest ? manifest.host : null;

  const lock = await inspectLock(sp.lock, { staleMs: 60 * 60 * 1000 });

  return {
    home: sp.home,
    releaseId: activeReleaseId,
    commit,
    source,
    activatedAt,
    host,
    keyPresent: existsSync(join(sp.home, 'secret', 'abmind.key')),
    soulBytes: getSoulBytes(sp.home),
    deploymentLock: lock.held ? (lock.stale ? "stale" : "held") : "free",
    daemon: daemonSummary(),
    system1: system1Summary(),
    layaService: layaServiceSummary(),
  };
}

function getSoulBytes(homeDir: string): number | null {
  const soulPath = join(homeDir, 'memory', 'core', 'SOUL.md');
  try { return statSync(soulPath).size; } catch { return null; }
}

/**
 * Supervisor-level daemon liveness for status: loaded/active and pid.
 * Local supervisor queries only — the RPC probe below stays the source of
 * service stats, this line answers "is abmind running" at a glance.
 */
function daemonSummary(): string {
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const state = queryDaemonServiceState({
      platform: process.platform,
      uid,
      command: (name: string, args: readonly string[]) => {
        const r = spawnSync(name, args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        return { status: r.status ?? 1, stdout: r.stdout?.trim() ?? "", stderr: r.stderr?.trim() ?? "" };
      },
    });
    return describeDaemonServiceState(state);
  } catch { return "stopped"; }
}

/**
 * #1812 — one-line System One summary for status. Local configuration only
 * (this process's env after .env.memory sourcing): backend, model/endpoint,
 * recall flag, validity. No network, no secrets, not daemon state.
 */
function system1Summary(): string {
  return describeSystem1Config(resolveSystem1Config(getAbmindEnv()));
}

/**
 * Supervisor-level sidecar liveness for status: running and pid, or stopped.
 * Local supervisor queries only — no sidecar HTTP traffic, so status keeps
 * its no-provider-network-call contract; endpoint truth stays in doctor.
 * Shown when the backend is laya or a managed unit lingers.
 */
function layaServiceSummary(): string | null {
  try {
    const deps = {
      platform: process.platform,
      homeDir: homedir(),
      fileExists: existsSync,
      command: (name: string, args: readonly string[]) => {
        const r = spawnSync(name, args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        return { status: r.status ?? 1, stdout: r.stdout?.trim() ?? "", stderr: r.stderr?.trim() ?? "" };
      },
    };
    const cfg = resolveSystem1Config(getAbmindEnv());
    const state = queryLayaServiceState(deps);
    if ((cfg.state !== "on" || cfg.backend !== "laya") && !state.installed && !state.active) return null;
    return describeLayaServiceState(state);
  } catch { return null; }
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
      pid: runtime.pid,
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

async function run(): Promise<number> {
  const sp = standalonePaths();
  const manifest = await readManifest(sp.manifest);
  // #1812 — source .env.memory before the env singleton initializes (#210,
  // R7: every entry point loads the file; process env keeps precedence).
  loadMemoryEnv();

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
