import type {
  AbmindMethod, AbmindMethodMap, AbmindCapabilitiesV1,
  AbmindSystemHealthOutput, AbmindSystemStatusOutput,
  ServiceCallContext, DoctorRepairResult, DoctorCheckResult,
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
import type { ServiceDispatchDeps } from "./abmind-service.js";

// ── System/operational domain handlers (#1695) ─────────────────────────────
// Domain logic for system.*, lifecycle, operational.*, sleep.*, and
// operator.* methods, extracted from AbmindService. Same contract as the
// memory-dispatch module: typed inputs, no ledger access, no protocol
// response building. The service dispatches through the OPS_HANDLERS table
// below; the sleep and operational families sub-route through
// dispatchSleep/dispatchOperational because every method in each family
// takes the same single dependency.

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

function buildFeatureSnapshot(info: ServiceInfo): Record<string, string> {
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
function resolveLifecycleWriter(
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
  context: ServiceCallContext | undefined,
  input: ExplicitStoreInput,
): Promise<AbmindMethodMap["private.lifecycleStore"]["output"]> {
  const { diagnostics } = validateIdentity(input.identity);
  if (diagnostics.length > 0) {
    return { stored: false, memoriesCount: 0, code: "validation_error", message: diagnostics[0]!.message } as unknown as AbmindMethodMap["private.lifecycleStore"]["output"];
  }
  if (!context) throw new Error("Context required for lifecycle call");
  return await new HostMemoryLifecycle(manager, { writerId: input.identity?.principalId, failOpen: false }).store(input);
}

export function dispatchLifecycleObserve(
  sink: ObservationSink,
  input: AbmindMethodMap["private.lifecycleObserve"]["input"],
): AbmindMethodMap["private.lifecycleObserve"]["output"] {
  return sink.observe(input);
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

// #1885: per-method overloads so the typed handler table below resolves each
// operational method to its own input/output pair with no casts. The
// implementation keeps its existing family switch verbatim.
export async function dispatchOperational(
  operational: OperationalMemoryApi,
  method: "operational.submitDraft",
  payload: AbmindMethodMap["operational.submitDraft"]["input"],
): Promise<AbmindMethodMap["operational.submitDraft"]["output"]>;
export async function dispatchOperational(
  operational: OperationalMemoryApi,
  method: "operational.listDrafts",
  payload: AbmindMethodMap["operational.listDrafts"]["input"],
): Promise<AbmindMethodMap["operational.listDrafts"]["output"]>;
export async function dispatchOperational(
  operational: OperationalMemoryApi,
  method: "operational.getMemory",
  payload: AbmindMethodMap["operational.getMemory"]["input"],
): Promise<AbmindMethodMap["operational.getMemory"]["output"]>;
export async function dispatchOperational(
  operational: OperationalMemoryApi,
  method: "operational.getHistory",
  payload: AbmindMethodMap["operational.getHistory"]["input"],
): Promise<AbmindMethodMap["operational.getHistory"]["output"]>;
export async function dispatchOperational(
  operational: OperationalMemoryApi,
  method: "operational.promoteDraft",
  payload: AbmindMethodMap["operational.promoteDraft"]["input"],
): Promise<AbmindMethodMap["operational.promoteDraft"]["output"]>;
export async function dispatchOperational(
  operational: OperationalMemoryApi,
  method: "operational.rejectDraft",
  payload: AbmindMethodMap["operational.rejectDraft"]["input"],
): Promise<AbmindMethodMap["operational.rejectDraft"]["output"]>;
export async function dispatchOperational(
  operational: OperationalMemoryApi,
  method: "operational.revise",
  payload: AbmindMethodMap["operational.revise"]["input"],
): Promise<AbmindMethodMap["operational.revise"]["output"]>;
export async function dispatchOperational(
  operational: OperationalMemoryApi,
  method: "operational.retire",
  payload: AbmindMethodMap["operational.retire"]["input"],
): Promise<AbmindMethodMap["operational.retire"]["output"]>;
export async function dispatchOperational(
  operational: OperationalMemoryApi,
  method: "operational.recall",
  payload: AbmindMethodMap["operational.recall"]["input"],
): Promise<AbmindMethodMap["operational.recall"]["output"]>;
export async function dispatchOperational(
  operational: OperationalMemoryApi,
  method: OperationalMethod,
  payload: unknown,
): Promise<AbmindMethodMap[OperationalMethod]["output"]> {
  const p = payload;
  switch (method) {
    case "operational.submitDraft":
      return await operational.submitDraft(p as Parameters<OperationalMemoryApi["submitDraft"]>[0]);
    case "operational.listDrafts":
      return await operational.listDrafts(p as Parameters<OperationalMemoryApi["listDrafts"]>[0]);
    case "operational.getMemory":
      return await operational.getMemory((p as { memoryId: string }).memoryId);
    case "operational.getHistory":
      return await operational.getHistory(
        (p as { memoryId: string; page: PageRequest }).memoryId,
        (p as { memoryId: string; page: PageRequest }).page,
      );
    case "operational.promoteDraft":
      return await operational.promoteDraft(p as Parameters<OperationalMemoryApi["promoteDraft"]>[0]);
    case "operational.rejectDraft":
      return await operational.rejectDraft(p as Parameters<OperationalMemoryApi["rejectDraft"]>[0]);
    case "operational.revise":
      return await operational.revise(p as Parameters<OperationalMemoryApi["revise"]>[0]);
    case "operational.retire":
      return await operational.retire(p as Parameters<OperationalMemoryApi["retire"]>[0]);
    case "operational.recall":
      return await operational.recall(p as Parameters<OperationalMemoryApi["recall"]>[0]);
  }
}

// ── Sleep service (#1381) ──────────────────────────────────────────────
// #1885: per-method overloads, same contract as dispatchOperational above.
export async function dispatchSleep(
  coordinator: SleepCoordinator,
  method: "sleep.start",
  payload: AbmindMethodMap["sleep.start"]["input"],
): Promise<AbmindMethodMap["sleep.start"]["output"]>;
export async function dispatchSleep(
  coordinator: SleepCoordinator,
  method: "sleep.status",
  payload: AbmindMethodMap["sleep.status"]["input"],
): Promise<AbmindMethodMap["sleep.status"]["output"]>;
export async function dispatchSleep(
  coordinator: SleepCoordinator,
  method: "sleep.resume",
  payload: AbmindMethodMap["sleep.resume"]["input"],
): Promise<AbmindMethodMap["sleep.resume"]["output"]>;
export async function dispatchSleep(
  coordinator: SleepCoordinator,
  method: "sleep.cancel",
  payload: AbmindMethodMap["sleep.cancel"]["input"],
): Promise<AbmindMethodMap["sleep.cancel"]["output"]>;
export async function dispatchSleep(
  coordinator: SleepCoordinator,
  method: "sleep.events",
  payload: AbmindMethodMap["sleep.events"]["input"],
): Promise<AbmindMethodMap["sleep.events"]["output"]>;
export async function dispatchSleep(
  coordinator: SleepCoordinator,
  method: "sleep.runtime.open",
  payload: AbmindMethodMap["sleep.runtime.open"]["input"],
): Promise<AbmindMethodMap["sleep.runtime.open"]["output"]>;
export async function dispatchSleep(
  coordinator: SleepCoordinator,
  method: "sleep.runtime.next",
  payload: AbmindMethodMap["sleep.runtime.next"]["input"],
): Promise<AbmindMethodMap["sleep.runtime.next"]["output"]>;
export async function dispatchSleep(
  coordinator: SleepCoordinator,
  method: "sleep.runtime.complete",
  payload: AbmindMethodMap["sleep.runtime.complete"]["input"],
): Promise<AbmindMethodMap["sleep.runtime.complete"]["output"]>;
export async function dispatchSleep(
  coordinator: SleepCoordinator,
  method: "sleep.runtime.fail",
  payload: AbmindMethodMap["sleep.runtime.fail"]["input"],
): Promise<AbmindMethodMap["sleep.runtime.fail"]["output"]>;
export async function dispatchSleep(
  coordinator: SleepCoordinator,
  method: "sleep.runtime.close",
  payload: AbmindMethodMap["sleep.runtime.close"]["input"],
): Promise<AbmindMethodMap["sleep.runtime.close"]["output"]>;
export async function dispatchSleep(
  coordinator: SleepCoordinator,
  method: SleepMethod,
  payload: unknown,
): Promise<AbmindMethodMap[SleepMethod]["output"]> {
  const p = payload;
  switch (method) {
    case "sleep.start": {
      const sp = p as AbmindMethodMap["sleep.start"]["input"];
      return coordinator.start(sp.mode, sp.level, sp.fresh);
    }
    case "sleep.status": {
      return coordinator.getStatus();
    }
    case "sleep.resume": {
      const rp = p as AbmindMethodMap["sleep.resume"]["input"];
      return coordinator.resume(rp.runId, rp.level);
    }
    case "sleep.cancel": {
      const cp = p as AbmindMethodMap["sleep.cancel"]["input"];
      return coordinator.cancel(cp.runId);
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
      };
    }
    case "sleep.runtime.open": {
      const op = p as AbmindMethodMap["sleep.runtime.open"]["input"];
      const capabilities = op.capabilities?.proposalOnly === true ? { proposalOnly: true } : undefined;
      return coordinator.runtimeBroker.open(op.providerInstanceId, capabilities);
    }
    case "sleep.runtime.next": {
      const np = p as AbmindMethodMap["sleep.runtime.next"]["input"];
      return await coordinator.runtimeBroker.next(np.leaseId, np.waitMs ?? 30_000);
    }
    case "sleep.runtime.complete": {
      const cp = p as AbmindMethodMap["sleep.runtime.complete"]["input"];
      return coordinator.runtimeBroker.complete(cp.leaseId, cp.completionId, cp.text, cp.outcome);
    }
    case "sleep.runtime.fail": {
      const fp = p as AbmindMethodMap["sleep.runtime.fail"]["input"];
      return coordinator.runtimeBroker.fail(fp.leaseId, fp.completionId, fp.code, fp.failure);
    }
    case "sleep.runtime.close": {
      const clp = p as AbmindMethodMap["sleep.runtime.close"]["input"];
      return coordinator.runtimeBroker.close(clp.leaseId);
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

// ── Typed handler table (#1885) ────────────────────────────────────────────
// Same contract as MEMORY_HANDLERS in abmind-memory-dispatch.ts: the service
// dispatches through this table instead of a per-method switch. The subset is
// declared explicitly next to the table; coverage is asserted where the
// service composes both tables.
export type OpsHandlerMethod =
  | "system.negotiate"
  | "system.health"
  | "system.status"
  | "system.capabilities"
  | "private.lifecycleStartSession"
  | "private.lifecyclePrepareTurn"
  | "private.lifecycleCompleteTurn"
  | "private.lifecycleRecall"
  | "private.lifecycleStore"
  | "private.lifecycleObserve"
  | "private.lifecycleCheckpoint"
  | "operational.submitDraft"
  | "operational.listDrafts"
  | "operational.getMemory"
  | "operational.getHistory"
  | "operational.promoteDraft"
  | "operational.rejectDraft"
  | "operational.revise"
  | "operational.retire"
  | "operational.recall"
  | "sleep.start"
  | "sleep.status"
  | "sleep.resume"
  | "sleep.cancel"
  | "sleep.events"
  | "sleep.runtime.open"
  | "sleep.runtime.next"
  | "sleep.runtime.complete"
  | "sleep.runtime.fail"
  | "sleep.runtime.close"
  | "operator.diagnose"
  | "operator.repair";

export const OPS_HANDLERS: {
  [K in OpsHandlerMethod]: (
    deps: ServiceDispatchDeps,
    input: AbmindMethodMap[K]["input"],
  ) => Promise<AbmindMethodMap[K]["output"]> | AbmindMethodMap[K]["output"];
} = {
  "system.negotiate": (deps) => dispatchNegotiate(deps.context, deps.serviceInfo()),
  "system.health": (deps) => dispatchHealth(deps.serviceInfo()),
  "system.status": (deps) => dispatchStatus(deps.serviceInfo()),
  "system.capabilities": (deps) => dispatchCapabilities(deps.serviceInfo()),
  "private.lifecycleStartSession": (deps, input) => dispatchLifecycleStartSession(deps.manager, deps.context, input),
  "private.lifecyclePrepareTurn": (deps, input) => dispatchLifecyclePrepareTurn(deps.manager, deps.context, input),
  "private.lifecycleCompleteTurn": (deps, input) => dispatchLifecycleCompleteTurn(deps.manager, deps.context, deps.lifecycleOwners, input),
  "private.lifecycleRecall": (deps, input) => dispatchLifecycleRecall(deps.manager, deps.context, input),
  "private.lifecycleStore": (deps, input) => dispatchLifecycleStore(deps.manager, deps.context, input),
  "private.lifecycleObserve": (deps, input) => dispatchLifecycleObserve(deps.observationSink, input),
  "private.lifecycleCheckpoint": (deps, input) => dispatchLifecycleCheckpoint(deps.manager, deps.context, deps.lifecycleOwners, input),
  "operational.submitDraft": (deps, input) => dispatchOperational(deps.operational!, "operational.submitDraft", input),
  "operational.listDrafts": (deps, input) => dispatchOperational(deps.operational!, "operational.listDrafts", input),
  "operational.getMemory": (deps, input) => dispatchOperational(deps.operational!, "operational.getMemory", input),
  "operational.getHistory": (deps, input) => dispatchOperational(deps.operational!, "operational.getHistory", input),
  "operational.promoteDraft": (deps, input) => dispatchOperational(deps.operational!, "operational.promoteDraft", input),
  "operational.rejectDraft": (deps, input) => dispatchOperational(deps.operational!, "operational.rejectDraft", input),
  "operational.revise": (deps, input) => dispatchOperational(deps.operational!, "operational.revise", input),
  "operational.retire": (deps, input) => dispatchOperational(deps.operational!, "operational.retire", input),
  "operational.recall": (deps, input) => dispatchOperational(deps.operational!, "operational.recall", input),
  "sleep.start": (deps, input) => dispatchSleep(deps.sleepCoordinator!, "sleep.start", input),
  "sleep.status": (deps, input) => dispatchSleep(deps.sleepCoordinator!, "sleep.status", input),
  "sleep.resume": (deps, input) => dispatchSleep(deps.sleepCoordinator!, "sleep.resume", input),
  "sleep.cancel": (deps, input) => dispatchSleep(deps.sleepCoordinator!, "sleep.cancel", input),
  "sleep.events": (deps, input) => dispatchSleep(deps.sleepCoordinator!, "sleep.events", input),
  "sleep.runtime.open": (deps, input) => dispatchSleep(deps.sleepCoordinator!, "sleep.runtime.open", input),
  "sleep.runtime.next": (deps, input) => dispatchSleep(deps.sleepCoordinator!, "sleep.runtime.next", input),
  "sleep.runtime.complete": (deps, input) => dispatchSleep(deps.sleepCoordinator!, "sleep.runtime.complete", input),
  "sleep.runtime.fail": (deps, input) => dispatchSleep(deps.sleepCoordinator!, "sleep.runtime.fail", input),
  "sleep.runtime.close": (deps, input) => dispatchSleep(deps.sleepCoordinator!, "sleep.runtime.close", input),
  "operator.diagnose": (deps) => dispatchDiagnose(deps.manager),
  "operator.repair": (deps, input) => dispatchRepair(deps.manager, input),
};

// Compile-time proof that the subset lists real methods (a typo fails here,
// not at the composition assertion in the service).
const _assertOpsMethodsAreReal: Exclude<OpsHandlerMethod, AbmindMethod> extends never ? true : never = true;
