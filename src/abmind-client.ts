import type {
  AbmindMethod, AbmindMethodMap, AbmindTransport, AbmindCapabilitiesV1, AbmindErrorBodyV1, AbmindErrorCodeV1,
  AbmindFailureActionV1, AbmindFailureStageV1, AbmindCurrentV1,
} from "./abmind-protocol.js";
import { ABMIND_PROTOCOL_VERSION, ERROR_MESSAGE_MAX, REQUEST_ID_MAX, errorContract, isIdempotencyRequired } from "./abmind-protocol.js";
import { redactSecrets } from "./redact-secrets.js";
import type { OperationalMemoryApi } from "./imemory-system.js";
import type {
  OperationalDraft, OperationalMemoryProjection,
  OperationalResult, DraftListQuery,
  OperationalRecallQuery, SubmitOperationalDraftInput, PromoteDraftInput,
  RejectDraftInput, ReviseOperationalMemoryInput, RetireOperationalMemoryInput,
} from "./operational-memory-types.js";
import type {
  InstantStoreParams, InstantStoreResult,
  EditPrivateMemoryInputV1, ReclassifyPrivateMemoryInputV1,
  AdjustPrivateRelevanceInputV1, MergePrivateMemoriesInputV1,
  PrivateMutationStatusV1,
  CascadeDeletePrivateMessagesInputV1, CascadeDeleteResultV1,
} from "./mem-types.js";
import type { RecallParams, RecallResult, WorthRetrievingParams, WorthRetrievingResult } from "./recall-engine.js";
import type {
  StartSessionInput, StartSessionResult, PrepareTurnInput, PrepareTurnResult,
  CompleteTurnInput, CompleteTurnResult, ExplicitRecallInput, RecallOperationResult,
  ExplicitStoreInput, CheckpointInput, CheckpointResult,
} from "./host-integration/types.js";
import type { ObservationInput, ObservationReceipt } from "./host-integration/observations.js";
import type { FindSealedSecretsInput, ResolveSealedSecretInput, ResolveSealedSecretResult, SealedSecretRefV1 } from "./sealed-secret-service.js";
import type { DreamQuestionStatus, DreamQuestionWireProjection } from "./dream-question-store.js";
import type { DoctorCheckResult, DoctorRepairAction, DoctorRepairResult } from "./abmind-protocol.js";
import type { AbmindRouteSnapshotV1 } from "./remote/route-contract.js";

let idemCounter = 0;
function idempotencyKeyFor(method: string, _payload: unknown): string {
  idemCounter++;
  return `idem-${method}-${Date.now()}-${idemCounter}`;
}

export interface AbmindSystemApi {
  negotiate(): Promise<AbmindCapabilitiesV1>;
  health(): Promise<{ status: string; uptimeMs: number; memoryEnabled: boolean }>;
  status(): Promise<{ version: string; buildCommit: string | null; releaseId: string | null; mode: string; instanceId: string; pid: number; databaseSizeBytes: number; operationalDbSizeBytes: number; uptimeMs: number; requestCount: number }>;
  capabilities(): Promise<Record<string, string>>;
}

/** Operational API with an optional caller-supplied key for exact retries. */
export type AbmindOperationalApi = Omit<OperationalMemoryApi, "submitDraft" | "promoteDraft" | "rejectDraft" | "revise" | "retire"> & {
  submitDraft(input: SubmitOperationalDraftInput, idempotencyKey?: string): Promise<OperationalResult<OperationalDraft>>;
  promoteDraft(input: PromoteDraftInput, idempotencyKey?: string): Promise<OperationalResult<OperationalMemoryProjection>>;
  rejectDraft(input: RejectDraftInput, idempotencyKey?: string): Promise<OperationalResult<OperationalDraft>>;
  revise(input: ReviseOperationalMemoryInput, idempotencyKey?: string): Promise<OperationalResult<OperationalMemoryProjection>>;
  retire(input: RetireOperationalMemoryInput, idempotencyKey?: string): Promise<OperationalResult<OperationalMemoryProjection>>;
};

export interface AbmindPrivateMemoryApi {
  instantStore(params: InstantStoreParams, idempotencyKey?: string): Promise<InstantStoreResult>;
  editMemory(params: EditPrivateMemoryInputV1, idempotencyKey?: string): Promise<PrivateMutationStatusV1>;
  reclassifyMemory(params: ReclassifyPrivateMemoryInputV1, idempotencyKey?: string): Promise<PrivateMutationStatusV1>;
  adjustRelevance(params: AdjustPrivateRelevanceInputV1, idempotencyKey?: string): Promise<PrivateMutationStatusV1>;
  mergeMemories(params: MergePrivateMemoriesInputV1, idempotencyKey?: string): Promise<PrivateMutationStatusV1>;
  cascadeDelete(input: CascadeDeletePrivateMessagesInputV1, idempotencyKey?: string): Promise<CascadeDeleteResultV1>;
  recall(params: RecallParams): Promise<RecallResult>;
  /** #1894 — cheap worth-retrieving verdict; absent on mixed-version daemons. */
  checkWorthRetrieving(params: WorthRetrievingParams): Promise<WorthRetrievingResult>;
  /** #1813 — advisory post-response attribution; null when unsupported. */
  attribution(params: import("./recall-attribution.js").AttributionInputV1): Promise<import("./recall-attribution.js").AttributionResultV1 | null>;
  rebuildFtsIndexes(): Promise<{ rebuilt: string[] }>;
  embed(input: { texts: string[] }): Promise<{ vectors: Array<number[] | null>; model: string }>;
  // #1660: owner-only sealed label search and local-only plaintext resolution.
  findSealedSecrets(input: FindSealedSecretsInput): Promise<SealedSecretRefV1[]>;
  resolveSealedSecret(input: ResolveSealedSecretInput): Promise<ResolveSealedSecretResult>;
  recordMessage(input: { userId: string; sessionId: string; role: string; content: string; timestamp: number; platformMessageId?: number | string; emotionScore?: number; typeHint?: string; topicHint?: string; emotionHint?: string }, idempotencyKey?: string): Promise<{ id: number | null }>;
  getRecentConversation(input: { userId: string; since: number; limit: number }): Promise<Array<{ role: string; content: string; timestamp: number }>>;
  assembleSessionContext(input: { userId: string; modelContextTokens?: number; wakeUpMaxChars?: number; includeHistory?: boolean }): Promise<{
    wakeUp: string; recall: string; coreKnowledge: string;
    soulBundle: { soul: string; profile: string; notes: string; memoryTools: string; coreFacts: string };
    // #1869 — present on new daemons, absent on older ones (additive contract).
    parts?: { soul: string; profile: string; notes: string; memoryTools: string; coreFacts: string };
  }>;
  getRuntimeStatus(input?: { userId?: string }): Promise<any>;
  getCoreKnowledge(input: { userId: string }): Promise<string>;
  recordFeedback(input: { userId: string; memoryId: number; feedbackType: "cite" | "reject" }, idempotencyKey?: string): Promise<void>;
  projectConversationContext(input: { userId: string; sessionId: string; beforeMessageId: number; maxContext: number }): Promise<{
    version: 1;
    messages: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
    estimatedTokens: number;
    prunedToolResults: number;
    sourceMessageCount: number;
  }>;
  // #1406: owner-scoped durable conversation compaction.
  prepareConversationCompaction(input: {
    userId: string; sessionId: string; beforeMessageId?: number;
    maxHistoryTokens: number; minRecentTokens: number; reason: "manual" | "automatic";
  }): Promise<{
    status: "nothing_to_compact" | "busy" | "ready";
    candidate?: {
      version: 1; expectedGeneration: number; previousCheckpointId: number | null;
      sourceMessageStart: number; sourceMessageEnd: number; firstKeptMessageId: number;
      sourceDigest: string; sourceTokenCount: number; serializedTurns: string;
      priorCheckpoint: string; summaryTokenBudget: number;
    };
  }>;
  commitConversationCompaction(input: {
    userId: string; sessionId: string;
    candidate: Omit<{
      version: 1; expectedGeneration: number; previousCheckpointId: number | null;
      sourceMessageStart: number; sourceMessageEnd: number; firstKeptMessageId: number;
      sourceDigest: string; sourceTokenCount: number;
    }, "serializedTurns" | "priorCheckpoint" | "summaryTokenBudget">;
    summary: string; summaryTokenCount: number;
    summarizer: { provider: string | null; model: string | null };
    activeRequestModel: string | null; reason: "manual" | "automatic";
    customInstructionsDigest?: string;
  }, idempotencyKey?: string): Promise<{
    status: "committed"; checkpointId: number; generation: number;
  } | { status: "stale" } | { status: "rejected" }>;
  // #1515: owner-scoped durable Dreamy clarification questions.
  dreamQuestions: {
    nextPending(userId: string): Promise<DreamQuestionWireProjection | null>;
    list(userId: string, status?: DreamQuestionStatus, limit?: number): Promise<{ questions: DreamQuestionWireProjection[] }>;
    markAsked(input: { userId: string; questionId: string; deliveryKey: string }, idempotencyKey?: string): Promise<{ status: "asked" | "not_found" | "conflict" }>;
    dismiss(input: { userId: string; questionId: string }, idempotencyKey?: string): Promise<{ status: "dismissed" | "not_found" | "already_terminal" }>;
  };
}

export type MergeResult = { merged: true; keptId: number; deletedId: number } | { merged: false; error: string };

/**
 * #1659: typed protocol failure raised by AbmindClient for any non-ok
 * response. Preserves the full structural failure contract — callers must
 * never derive retry safety from message text.
 */
export class AbmindClientError extends Error {
  readonly code: AbmindErrorCodeV1;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly action: AbmindFailureActionV1;
  readonly stage: AbmindFailureStageV1;
  readonly current?: AbmindCurrentV1;

  constructor(body: AbmindErrorBodyV1, requestId: string) {
    // The local service emits the complete contract, but signed/older peers
    // may return a transport error with only {code,message}. Normalize that
    // untrusted boundary so callers never receive undefined retry metadata or
    // an unbounded/secret-bearing message.
    const raw = (body ?? {}) as Partial<AbmindErrorBodyV1>;
    const code = typeof raw.code === "string" ? raw.code as AbmindErrorCodeV1 : "unavailable";
    const contract = errorContract(code);
    const rawMessage = typeof raw.message === "string" ? raw.message : "Request failed";
    const redacted = redactSecrets(rawMessage);
    const message = redacted.length <= ERROR_MESSAGE_MAX
      ? redacted
      : `${redacted.slice(0, ERROR_MESSAGE_MAX - 3)}...`;
    super(message);
    this.name = "AbmindClientError";
    this.code = code;
    this.requestId = typeof requestId === "string" ? requestId.slice(0, REQUEST_ID_MAX) : "";
    this.retryable = typeof raw.retryable === "boolean" ? raw.retryable : contract.retryable;
    this.action = raw.action === "fix_input" || raw.action === "re_recall" || raw.action === "retry"
      || raw.action === "reconcile" || raw.action === "stop"
      ? raw.action
      : contract.action;
    this.stage = raw.stage === "pre_dispatch" || raw.stage === "dispatch" || raw.stage === "response"
      ? raw.stage
      : code === "outcome_unknown" ? "response" : "pre_dispatch";
    this.current = raw.current;
  }
}

export interface AbmindOperatorApi {
  diagnose(): Promise<{ checks: DoctorCheckResult[] }>;
  repair(action: DoctorRepairAction, idempotencyKey?: string): Promise<DoctorRepairResult>;
}

export interface AbmindLifecycleApi {
  startSession(params: StartSessionInput): Promise<StartSessionResult>;
  prepareTurn(params: PrepareTurnInput): Promise<PrepareTurnResult>;
  completeTurn(params: CompleteTurnInput, idempotencyKey?: string): Promise<CompleteTurnResult>;
  recall(params: ExplicitRecallInput): Promise<RecallOperationResult>;
  store(params: ExplicitStoreInput, idempotencyKey?: string): Promise<InstantStoreResult>;
  checkpoint(params: CheckpointInput, idempotencyKey?: string): Promise<CheckpointResult>;
  observe(params: ObservationInput): Promise<ObservationReceipt>;
}

export interface AbmindSleepApi {
  start(mode: "scheduled" | "manual", level?: string, fresh?: boolean, idempotencyKey?: string): Promise<{ status: "accepted" | "already_running" | "unavailable"; runId?: string; reason?: string }>;
  status(): Promise<{ state: "idle" | "running" | "terminal" | "interrupted"; active?: { runId: string; mode: string; startedAt: number; step?: string; percent: number }; last?: { runId?: string; attemptedAt: number; finishedAt?: number; status: string; report?: string; resumable: boolean; completedSteps: number; failedSteps: number } }>;
  resume(runId?: string, level?: string, idempotencyKey?: string): Promise<{ status: "accepted" | "not_found" | "not_resumable" | "already_running" | "unavailable"; runId?: string; reason?: string }>;
  cancel(runId: string, idempotencyKey?: string): Promise<{ status: "cancelling" | "already_terminal" | "not_found" | "unavailable" }>;
  events(afterSeq: number, limit?: number, waitMs?: number): Promise<{ runId: string; events: Array<{ seq: number; at: number; event: { type: string; detail?: string } }>; nextSeq: number; gap: boolean; terminal: boolean }>;
  runtime: {
    open(providerInstanceId: string, idempotencyKey?: string, capabilities?: { proposalOnly?: boolean }): Promise<{ status: "ok" | "already_open" | "unavailable"; leaseId?: string; expiresAt?: number }>;
    next(leaseId: string, waitMs?: number): Promise<{ status: "ok" | "lease_expired" | "no_request" | "closed"; completionRequest?: { completionId: string; runId: string; stepId: string; prompt: string; deadline: number; proposalOnly?: boolean }; heartbeat?: true }>;
    complete(leaseId: string, completionId: string, text: string, idempotencyKey?: string): Promise<{ status: "ok" | "invalid_lease" | "invalid_completion" | "run_terminal" }>;
    fail(leaseId: string, completionId: string, code: string, failure?: { cause: string; detail?: string; commandFingerprint?: string }, idempotencyKey?: string): Promise<{ status: "ok" | "invalid_lease" | "invalid_completion" | "run_terminal" }>;
    close(leaseId: string, idempotencyKey?: string): Promise<{ status: "ok" | "not_found" }>;
  };
}

export class AbmindClient {
  private transport: AbmindTransport;
  private capabilities_: AbmindCapabilitiesV1 | null = null;

  readonly system: AbmindSystemApi;
  readonly privateMemory: AbmindPrivateMemoryApi;
  readonly operational: AbmindOperationalApi;
  readonly operator: AbmindOperatorApi;
  readonly sleep: AbmindSleepApi;
  readonly lifecycle: AbmindLifecycleApi;

  constructor(transport: AbmindTransport) {
    this.transport = transport;

    this.system = {
      negotiate: () => this.call("system.negotiate", {}),
      health: () => this.call("system.health", {}),
      status: () => this.call("system.status", {}),
      capabilities: () => this.call("system.capabilities", {}),
    };

    this.privateMemory = {
      instantStore: (p, key) => this.call("private.instantStore", p, key),
      editMemory: (p, key) => this.callPrivateMutation("private.edit", p, key),
      reclassifyMemory: (p, key) => this.callPrivateMutation("private.reclassify", p, key),
      adjustRelevance: (p, key) => this.callPrivateMutation("private.adjustRelevance", p, key),
      mergeMemories: (p, key) => this.callPrivateMutation("private.merge", p, key),
      cascadeDelete: (input, key) => this.call("private.cascadeDelete", input, key),
      recall: (p) => this.call("private.recall", p),
      checkWorthRetrieving: (p) => this.call("private.checkWorthRetrieving", p),
      attribution: (p) => this.call("private.attribution", p),
      rebuildFtsIndexes: () => this.call("private.rebuildFts", {}),
      embed: (p) => this.call("private.embed", p),
      findSealedSecrets: (p) => this.call("private.findSealedSecrets", p),
      resolveSealedSecret: (p) => this.call("private.resolveSealedSecret", p),
      recordMessage: (p, key) => this.call("private.recordMessage", p, key),
      getRecentConversation: (p) => this.call("private.getRecentConversation", p),
      assembleSessionContext: (p) => this.call("private.assembleSessionContext", p),
      getRuntimeStatus: (p) => this.call("private.getRuntimeStatus", p ?? {}),
      getCoreKnowledge: (p) => this.call("private.getCoreKnowledge", p),
      recordFeedback: (p, key) => this.call("private.recordFeedback", p, key),
      projectConversationContext: (p) => this.call("private.projectConversationContext", p),
      prepareConversationCompaction: (p) => this.call("private.prepareConversationCompaction", p),
      commitConversationCompaction: (p, key) => this.call("private.commitConversationCompaction", p, key),
      dreamQuestions: {
        nextPending: (userId) => this.call("private.dreamQuestions.nextPending", { userId }),
        list: (userId, status, limit) => this.call("private.dreamQuestions.list", { userId, status, limit }),
        markAsked: (p, key) => this.call("private.dreamQuestions.markAsked", p, key),
        dismiss: (p, key) => this.call("private.dreamQuestions.dismiss", p, key),
      },
    };

    this.operational = {
      submitDraft: (i, key) => this.call("operational.submitDraft", i, key),
      listDrafts: (q) => this.call("operational.listDrafts", q),
      getMemory: (memoryId) => this.call("operational.getMemory", { memoryId }),
      getHistory: (memoryId, page) => this.call("operational.getHistory", { memoryId, page }),
      promoteDraft: (i, key) => this.call("operational.promoteDraft", i, key),
      rejectDraft: (i, key) => this.call("operational.rejectDraft", i, key),
      revise: (i, key) => this.call("operational.revise", i, key),
      retire: (i, key) => this.call("operational.retire", i, key),
      recall: (q) => this.call("operational.recall", q),
    };

    this.operator = {
      diagnose: () => this.call("operator.diagnose", {}),
      repair: (action, key) => this.call("operator.repair", { action }, key),
    };

    this.lifecycle = {
      startSession: (p) => this.call("private.lifecycleStartSession", p),
      prepareTurn: (p) => this.call("private.lifecyclePrepareTurn", p),
      completeTurn: (p, key) => this.call("private.lifecycleCompleteTurn", p, key),
      recall: (p) => this.call("private.lifecycleRecall", p),
      store: (p, key) => this.call("private.lifecycleStore", p, key),
      checkpoint: (p, key) => this.call("private.lifecycleCheckpoint", p, key),
      observe: (p) => this.call("private.lifecycleObserve", p),
    };
    this.sleep = {
      start: (m, l, f, key) => this.call("sleep.start", { mode: m, level: l, fresh: f }, key),
      status: () => this.call("sleep.status", {}),
      resume: (runId, level, key) => this.call("sleep.resume", { runId, level }, key),
      cancel: (runId, key) => this.call("sleep.cancel", { runId }, key),
      events: (afterSeq, limit, waitMs) => this.call("sleep.events", { afterSeq, limit, waitMs }),
      runtime: {
        open: (id, key, capabilities) => this.call("sleep.runtime.open", { providerInstanceId: id, ...(capabilities?.proposalOnly === true ? { capabilities: { proposalOnly: true } } : {}) }, key),
        next: (leaseId, waitMs) => this.call("sleep.runtime.next", { leaseId, waitMs }),
        complete: (leaseId: string, completionId: string, text: string, outcomeOrKey?: string, key?: string): Promise<{ status: "ok" | "invalid_lease" | "invalid_completion" | "run_terminal" }> => {
          let outcome: string | undefined;
          let actualKey: string | undefined;
          if (outcomeOrKey && ["text", "reaction", "no_reply", "empty"].includes(outcomeOrKey)) {
            outcome = outcomeOrKey;
            actualKey = key;
          } else {
            actualKey = outcomeOrKey;
          }
          return this.call(
            "sleep.runtime.complete",
            outcome === undefined ? { leaseId, completionId, text } : { leaseId, completionId, text, outcome },
            actualKey,
          );
        },
        fail: (leaseId, completionId, code, failure, key) => {
          // Support legacy 4-arg fail(leaseId, completionId, code, key) and new 5-arg with failure object
          if (typeof failure === "string" && key === undefined) {
            return this.call("sleep.runtime.fail", { leaseId, completionId, code }, failure);
          }
          return this.call(
            "sleep.runtime.fail",
            failure !== undefined && typeof failure === "object"
              ? { leaseId, completionId, code, failure }
              : { leaseId, completionId, code },
            key as string | undefined,
          );
        },
        close: (leaseId, key) => this.call("sleep.runtime.close", { leaseId }, key),
      },
    };
  }

  get capabilities(): AbmindCapabilitiesV1 | null {
    // A transport that owns a route state machine (signed WSS) reflects
    // route loss immediately; local transports keep the negotiated cache.
    const transport = this.transport as { capabilities?: AbmindCapabilitiesV1 | null };
    if ("capabilities" in transport && transport.capabilities !== undefined) {
      return transport.capabilities;
    }
    return this.capabilities_;
  }

  /**
   * Bounded route snapshot for diagnostics. Transport-provided where the
   * transport owns a route state machine (signed WSS); otherwise a stable
   * local projection of the current negotiation state.
   */
  get routeSnapshot(): AbmindRouteSnapshotV1 {
    const transport = this.transport as { routeSnapshot?: AbmindRouteSnapshotV1 | (() => AbmindRouteSnapshotV1) };
    if (transport && transport.routeSnapshot !== undefined) {
      const snap = typeof transport.routeSnapshot === "function" ? transport.routeSnapshot() : transport.routeSnapshot;
      if (snap) return snap;
    }
    return this.capabilities_
      ? { version: 1, state: "ready", generation: 1, retryEligible: 0, terminalUnknown: 0 }
      : { version: 1, state: "disconnected", generation: 0, retryEligible: 0, terminalUnknown: 0 };
  }

  async negotiate(): Promise<AbmindCapabilitiesV1> {
    this.capabilities_ = await this.transport.negotiate();
    return this.capabilities_;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /** Public raw-call method — lets callers supply their own idempotency key for retry. */
  async callRaw<T>(method: string, payload: unknown, idempotencyKey?: string): Promise<T> {
    // The single site where a method string is not statically checked:
    // client-bridge/server.ts forwards runtime method strings after a
    // METHOD_REGISTRY membership check, and negative tests send arbitrary
    // strings. Everything else goes through the typed call<K> below.
    return this.callTransport<T>(method, payload, idempotencyKey);
  }

  /**
   * Private semantic mutations expose their bounded failure contract as
   * AbmindClientError (same as every other method). The full structural
   * fields — code, requestId, retryable, action, stage, current — survive.
   */
  private async callPrivateMutation<
    K extends "private.edit" | "private.reclassify" | "private.adjustRelevance" | "private.merge",
  >(
    method: K,
    payload: AbmindMethodMap[K]["input"],
    idempotencyKey?: string,
  ): Promise<AbmindMethodMap[K]["output"]> {
    return await this.call(method, payload, idempotencyKey);
  }

  /**
   * #1885: the single typed transport call. The method string fixes the
   * input/output pair via AbmindMethodMap, so friendly wrappers cannot drift
   * from the wire contract; the compiler rejects a mismatched payload.
   */
  private async call<K extends AbmindMethod>(
    method: K,
    payload: AbmindMethodMap[K]["input"],
    idempotencyKey?: string,
  ): Promise<AbmindMethodMap[K]["output"]> {
    return this.callTransport<AbmindMethodMap[K]["output"]>(method, payload, idempotencyKey);
  }

  private async callTransport<T>(method: string, payload: unknown, idempotencyKey?: string): Promise<T> {
    const requestId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const req: Record<string, unknown> = {
      version: ABMIND_PROTOCOL_VERSION,
      requestId,
      method,
      payload,
    };
    if (isIdempotencyRequired(method)) {
      req.idempotencyKey = idempotencyKey ?? idempotencyKeyFor(method, payload);
    }

    const response = await this.transport.request(req as never);
    if ((response as Record<string, unknown>).ok === true) {
      return (response as Record<string, unknown>).result as T;
    }

    const resp = response as { requestId: string; error: AbmindErrorBodyV1 };
    throw new AbmindClientError(resp.error, resp.requestId);
  }
}
