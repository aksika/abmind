import { existsSync, readFileSync, realpathSync } from "node:fs";
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

export class AbmindServiceHost {
  private lease_: OwnerLease | null = null;
  private manager_: MemoryManager | null = null;
  private service_: AbmindService | null = null;
  private dbPath_: string | null = null;
  private config_: AbmindOwnerConfig;
  private started_ = false;
  private stopped_ = false;
  private sleepCoordinator_: SleepCoordinator | null = null;

  constructor(config: AbmindOwnerConfig) {
    this.config_ = config;
  }

  get started(): boolean { return this.started_; }
  get manager(): MemoryManager | null { return this.manager_; }
  get service(): AbmindService | null { return this.service_; }
  get sleepCoordinator(): SleepCoordinator | null { return this.sleepCoordinator_; }

  async start(): Promise<void> {
    if (this.started_) return;
    const leaseRoot = this.config_.leaseRoot ?? getCanonicalLeaseDir();
    cleanTombstones(join(leaseRoot, "owners"));

    let lease: OwnerLease | null = null;
    try {
      const processIdentity = this.config_.processIdentity ?? createProcessIdentityProvider();
      const dbPath = join(this.config_.memory.memoryDir, "memory.db");
      this.dbPath_ = dbPath;

      mkdirSync(this.config_.memory.memoryDir, { recursive: true });

      lease = await createOwnerLease({
        runRoot: leaseRoot,
        databasePath: dbPath,
        mode: this.config_.mode,
        processIdentity,
      });
      await lease.acquire();

      const manager = new MemoryManager(this.config_.memory);
      await manager.initialize();
      this.manager_ = manager;

      const db = getMemoryDb(manager);

      ensureInitialized(db!, this.config_.memory.memoryDir);

      const serverInstanceId = lease.instanceId;
      const sleepCoordinator = new SleepCoordinator();
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
          return { status: result.status, report: result.report };
        },
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

      this.lease_ = lease;
      this.started_ = true;
      logInfo(TAG, `AbmindServiceHost started (${this.config_.mode}, instance=${serverInstanceId})`);
    } catch (err) {
      logError(TAG, "AbmindServiceHost start failed", err);
      try { lease?.release(); } catch { /* best effort */ }
      try { this.manager_?.close(); } catch { /* best effort */ }
      this.manager_ = null;
      this.service_ = null;
      this.lease_ = null;
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped_) return;
    this.stopped_ = true;
    this.started_ = false;

    const svc = this.service_;
    svc?.close();
    await svc?.drain(30_000);

    // Cancel sleep before closing its shared MemoryManager. The run owns no
    // manager of its own and may still be unwinding its final event writes.
    this.sleepCoordinator_?.shutdown();
    this.sleepCoordinator_ = null;

    try {
      this.manager_?.close();
    } catch (err) {
      logError(TAG, "Error closing memory manager", err);
    }
    this.manager_ = null;
    this.service_ = null;

    try {
      await this.lease_?.release();
    } catch (err) {
      logError(TAG, "Error releasing owner lease", err);
    }
    this.lease_ = null;
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
