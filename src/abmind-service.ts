import type Database from "better-sqlite3";
import type {
  AbmindMethod, AbmindMethodMap, AbmindRequestV1, AbmindResponseV1,
  AbmindErrorBodyV1, AbmindCurrentV1,
  ServiceCallContext, MethodEntry,
} from "./abmind-protocol.js";
import {
  ABMIND_PROTOCOL_VERSION, METHOD_REGISTRY, RESPONSE_MAX_BYTES,
  CAS_WRITE_ENABLED, canonicalPayloadHash, errorBodyV1, isMutatingMethod,
} from "./abmind-protocol.js";
import type { AbmindFailureStageV1 } from "./abmind-protocol.js";
import { logInfo, logTrace } from "./mem-logger.js";
import { fingerprint } from "./request-fingerprint.js";
import type { MemoryManager } from "./memory-manager.js";
import type { OperationalMemoryApi } from "./imemory-system.js";
import { ObservationSink } from "./host-integration/observations.js";
import type { SleepCoordinator } from "./sleep-service/sleep-coordinator.js";
import { ContextCompactionService } from "./context-compaction.js";
import { AbmindRequestLedger } from "./abmind-request-ledger.js";
import type { InFlightMutation } from "./abmind-request-ledger.js";
import { parseEnvelope, validatePayload } from "./abmind-request-validation.js";
import {
  PrivateMutationError as PrivateMutationErrorImpl,
  MEMORY_HANDLERS,
  type MemoryHandlerMethod,
} from "./abmind-memory-dispatch.js";
import {
  OPS_HANDLERS,
  type OpsHandlerMethod,
} from "./abmind-ops-dispatch.js";
import type { ServiceInfo } from "./abmind-ops-dispatch.js";

// Re-exported so every existing import path keeps working with no caller
// changes (#1695): the ledger class and its types moved to
// abmind-request-ledger.ts.
export { AbmindRequestLedger } from "./abmind-request-ledger.js";
export type { ReservationResult, InFlightMutation } from "./abmind-request-ledger.js";

/** #1701: drain outcome — a timed-out drain is observable, never silent. */
export interface DrainResult {
  /** True when accepted in-flight work reached zero within the budget. */
  drained: boolean;
  /** Accepted dispatches still running when the wait ended. */
  remainingInFlight: number;
}

export interface AbmindServiceConfig {
  serverInstanceId: string;
  mode: "embedded" | "daemon";
  manager: MemoryManager;
  operational: OperationalMemoryApi | null;
  requestLedgerDb: Database.Database | null;
  /**
   * #1383 — trusted owner configuration for lifecycle automatic writes.
   * completeTurn/checkpoint over RPC capture only when the call's
   * automaticWriteOwner names a configured owner AND equals the
   * authenticated-or-delegated identity principal. Default empty = deny:
   * caller-selected owners fail closed. Deliberate explicit stores carry
   * their own authority and are unaffected.
   */
  lifecycleWriteOwners?: readonly string[];
  sleepCoordinator?: SleepCoordinator;
  /** Build identity from active release metadata (null for source builds). */
  buildCommit?: string | null;
  releaseId?: string | null;
}

/**
 * #1885: the single dependency bundle for the typed dispatch tables in
 * abmind-memory-dispatch.ts and abmind-ops-dispatch.ts. Built fresh per
 * dispatch so point-in-time snapshots (serviceInfo) never go stale.
 * Handlers take this plus their map-typed input; they never touch the
 * ledger, decide idempotency, or build top-level protocol responses.
 */
export interface ServiceDispatchDeps {
  manager: MemoryManager;
  context: ServiceCallContext | undefined;
  lifecycleOwners: ReadonlySet<string>;
  observationSink: ObservationSink;
  operational: OperationalMemoryApi | null;
  sleepCoordinator: SleepCoordinator | null;
  serviceInfo: () => ServiceInfo;
  getCompactionService: (db: Database.Database) => ContextCompactionService;
}

// #1885: the two handler tables must partition AbmindMethod — every method
// covered exactly once. Adding or removing a registry method fails
// compilation here until both subsets are updated.
type _AssertTableCoverage = Exclude<AbmindMethod, MemoryHandlerMethod | OpsHandlerMethod> extends never ? true : never;
const _assertTableCoverage: _AssertTableCoverage = true;
type _AssertTableNoExtras = Exclude<MemoryHandlerMethod | OpsHandlerMethod, AbmindMethod> extends never ? true : never;
const _assertTableNoExtras: _AssertTableNoExtras = true;
type _AssertTableDisjoint = Extract<MemoryHandlerMethod, OpsHandlerMethod> extends never ? true : never;
const _assertTableDisjoint: _AssertTableDisjoint = true;

export class AbmindService {
  private readonly serverInstanceId: string;
  private readonly mode_: "embedded" | "daemon";
  private readonly manager: MemoryManager;
  private readonly lifecycleOwners: ReadonlySet<string>;
  private readonly observationSink = new ObservationSink();
  private readonly operational: OperationalMemoryApi | null;
  readonly ledger: AbmindRequestLedger | null;
  private closed = false;
  private inFlight_ = 0;
  private requestCount_ = 0;
  private startTime = Date.now();
  private readonly sleepCoordinator: SleepCoordinator | null;
  private readonly buildCommit_: string | null;
  private readonly releaseId_: string | null;
  private compactionService: ContextCompactionService | null = null;
  private traceSeq = 0;

  /**
   * #1659: content-free in-process mutation ownership. Registered before the
   * first dispatch await so concurrent same-key requests join one dispatch.
   * Keyed by an unambiguous encoding of (principalId, idempotencyKey).
   */
  private readonly inFlightMutations = new Map<string, InFlightMutation>();

  constructor(config: AbmindServiceConfig) {
    this.serverInstanceId = config.serverInstanceId;
    this.mode_ = config.mode;
    this.manager = config.manager;
    this.operational = config.operational;
    this.ledger = config.requestLedgerDb ? new AbmindRequestLedger(config.requestLedgerDb) : null;
    this.sleepCoordinator = config.sleepCoordinator ?? null;
    this.lifecycleOwners = new Set(config.lifecycleWriteOwners ?? []);
    this.buildCommit_ = config.buildCommit ?? null;
    this.releaseId_ = config.releaseId ?? null;
  }

  close(): void {
    this.closed = true;
  }

  get mode(): "embedded" | "daemon" { return this.mode_; }
  get requestCount(): number { return this.requestCount_; }
  get isClosed(): boolean { return this.closed; }
  get inFlight(): number { return this.inFlight_; }

  async drain(timeoutMs = 30_000): Promise<DrainResult> {
    const start = Date.now();
    while (this.inFlight_ > 0 && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 50));
    }
    return { drained: this.inFlight_ === 0, remainingInFlight: this.inFlight_ };
  }

  async handle<K extends AbmindMethod>(
    request: AbmindRequestV1<K>,
    context: ServiceCallContext,
  ): Promise<AbmindResponseV1<K>> {
    if (this.closed) return this.err(request.requestId, "unavailable", "Service is closed");

    const parseResult = parseEnvelope(request);
    if (!parseResult.ok) return this.err(request.requestId, parseResult.code, parseResult.message);

    const { method, payload } = parseResult;
    const mutationRequest = isMutatingMethod(method);
    if (mutationRequest) {
      this.traceAccepted(request.requestId, method, request.idempotencyKey);
    }

    const startedAt = Date.now();
    let response: AbmindResponseV1<K>;
    try {
      response = await this.handleParsed(request, method, payload, context);
    } catch (err) {
      // Keep the service boundary typed even when an unexpected dependency or
      // ledger failure escapes a method handler. A mutation cannot claim that
      // it was safely rejected once it has passed envelope admission.
      response = mutationRequest
        ? this.err(request.requestId, "outcome_unknown", `Dispatch outcome unknown: ${AbmindService.boundedErrorDetail(err)}`, undefined, "response")
        : this.err(request.requestId, "unavailable", `Dispatch error: ${AbmindService.boundedErrorDetail(err)}`, undefined, "response");
    }
    if (mutationRequest) {
      this.traceCompleted(request.requestId, method, request.idempotencyKey, response, Date.now() - startedAt);
    }
    return response;
  }

  private async handleParsed<K extends AbmindMethod>(
    request: AbmindRequestV1<K>,
    method: K,
    payload: AbmindMethodMap[K]["input"],
    context: ServiceCallContext,
  ): Promise<AbmindResponseV1<K>> {
    const entry: MethodEntry<K> = METHOD_REGISTRY[method];
    const authResult = this.authorize(entry, context, method);
    if (!authResult) {
      return this.err(request.requestId, "unauthorized", `Domain not granted: ${entry.domain}`);
    }

    if (entry.domain === "private") {
      const userIdResult = this.resolveUserId(context, payload);
      if (!userIdResult.ok) {
        return this.err(request.requestId, "unauthorized", "Principal not authorized for private memory");
      }
    }

    const payloadError = validatePayload(method, payload);
    if (payloadError) {
      return this.err(request.requestId, "validation_error", payloadError);
    }

    if (method === "private.recordFeedback") {
      const feedback = payload as { userId: string; memoryId: number };
      if (!this.manager.hasExtractedMemoryForUser(feedback.memoryId, feedback.userId)) {
        return this.err(request.requestId, "unauthorized", "Memory does not belong to the authenticated user");
      }
    }

    if (entry.safety === "unavailable") {
      return this.err(request.requestId, "unavailable", "Private mutation is not available under the active contract");
    }
    if (entry.safety && entry.safety !== "atomic-counter" && !CAS_WRITE_ENABLED) {
      return this.err(request.requestId, "unavailable", "Private mutation requires #1449 safety enforcement which is not yet available");
    }

    this.inFlight_++;
    try {
      if (entry.mutation === "read") {
        return await this.dispatchRead(request.requestId, method, payload, context);
      }

      if (!request.idempotencyKey) {
        return this.err(request.requestId, "validation_error", "Idempotency key required for mutating method");
      }

      if (!this.ledger) {
        return this.err(request.requestId, "unavailable", "Request ledger not available");
      }

      return await this.dispatchWithIdempotency(request.requestId, method, payload, context, request.idempotencyKey);
    } finally {
      this.inFlight_--;
    }
  }

  /**
   * #1659: bounded accepted-event for mutating requests, emitted after
   * envelope validation and before authorization. Never logs payloads,
   * principal IDs, or raw idempotency keys. #1837: TRACE-gated — COMPLETED
   * stays at low so ordinary operation costs one line per request.
   */
  private traceAccepted(requestId: string, method: AbmindMethod, idempotencyKey?: string): void {
    this.traceSeq++;
    const keyFp = idempotencyKey ? fingerprint(idempotencyKey, 8) : "-";
    logTrace("request-trace", `[ACCEPTED] seq=${this.traceSeq} requestId=${requestId} method=${method} key=${keyFp}`);
  }

  /**
   * #1659: bounded completed-event for every mutation exit, including
   * authorization/validation refusals. Correlates with the accepted event by
   * request ID and method.
   */
  private traceCompleted<K extends AbmindMethod>(
    requestId: string,
    method: AbmindMethod,
    idempotencyKey: string | undefined,
    response: AbmindResponseV1<K>,
    durationMs: number,
  ): void {
    this.traceSeq++;
    const keyFp = idempotencyKey ? fingerprint(idempotencyKey, 8) : "-";
    const outcome = response.ok ? "ok" : response.error.code;
    const stage = response.ok ? "dispatch" : response.error.stage;
    logInfo("request-trace", `[COMPLETED] seq=${this.traceSeq} requestId=${requestId} method=${method} key=${keyFp} outcome=${outcome} stage=${stage} duration=${durationMs}ms`);
  }

  private authorize<K extends AbmindMethod>(
    entry: MethodEntry<K>,
    context: ServiceCallContext,
    method?: K,
  ): boolean {
    if (!context.grantedDomains.has(entry.domain)) return false;
    if (context.allowedMethods && method && !context.allowedMethods.has(method)) return false;
    return !entry.capability || context.capabilities?.has(entry.capability) === true;
  }

  private resolveUserId(context: ServiceCallContext, payload: unknown): { ok: boolean } {
    if (!context.grantedDomains.has("private")) return { ok: false };
    const p = payload as Record<string, unknown> | null | undefined;
    if (!p || typeof p !== "object") return { ok: true };
    if ("userId" in p && (typeof p.userId !== "string" || (p.userId !== context.principalId && context.allowPrivateDelegation !== true))) {
      return { ok: false };
    }
    // #1383: lifecycle payloads carry identity instead of userId. The
    // principal must match the authenticated transport principal; the
    // lifecycle service additionally validates shape and write ownership.
    if ("identity" in p && typeof p.identity === "object" && p.identity !== null) {
      const pid = (p.identity as Record<string, unknown>).principalId;
      if (typeof pid !== "string" || (pid !== context.principalId && context.allowPrivateDelegation !== true)) {
        return { ok: false };
      }
    }
    return { ok: true };
  }

  private async dispatchRead<K extends AbmindMethod>(
    requestId: string,
    method: K,
    payload: AbmindMethodMap[K]["input"],
    context?: ServiceCallContext,
  ): Promise<AbmindResponseV1<K>> {
    this.requestCount_++;
    try {
      const result = await this.doDispatch(method, payload, context);
      const serialized = JSON.stringify(result) ?? "null";
      if (serialized.length > RESPONSE_MAX_BYTES) {
        return this.err(requestId, "validation_error", "Response exceeds maximum size");
      }
      return { ok: true, requestId, serverInstanceId: this.serverInstanceId, result } as AbmindResponseV1<K>;
    } catch (err) {
      if (err instanceof AbmindService.PrivateMutationError) {
        return { ok: false, requestId, error: err.errorBody } as AbmindResponseV1<K>;
      }
      return this.err(requestId, "unavailable", `Dispatch error: ${AbmindService.boundedErrorDetail(err)}`);
    }
  }

  private async dispatchWithIdempotency<K extends AbmindMethod>(
    requestId: string,
    method: K,
    payload: AbmindMethodMap[K]["input"],
    context: ServiceCallContext,
    idempotencyKey: string,
  ): Promise<AbmindResponseV1<K>> {
    const hash = canonicalPayloadHash(ABMIND_PROTOCOL_VERSION, method, payload);
    const mapKey = this.mutationMapKey(context.principalId, idempotencyKey);

    const reservation = this.ledger!.reserve(context.principalId, idempotencyKey, method, hash);
    if (reservation.status === "completed") {
      if (!this.authorize(METHOD_REGISTRY[method], context, method)) {
        return this.err(requestId, "unauthorized", "Authorization changed since original request");
      }
      // The cached response contains the original request ID. A replay is a
      // new transport request and must be routable to its new caller.
      const replay = JSON.parse(reservation.responseJson!) as AbmindResponseV1<K>;
      return { ...replay, requestId } as AbmindResponseV1<K>;
    }
    if (reservation.status === "conflict") {
      return this.err(requestId, "idempotency_conflict", reservation.message!);
    }
    if (reservation.status === "outcome_unknown") {
      // A prior dispatch of this key may have committed; the outcome is not
      // reconcilable here, so the key must never be retried under a new id.
      return this.err(requestId, "outcome_unknown", "Previous request outcome is unknown; cannot retry", undefined, "response");
    }
    if (reservation.status === "in_flight") {
      const live = this.inFlightMutations.get(mapKey);
      if (live && live.method === method && live.payloadHash === hash) {
        // A live in-process replay awaits the original shared dispatch; it
        // must not execute a second mutation or report a premature unknown.
        const original = await live.outcome;
        return { ...original, requestId } as AbmindResponseV1<K>;
      }
      // The ledger claims live same-process work, but no owner exists in this
      // process: fail closed — never start a replacement dispatch.
      return this.err(requestId, "outcome_unknown", "A dispatch for this key is in flight without an owner; outcome unknown", undefined, "response");
    }

    // reserved: register the shared dispatch promise BEFORE any await so a
    // concurrent same-key request joins it instead of dispatching twice.
    let settleShared!: (response: AbmindResponseV1<K>) => void;
    const sharedOutcome = new Promise<AbmindResponseV1<K>>((resolve) => { settleShared = resolve; });
    this.inFlightMutations.set(mapKey, { method, payloadHash: hash, outcome: sharedOutcome as Promise<AbmindResponseV1> });

    let response: AbmindResponseV1<K>;
    try {
      if (!this.ledger!.markStarted(context.principalId, idempotencyKey)) {
        response = this.err(requestId, "outcome_unknown", "Could not durably claim mutation dispatch", undefined, "response");
      } else {
        response = await this.dispatchMutation(requestId, method, payload, context);
      }
    } catch (err) {
      response = this.err(requestId, "outcome_unknown", `Dispatch outcome unknown: ${AbmindService.boundedErrorDetail(err)}`, undefined, "response");
    }

    try {
      // A durable outcome_unknown stays a tombstone; only typed outcomes are
      // completed (and therefore cleanable) responses.
      if (!response.ok && response.error.code === "outcome_unknown") {
        this.ledger!.markUnknown(context.principalId, idempotencyKey);
      } else if (!this.ledger!.complete(context.principalId, idempotencyKey, JSON.stringify(response))) {
        // A late completion must never turn a crash-recovered tombstone back
        // into an executable/completed row. If durable completion is lost,
        // report uncertainty and retain the key as a tombstone when possible.
        response = this.err(requestId, "outcome_unknown", "Mutation outcome could not be durably recorded", undefined, "response");
        this.ledger!.markUnknown(context.principalId, idempotencyKey);
      }
    } catch (err) {
      response = this.err(requestId, "outcome_unknown", `Mutation outcome could not be durably recorded: ${AbmindService.boundedErrorDetail(err)}`, undefined, "response");
      try { this.ledger!.markUnknown(context.principalId, idempotencyKey); } catch { /* startup recovery preserves the row */ }
    } finally {
      // Release the shared ownership only after durable completion/unknown
      // marking — never before.
      settleShared(response);
      this.inFlightMutations.delete(mapKey);
    }
    return response;
  }

  private mutationMapKey(principalId: string, idempotencyKey: string): string {
    return `${String(principalId.length)}:${principalId}:${String(idempotencyKey.length)}:${idempotencyKey}`;
  }

  /** Compatibility alias: the class moved to abmind-memory-dispatch.ts (#1695). */
  static readonly PrivateMutationError = PrivateMutationErrorImpl;

  private async dispatchMutation<K extends AbmindMethod>(
    requestId: string,
    method: K,
    payload: AbmindMethodMap[K]["input"],
    context?: ServiceCallContext,
  ): Promise<AbmindResponseV1<K>> {
    this.requestCount_++;
    try {
      const result = await this.doDispatch(method, payload, context);
      const resultObj = result as Record<string, unknown>;
      if (resultObj && resultObj["_error"]) {
        return { ok: false, requestId, error: resultObj["_error"] as AbmindErrorBodyV1 } as AbmindResponseV1<K>;
      }
      const serialized = JSON.stringify(result) ?? "null";
      if (serialized.length > RESPONSE_MAX_BYTES) {
        return this.err(requestId, "validation_error", "Response exceeds maximum size");
      }
      return { ok: true, requestId, serverInstanceId: this.serverInstanceId, result } as AbmindResponseV1<K>;
    } catch (err) {
      if (err instanceof AbmindService.PrivateMutationError) {
        return { ok: false, requestId, error: err.errorBody } as AbmindResponseV1<K>;
      }
      // The mutation may have been accepted but its response lost: a generic
      // post-dispatch exception is never claimed safe to retry. The detail is
      // bounded — it is persisted and replayed to every later caller.
      return this.err(requestId, "outcome_unknown", `Dispatch outcome unknown: ${AbmindService.boundedErrorDetail(err)}`, undefined, "response");
    }
  }

  /** Bounded, never-unbounded error detail for persisted/replayed responses. */
  private static boundedErrorDetail(err: unknown): string {
    if (err instanceof Error && err.message) return err.message.slice(0, 200);
    return "no detail";
  }

  private async doDispatch<K extends AbmindMethod>(
    method: K,
    payload: AbmindMethodMap[K]["input"],
    context?: ServiceCallContext,
  ): Promise<AbmindMethodMap[K]["output"]> {
    // #1885: single generic table lookup replaces the per-method switch.
    // Coverage of all 58 methods is compiler-enforced by the partition
    // assertions above; the service keeps no per-method knowledge or casts.
    const deps: ServiceDispatchDeps = {
      manager: this.manager,
      context,
      lifecycleOwners: this.lifecycleOwners,
      observationSink: this.observationSink,
      operational: this.operational,
      sleepCoordinator: this.sleepCoordinator,
      serviceInfo: () => this.serviceInfo(),
      getCompactionService: (db) => this.getCompactionService(db),
    };
    const table: {
      [M in AbmindMethod]: (
        tableDeps: ServiceDispatchDeps,
        input: AbmindMethodMap[M]["input"],
      ) => Promise<AbmindMethodMap[M]["output"]> | AbmindMethodMap[M]["output"];
    } = { ...MEMORY_HANDLERS, ...OPS_HANDLERS };
    return await table[method](deps, payload);
  }

  /** Point-in-time snapshot for the system handlers (plain data, no manager). */
  private serviceInfo(): ServiceInfo {
    return {
      mode: this.mode_,
      serverInstanceId: this.serverInstanceId,
      operationalAvailable: this.operational !== null,
      memoryEnabled: this.manager.getConfig().memoryEnabled,
      buildCommit: this.buildCommit_,
      releaseId: this.releaseId_,
      startTime: this.startTime,
      requestCount: this.requestCount_,
    };
  }

  private getCompactionService(db: Database.Database): ContextCompactionService {
    if (!this.compactionService) {
      this.compactionService = new ContextCompactionService(db);
    }
    return this.compactionService;
  }

  private err<K extends AbmindMethod>(
    requestId: string,
    code: AbmindErrorBodyV1["code"],
    message: string,
    current?: AbmindCurrentV1,
    stage: AbmindFailureStageV1 = "pre_dispatch",
  ): AbmindResponseV1<K> {
    return { ok: false, requestId, error: errorBodyV1(code, message, stage, current) } as AbmindResponseV1<K>;
  }
}
