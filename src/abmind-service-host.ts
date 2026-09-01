import { existsSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryConfig } from "./memory-config.js";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { ensureInitialized } from "./ensure-initialized.js";
import { AbmindService } from "./abmind-service.js";
import type { ServiceCallContext, DomainName } from "./abmind-protocol.js";
import { createOwnerLease, createProcessIdentityProvider, cleanTombstones, getCanonicalLeaseDir, type OwnerLease, type ProcessIdentityProvider } from "./abmind-owner-lease.js";
import { EmbeddedTransport } from "./embedded-transport.js";
import { AbmindClient } from "./abmind-client.js";
import { logError, logInfo } from "./mem-logger.js";
import { SleepCoordinator } from "./sleep-service/sleep-coordinator.js";
import { RuntimeCompletionAdmissionError } from "./sleep-service/runtime-broker.js";
import { runSleepCycle } from "./sleep/orchestrator.js";
import { SleepModelFailureError } from "./sleep/llm-budget.js";
import { parseLevel } from "./sleep/levels.js";
import type { SleepEvent } from "./sleep/contracts.js";
import { resolveAbmindHome } from "./deploy-lib/paths.js";

export interface AbmindOwnerConfig {
  mode: "embedded" | "daemon";
  memory: MemoryConfig;
  policy: AbmindServicePolicy;
  /** Parent directory for the owner lease namespace; defaults to ~/.abmind/run/leases. */
  leaseRoot?: string;
  processIdentity?: ProcessIdentityProvider;
}

interface ReleaseMeta {
  version: string;
  releaseId: string;
  commit: string | null;
}

/** Read release metadata from the daemon's own installation directory.
 *  Derives the release path from the daemon's own argv[1] (after resolving
 *  symlinks) so that an old daemon process cannot falsely report a new
 *  release identity after the `current` symlink is updated. */
function readActiveReleaseMeta(): { buildCommit: string | null; releaseId: string | null } {
  try {
    // Daemon entry: .../packages/standalone/<releaseId>/node_modules/abmind/dist/cli/abmind-daemon.js
    // Going up 5 dirs from dist/cli/abmind-daemon.js gives <releaseId>.
    const ownEntry = process.argv[1];
    if (!ownEntry) return { buildCommit: null, releaseId: null };
    const real = realpathSync(ownEntry);
    const releaseDir = dirname(dirname(dirname(dirname(dirname(real)))));
    const releaseJson = join(releaseDir, "release.json");
    if (!existsSync(releaseJson)) return { buildCommit: null, releaseId: null };
    const meta = JSON.parse(readFileSync(releaseJson, "utf-8")) as ReleaseMeta;
    return { buildCommit: meta.commit ?? null, releaseId: meta.releaseId ?? null };
  } catch {
    return { buildCommit: null, releaseId: null };
  }
}

export interface AbmindServicePolicy {
  principalId: string;
  role: "local_user" | "host_agent" | "service" | "peer";
  grantedDomains: DomainName[];
  authenticatedBy: "embedded" | "local_peer" | "signed_peer";
  capabilities?: string[];
  allowPrivateDelegation?: boolean;
}

export interface EmbeddedCaller {
  principalId: string;
  role: "local_user" | "host_agent" | "service" | "peer";
  capabilities?: string[];
  allowPrivateDelegation?: boolean;
}

export interface EmbeddedAbmind {
  host: AbmindServiceHost;
  client: AbmindClient;
}

const TAG = "abmind-host";

/**
 * #1701: explicit host lifecycle state. Replaces independent started/stopped
 * booleans so start/stop races are decided by one state machine plus shared
 * promises rather than boolean guards that can return early.
 */
type HostLifecycleState = "idle" | "starting" | "started" | "stopping" | "stopped";

/** Bounded internal signal for a startup overtaken by a shutdown request. */
class HostShutdownDuringStartError extends Error {
  constructor() {
    super("Shutdown requested during startup");
    this.name = "HostShutdownDuringStartError";
  }
}

export class AbmindServiceHost {
  private lease_: OwnerLease | null = null;
  private manager_: MemoryManager | null = null;
  private service_: AbmindService | null = null;
  private dbPath_: string | null = null;
  private config_: AbmindOwnerConfig;
  private state_: HostLifecycleState = "idle";
  private startPromise_: Promise<void> | null = null;
  private stopPromise_: Promise<void> | null = null;
  private stopRequested_ = false;
  private sleepCoordinator_: SleepCoordinator | null = null;

  constructor(config: AbmindOwnerConfig) {
    this.config_ = config;
  }

  get started(): boolean { return this.state_ === "started"; }
  get manager(): MemoryManager | null { return this.manager_; }
  get service(): AbmindService | null { return this.service_; }
  get sleepCoordinator(): SleepCoordinator | null { return this.sleepCoordinator_; }

  async start(): Promise<void> {
    if (this.state_ === "starting") return this.startPromise_!;
    if (this.state_ === "started") return;
    if (this.stopRequested_ || this.state_ === "stopping" || this.state_ === "stopped") {
      throw new Error(`AbmindServiceHost cannot start from state ${this.state_}`);
    }

    const once = this.startOnce();
    this.startPromise_ = once;
    try {
      await once;
    } finally {
      if (this.startPromise_ === once) this.startPromise_ = null;
    }
  }

  private async startOnce(): Promise<void> {
    this.state_ = "starting";
    const leaseRoot = this.config_.leaseRoot ?? getCanonicalLeaseDir();
    cleanTombstones(join(leaseRoot, "owners"));

    // Local + instance references to whichever lease objects own acquisition.
    // #1701: an acquired lease is published to this.lease_ immediately so a
    // concurrent stop can observe and release it — it must never exist only
    // in an unobservable local variable.
    let localLease: OwnerLease | null = null;
    try {
      const processIdentity = this.config_.processIdentity ?? createProcessIdentityProvider();
      const dbPath = join(this.config_.memory.memoryDir, "memory.db");
      this.dbPath_ = dbPath;

      mkdirSync(this.config_.memory.memoryDir, { recursive: true });

      localLease = await createOwnerLease({
        runRoot: leaseRoot,
        databasePath: dbPath,
        mode: this.config_.mode,
        processIdentity,
      });
      await localLease.acquire();
      this.lease_ = localLease;
      if (this.stopRequested_) throw new HostShutdownDuringStartError();

      const manager = new MemoryManager(this.config_.memory);
      await manager.initialize();
      this.manager_ = manager;
      if (this.stopRequested_) throw new HostShutdownDuringStartError();

      const db = getMemoryDb(manager);

      ensureInitialized(db!, this.config_.memory.memoryDir);

      const serverInstanceId = localLease.instanceId;
      const sleepCoordinator = new SleepCoordinator(join(this.config_.memory.memoryDir, "sleep-last-run.json"));
      this.sleepCoordinator_ = sleepCoordinator;
      sleepCoordinator.registerServices({
        startSleep: async (mode, level, fresh, runId) => {
          const runMode = mode === "resume" ? "resume" : mode === "manual" ? "manual" : "scheduled";
          const runtime = {
            complete: async (request: { prompt: string; stepId: string; runId: string; signal: AbortSignal; deadlineAt: number }): Promise<string> => {
              // #1676: deadlineAt is the current provider attempt's absolute
              // deadline — abmind refreshes it per attempt, so this adapter
              // must not treat it as one immutable logical-step deadline.
              // Compute the remaining broker window from the supplied value —
              // a normal sleep request must never silently fall back to the
              // broker's 180s default, and an expired attempt must not queue.
              const remainingMs = request.deadlineAt - Date.now();
              if (remainingMs <= 0) {
                throw new SleepModelFailureError(
                  request.stepId,
                  "step_deadline",
                  `Logical step ${request.stepId} deadline already exhausted (${remainingMs}ms) — not queueing`,
                );
              }
              const admission = sleepCoordinator.runtimeBroker.queueCompletion(
                request.runId, request.stepId, request.prompt, remainingMs,
              );
              if (admission.status !== "queued") {
                // #1681: a non-queued admission is a terminal provider refusal.
                // The typed error carries the stable code and the step id so
                // the final sleep failure message distinguishes
                // provider_unavailable from completion_pending.
                throw new RuntimeCompletionAdmissionError(admission.status, request.stepId);
              }
              return sleepCoordinator.runtimeBroker.waitForCompletion(admission.completionId, request.signal);
            },
          };
          const result = await runSleepCycle({
            runtime,
            mode: runMode,
            level: level ? parseLevel(level) : undefined,
            fresh,
            runId,
            signal: sleepCoordinator.abortSignal ?? undefined,
            memoryManager: manager,
            onEvent: (event: SleepEvent) => {
              if (event.type === "cycle_started") sleepCoordinator.pushEvent("cycle_started", runMode);
              else if (event.type === "step_started") sleepCoordinator.pushEvent("step_started", event.stepId);
              else if (event.type === "step_completed") sleepCoordinator.pushEvent("step_completed", event.step.id);
              else if (event.type === "step_skipped") sleepCoordinator.pushEvent("step_skipped", event.step.id);
              else if (event.type === "step_failed") sleepCoordinator.pushEvent("step_failed", event.step.id);
              else if (event.type === "cycle_finished") sleepCoordinator.pushEvent("cycle_finished", event.result.status);
            },
          });
          return { status: result.status, report: result.report, resumable: result.resumable };
        },
      });
      // #1752: checkpoint validator for legacy repair — uses same memoryDir, lock naming, run lineage, PID check, and shared predicate
      sleepCoordinator.registerResumeValidator((requestedRunId?: string) => {
        try {
          const memoryDir = this.config_.memory.memoryDir;
          const sleepDir = join(memoryDir, "sleep");
          if (!existsSync(sleepDir)) return { valid: false, reason: "No sleep locks" };
          const files = readdirSync(sleepDir).filter(f => f.startsWith("sleep_") && f.endsWith(".lock"));
          // Also check the current dated lock path for today
          const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
          // Scan all lock files
          const { readStateFile, isResumableSleepState } = require("./sleep/state.js") as typeof import("./sleep/state.js");
          const isPidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
          for (const file of files) {
            const full = join(sleepDir, file);
            const state = readStateFile(full);
            if (!state) continue;
            // Run lineage match: runId or priorRunId equals requestedRunId (or lastRun's runId if undefined)
            const targetId = requestedRunId;
            if (targetId && state.runId !== targetId && state.priorRunId !== targetId) continue;
            // Also need to ensure lock is not owned by live process unless it's the target run?
            // If state is ongoing with live PID, isResumable will be false
            if (isResumableSleepState(state, isPidAlive)) {
              return { valid: true };
            }
          }
          return { valid: false, reason: "No matching resumable checkpoint" };
        } catch (e) {
          return { valid: false, reason: String(e) };
        }
      });

      const { buildCommit, releaseId } = readActiveReleaseMeta();
      const service = new AbmindService({
        serverInstanceId,
        mode: this.config_.mode,
        manager,
        operational: manager.operational,
        requestLedgerDb: db,
        sleepCoordinator,
        buildCommit,
        releaseId,
      });
      this.service_ = service;

      if (service.ledger) {
        service.ledger.cleanup();
        service.ledger.recoverCrashed();
      }

      if (this.stopRequested_) throw new HostShutdownDuringStartError();

      this.state_ = "started";
      logInfo(TAG, `AbmindServiceHost started (${this.config_.mode}, instance=${serverInstanceId})`);
    } catch (err) {
      const interrupted = err instanceof HostShutdownDuringStartError;
      if (!interrupted) logError(TAG, "AbmindServiceHost start failed", err);
      await this.rollbackStartup(localLease);
      throw err;
    }
  }

  /** Release whatever startup acquired and clear every partial reference. */
  private async rollbackStartup(localLease: OwnerLease | null): Promise<void> {
    try { await localLease?.release(); } catch { /* best effort */ }
    try { this.manager_?.close(); } catch { /* best effort */ }
    this.manager_ = null;
    this.service_ = null;
    this.sleepCoordinator_ = null;
    this.lease_ = null;
    if (this.state_ === "starting") this.state_ = "idle";
  }

  /**
   * #1701 phase 1 of shutdown: idempotent, synchronous. Rejects new service
   * work and terminalizes sleep/runtime waiters, but never closes the manager
   * or releases the owner lease — accepted work keeps its resources until
   * finishStop().
   */
  beginShutdown(): void {
    this.stopRequested_ = true;
    if (this.state_ === "started" || this.state_ === "starting") {
      this.state_ = "stopping";
    }
    const svc = this.service_;
    svc?.close();
    this.sleepCoordinator_?.shutdown();
  }

  /**
   * #1701 phase 2: wait until accepted dispatches complete or `timeoutMs`
   * expires. The service was closed by beginShutdown(); nothing new can enter.
   */
  async drainAcceptedWork(timeoutMs: number): Promise<{ drained: boolean; remainingInFlight: number }> {
    const svc = this.service_;
    if (!svc) return { drained: true, remainingInFlight: 0 };
    return svc.drain(timeoutMs);
  }

  /**
   * #1701 phase 3: final teardown. Awaits any in-progress startup rollback
   * first, closes the manager, and releases the instance-owned lease.
   * Concurrent and later callers share one completion — the shared cleanup
   * owns lease release exactly once.
   */
  async finishStop(): Promise<void> {
    if (!this.stopRequested_) {
      // Direct finishStop without beginShutdown still closes admission first.
      this.beginShutdown();
    }
    this.stopPromise_ ??= this.finishStopOnce();
    await this.stopPromise_;
  }

  private async finishStopOnce(): Promise<void> {
    if (this.startPromise_) {
      try {
        await this.startPromise_;
      } catch {
        // Startup failed and rolled itself back; nothing left to tear down.
      }
    }

    try {
      this.manager_?.close();
    } catch (err) {
      logError(TAG, "Error closing memory manager", err);
    }
    this.manager_ = null;
    this.service_ = null;
    this.sleepCoordinator_ = null;

    try {
      await this.lease_?.release();
    } catch (err) {
      logError(TAG, "Error releasing owner lease", err);
    }
    this.lease_ = null;
    this.state_ = "stopped";
  }

  /**
   * Embedded-owner convenience path composing the three phases with the
   * existing 30-second drain default. Concurrent callers share one completion;
   * none returns before the lease has been released by that shared cleanup.
   */
  async stop(): Promise<void> {
    this.beginShutdown();
    await this.drainAcceptedWork(30_000);
    await this.finishStop();
  }
}

export function createAbmindClient(transport: EmbeddedTransport): AbmindClient {
  return new AbmindClient(transport);
}

export async function createEmbeddedAbmind(
  config: AbmindOwnerConfig,
  caller: EmbeddedCaller,
): Promise<EmbeddedAbmind> {
  const host = new AbmindServiceHost(config);
  await host.start();

  const effectivePolicy: AbmindServicePolicy = config.policy ?? {
    principalId: caller.principalId,
    role: caller.role,
    grantedDomains: ["system", "private", "operational"],
    authenticatedBy: "embedded",
    capabilities: caller.capabilities,
    allowPrivateDelegation: caller.allowPrivateDelegation,
  };

  const context: ServiceCallContext = {
    principalId: effectivePolicy.principalId,
    role: effectivePolicy.role,
    grantedDomains: new Set(effectivePolicy.grantedDomains),
    capabilities: new Set(effectivePolicy.capabilities ?? []),
    allowPrivateDelegation: effectivePolicy.allowPrivateDelegation,
    authenticatedBy: effectivePolicy.authenticatedBy,
  };

  const transport = new EmbeddedTransport(host.service!, context);
  const client = new AbmindClient(transport);

  return { host, client };
}
