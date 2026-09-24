import type {
  AbmindMethod, AbmindMethodMap, AbmindCapabilitiesV1,
  AbmindSystemHealthOutput, AbmindSystemStatusOutput,
  ServiceCallContext, DoctorRepairAction, DoctorRepairResult, DoctorCheckResult,
} from "./abmind-protocol.js";
import {
  ABMIND_PROTOCOL_VERSION, METHOD_REGISTRY,
  CAS_WRITE_ENABLED, PRIVATE_MUTATION_CONTRACT, ABMIND_VERSION,
} from "./abmind-protocol.js";
import type { MemoryManager } from "./memory-manager.js";
import type { OperationalMemoryApi } from "./imemory-system.js";
import type { PageRequest } from "./operational-memory-types.js";
import { runDiagnostics, runRepair } from "./operator-diagnostics.js";
import { HostMemoryLifecycle } from "./host-integration/lifecycle.js";
import type {
  StartSessionInput, PrepareTurnInput, CompleteTurnInput,
  ExplicitRecallInput, ExplicitStoreInput, CheckpointInput,
} from "./host-integration/types.js";
import { validateIdentity } from "./host-integration/identity.js";
import type { ObservationSink } from "./host-integration/observations.js";
import { OBSERVATION_WINDOW_MAX, OBSERVATION_WINDOW_TTL_MS } from "./host-integration/observations.js";
import type { SleepCoordinator } from "./sleep-service/sleep-coordinator.js";

// ── System/operational domain handlers (#1695) ─────────────────────────────
// Domain logic for system.*, lifecycle, operational.*, sleep.*, and
// operator.* methods, extracted from AbmindService. Same contract as the
// memory-dispatch module: typed inputs, no ledger access, no protocol
// response building. The service keeps the per-method routing switch; the
// sleep and operational families sub-route here because every method in each
// family takes the same single dependency.

export type SleepMethod = Extract<AbmindMethod, `sleep.${string}`>;
export type OperationalMethod = Extract<AbmindMethod, `operational.${string}`>;

/** Point-in-time service snapshot for the system handlers. Plain data, no manager. */
export interface ServiceInfo {
  mode: "embedded" | "daemon";
  serverInstanceId: string;
  operationalAvailable: boolean;
  memoryEnabled: boolean;
  buildCommit: string | null;
  releaseId: string | null;
  startTime: number;
  requestCount: number;
}

export function dispatchNegotiate(context: ServiceCallContext | undefined, info: ServiceInfo): AbmindCapabilitiesV1 {
  let methods: string[];
  if (context?.allowedMethods) {
    methods = [...context.allowedMethods].filter(m => m in METHOD_REGISTRY && METHOD_REGISTRY[m as AbmindMethod].safety !== "unavailable");
  } else {
    methods = Object.entries(METHOD_REGISTRY)
      .filter(([, entry]) => entry.safety !== "unavailable")
      .map(([method]) => method);
  }
  // #1660: sealed plaintext resolution is local-only. Signed peers never
  // negotiate it; dispatch rejects a forged frame regardless.
  if (context?.authenticatedBy === "signed_peer") {
    methods = methods.filter((m) => m !== "private.resolveSealedSecret" && m !== "private.findSealedSecrets");
  }
  const domains = ["system", "private", "operational", "operator"];
  const features = buildFeatureSnapshot(info);
  return { version: ABMIND_PROTOCOL_VERSION, methods, domains, features };
}

export function buildFeatureSnapshot(info: ServiceInfo): Record<string, string> {
  return {
    mode: info.mode,
    private_read: "true",
    private_write: String(CAS_WRITE_ENABLED),
    private_mutation_contract: CAS_WRITE_ENABLED ? PRIVATE_MUTATION_CONTRACT : "unavailable",
    operational: String(info.operationalAvailable),
    memory_enabled: String(info.memoryEnabled),
    lifecycle_observe: 'true',
    lifecycle_observe_window_max: String(OBSERVATION_WINDOW_MAX),
    lifecycle_observe_window_ttl_ms: String(OBSERVATION_WINDOW_TTL_MS),
  };
}

export function dispatchHealth(info: ServiceInfo): AbmindSystemHealthOutput {
  return { status: info.memoryEnabled ? "healthy" : "degraded", uptimeMs: Date.now() - info.startTime, memoryEnabled: info.memoryEnabled };
}

export function dispatchStatus(info: ServiceInfo): AbmindSystemStatusOutput {
  return {
    version: ABMIND_VERSION,
    buildCommit: info.buildCommit,
    releaseId: info.releaseId,
    mode: info.mode,
    instanceId: info.serverInstanceId,
    pid: process.pid,
    databaseSizeBytes: 0,
    operationalDbSizeBytes: 0,
    uptimeMs: Date.now() - info.startTime,
    requestCount: info.requestCount,
  };
}

export function dispatchCapabilities(info: ServiceInfo): Record<string, string> {
  return {
    version: String(ABMIND_PROTOCOL_VERSION),
    mode: info.mode,
    ...buildFeatureSnapshot(info),
  };
}

/**
 * #1383 — trusted write-ownership gate for lifecycle automatic writes.
 * The writer must be caller-consistent (automaticWriteOwner equals the
 * authenticated-or-delegated identity principal — a caller-selected third
 * party fails) and configured (a member of lifecycleWriteOwners).
 * Returns the verified writer, a benign skip, or a definitive failure.
 */
export function resolveLifecycleWriter(
  identity: unknown,
  lifecycleOwners: ReadonlySet<string>,
):
  | { ok: true; writerId: string }
  | { ok: false; failed: boolean; code: string; message: string } {
  const id = identity as Record<string, unknown> | null | undefined;
  const principal = id !== null && typeof id === "object" ? id.principalId : undefined;
  const owner = id !== null && typeof id === "object" ? id.automaticWriteOwner : undefined;
  if (typeof principal !== "string" || !principal.trim()
    || typeof owner !== "string" || !owner.trim()) {
    return { ok: false, failed: true, code: "validation_error", message: "identity.principalId and identity.automaticWriteOwner must be non-empty strings" };
  }
  if (owner !== principal) {
    return { ok: false, failed: true, code: "unauthorized", message: "automaticWriteOwner must equal the calling principal" };
  }
  if (!lifecycleOwners.has(owner)) {
    return { ok: false, failed: false, code: "not_owner", message: "automaticWriteOwner is not an enabled lifecycle writer" };
  }
  return { ok: true, writerId: owner };
}

// #1383 — host-lifecycle RPCs. Each delegates to the lifecycle service,
// which validates identity shape and write ownership and returns
// diagnostics-bearing results. The writer is decided by
// resolveLifecycleWriter before dispatch, never inside the lifecycle
// service: writerId arrives pre-verified against trusted owner
// configuration. failOpen is false: programming errors surface as dispatch
// failures, while invalid identity returns diagnostics-bearing results.

export function dispatchLifecycleStartSession(
  manager: MemoryManager,
  context: ServiceCallContext | undefined,
  input: StartSessionInput,
): Promise<AbmindMethodMap["private.lifecycleStartSession"]["output"]> {
  if (!context) throw new Error("Context required for lifecycle call");
  return new HostMemoryLifecycle(manager, { writerId: context.principalId, failOpen: false }).startSession(input);
}

export function dispatchLifecyclePrepareTurn(
  manager: MemoryManager,
  context: ServiceCallContext | undefined,
  input: PrepareTurnInput,
): Promise<AbmindMethodMap["private.lifecyclePrepareTurn"]["output"]> {
  if (!context) throw new Error("Context required for lifecycle call");
  return new HostMemoryLifecycle(manager, { writerId: context.principalId, failOpen: false }).prepareTurn(input);
}

export function dispatchLifecycleCompleteTurn(
  manager: MemoryManager,
  context: ServiceCallContext | undefined,
  lifecycleOwners: ReadonlySet<string>,
  input: CompleteTurnInput,
): AbmindMethodMap["private.lifecycleCompleteTurn"]["output"] {
  const gate = resolveLifecycleWriter((input as { identity?: unknown }).identity, lifecycleOwners);
  if (!context) throw new Error("Context required for lifecycle call");
  if (!gate.ok) {
    return (gate.failed
      ? { status: "failed", diagnostic: { operation: "lifecycleCompleteTurn", code: gate.code, message: gate.message } }
      : { status: "skipped", reason: "not_owner" }) as unknown as AbmindMethodMap["private.lifecycleCompleteTurn"]["output"];
  }
  return new HostMemoryLifecycle(manager, { writerId: gate.writerId, failOpen: false }).completeTurn(input);
}

export function dispatchLifecycleRecall(
  manager: MemoryManager,
  context: ServiceCallContext | undefined,
  input: ExplicitRecallInput,
): Promise<AbmindMethodMap["private.lifecycleRecall"]["output"]> {
  if (!context) throw new Error("Context required for lifecycle call");
  return new HostMemoryLifecycle(manager, { writerId: context.principalId, failOpen: false }).recall(input);
}

export async function dispatchLifecycleStore(
  manager: MemoryManager,
  input: ExplicitStoreInput,
): Promise<AbmindMethodMap["private.lifecycleStore"]["output"]> {
  const { diagnostics } = validateIdentity(input.identity);
  if (diagnostics.length > 0) {
    return { stored: false, memoriesCount: 0, code: "validation_error", message: diagnostics[0]!.message } as unknown as AbmindMethodMap["private.lifecycleStore"]["output"];
  }
  return await new HostMemoryLifecycle(manager, { writerId: input.identity?.principalId, failOpen: false }).store(input);
}

export function dispatchLifecycleObserve(
  sink: ObservationSink,
  input: AbmindMethodMap["private.lifecycleObserve"]["input"],
): AbmindMethodMap["private.lifecycleObserve"]["output"] {
  return sink.observe(input as Parameters<ObservationSink["observe"]>[0]);
}

export function dispatchLifecycleCheckpoint(
  manager: MemoryManager,
  context: ServiceCallContext | undefined,
  lifecycleOwners: ReadonlySet<string>,
  input: CheckpointInput,
): AbmindMethodMap["private.lifecycleCheckpoint"]["output"] {
  const gate = resolveLifecycleWriter((input as { identity?: unknown }).identity, lifecycleOwners);
  if (!context) throw new Error("Context required for lifecycle call");
  if (!gate.ok) {
    return (gate.failed
      ? { status: "failed", diagnostic: { operation: "lifecycleCheckpoint", code: gate.code, message: gate.message } }
      : { status: "skipped", reason: "not_owner" }) as unknown as AbmindMethodMap["private.lifecycleCheckpoint"]["output"];
  }
  return new HostMemoryLifecycle(manager, { writerId: gate.writerId, failOpen: false }).checkpoint(input);
}

export async function dispatchOperational(
  operational: OperationalMemoryApi,
  method: OperationalMethod,
  payload: unknown,
): Promise<AbmindMethodMap[OperationalMethod]["output"]> {
  const p = payload;
  switch (method) {
    case "operational.submitDraft":
      return await operational.submitDraft(p as Parameters<OperationalMemoryApi["submitDraft"]>[0]) as AbmindMethodMap[OperationalMethod]["output"];
    case "operational.listDrafts":
      return await operational.listDrafts(p as Parameters<OperationalMemoryApi["listDrafts"]>[0]) as AbmindMethodMap[OperationalMethod]["output"];
    case "operational.getMemory":
      return await operational.getMemory((p as { memoryId: string }).memoryId) as AbmindMethodMap[OperationalMethod]["output"];
    case "operational.getHistory":
      return await operational.getHistory(
        (p as { memoryId: string; page: PageRequest }).memoryId,
        (p as { memoryId: string; page: PageRequest }).page,
      ) as AbmindMethodMap[OperationalMethod]["output"];
    case "operational.promoteDraft":
      return await operational.promoteDraft(p as Parameters<OperationalMemoryApi["promoteDraft"]>[0]) as AbmindMethodMap[OperationalMethod]["output"];
    case "operational.rejectDraft":
      return await operational.rejectDraft(p as Parameters<OperationalMemoryApi["rejectDraft"]>[0]) as AbmindMethodMap[OperationalMethod]["output"];
    case "operational.revise":
      return await operational.revise(p as Parameters<OperationalMemoryApi["revise"]>[0]) as AbmindMethodMap[OperationalMethod]["output"];
    case "operational.retire":
      return await operational.retire(p as Parameters<OperationalMemoryApi["retire"]>[0]) as AbmindMethodMap[OperationalMethod]["output"];
    case "operational.recall":
      return await operational.recall(p as Parameters<OperationalMemoryApi["recall"]>[0]) as AbmindMethodMap[OperationalMethod]["output"];
  }
}

// ── Sleep service (#1381) ──────────────────────────────────────────────
export async function dispatchSleep(
  coordinator: SleepCoordinator,
  method: SleepMethod,
  payload: unknown,
): Promise<AbmindMethodMap[SleepMethod]["output"]> {
  const p = payload;
  switch (method) {
    case "sleep.start": {
      const sp = p as AbmindMethodMap["sleep.start"]["input"];
      return coordinator.start(sp.mode, sp.level, sp.fresh) as unknown as AbmindMethodMap[SleepMethod]["output"];
    }
    case "sleep.status": {
      return coordinator.getStatus() as unknown as AbmindMethodMap[SleepMethod]["output"];
    }
    case "sleep.resume": {
      const rp = p as AbmindMethodMap["sleep.resume"]["input"];
      return coordinator.resume(rp.runId, rp.level) as unknown as AbmindMethodMap[SleepMethod]["output"];
    }
    case "sleep.cancel": {
      const cp = p as AbmindMethodMap["sleep.cancel"]["input"];
      return coordinator.cancel(cp.runId) as unknown as AbmindMethodMap[SleepMethod]["output"];
    }
    case "sleep.events": {
      const ep = p as AbmindMethodMap["sleep.events"]["input"];
      const status = coordinator.getStatus();
      const result = await coordinator.eventRing.readAfter(ep.afterSeq, ep.limit ?? 50, ep.waitMs ?? 0);
      return {
        runId: status.active?.runId ?? status.last?.runId ?? "",
        events: result.events,
        nextSeq: result.nextSeq,
        gap: result.gap,
        terminal: result.terminal,
      } as unknown as AbmindMethodMap[SleepMethod]["output"];
    }
    case "sleep.runtime.open": {
      const op = p as AbmindMethodMap["sleep.runtime.open"]["input"];
      return coordinator.runtimeBroker.open(op.providerInstanceId) as unknown as AbmindMethodMap[SleepMethod]["output"];
    }
    case "sleep.runtime.next": {
      const np = p as AbmindMethodMap["sleep.runtime.next"]["input"];
      return await coordinator.runtimeBroker.next(np.leaseId, np.waitMs ?? 30_000) as unknown as AbmindMethodMap[SleepMethod]["output"];
    }
    case "sleep.runtime.complete": {
      const cp = p as AbmindMethodMap["sleep.runtime.complete"]["input"];
      return coordinator.runtimeBroker.complete(cp.leaseId, cp.completionId, cp.text, cp.outcome) as unknown as AbmindMethodMap[SleepMethod]["output"];
    }
    case "sleep.runtime.fail": {
      const fp = p as AbmindMethodMap["sleep.runtime.fail"]["input"];
      return coordinator.runtimeBroker.fail(fp.leaseId, fp.completionId, fp.code, fp.failure) as unknown as AbmindMethodMap[SleepMethod]["output"];
    }
    case "sleep.runtime.close": {
      const clp = p as AbmindMethodMap["sleep.runtime.close"]["input"];
      return coordinator.runtimeBroker.close(clp.leaseId) as unknown as AbmindMethodMap[SleepMethod]["output"];
    }
  }
}

export async function dispatchDiagnose(
  manager: MemoryManager,
): Promise<{ checks: DoctorCheckResult[] }> {
  const checks = await runDiagnostics({ manager, memoryDir: manager.getConfig().memoryDir });
  return { checks };
}

export async function dispatchRepair(
  manager: MemoryManager,
  input: AbmindMethodMap["operator.repair"]["input"],
): Promise<DoctorRepairResult> {
  return await runRepair(manager, manager.getConfig().memoryDir, input.action);
}
