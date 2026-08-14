import type {
  AbmindTransport, AbmindCapabilitiesV1, AbmindErrorBodyV1, AbmindErrorCodeV1,
  AbmindFailureActionV1, AbmindFailureStageV1, AbmindCurrentV1,
} from "./abmind-protocol.js";
import { ABMIND_PROTOCOL_VERSION, ERROR_MESSAGE_MAX, REQUEST_ID_MAX, errorContract, isIdempotencyRequired } from "./abmind-protocol.js";
import { redactSecrets } from "./redact-secrets.js";
import type { OperationalMemoryApi } from "./imemory-system.js";
import type {
  OperationalDraft, OperationalMemoryProjection, OperationalMemoryVersion,
  OperationalRecallHit, OperationalResult, Page, PageRequest, DraftListQuery,
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
import type { RecallParams, RecallResult } from "./recall-engine.js";
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
  rebuildFtsIndexes(): Promise<{ rebuilt: string[] }>;
  embed(input: { texts: string[] }): Promise<{ vectors: Array<number[] | null>; model: string }>;
  // #1660: owner-only sealed label search and local-only plaintext resolution.
  findSealedSecrets(input: FindSealedSecretsInput): Promise<SealedSecretRefV1[]>;
  resolveSealedSecret(input: ResolveSealedSecretInput): Promise<ResolveSealedSecretResult>;
  recordMessage(input: { userId: string; sessionId: string; role: string; content: string; timestamp: number; platformMessageId?: number | string; emotionScore?: number; typeHint?: string; topicHint?: string; emotionHint?: string }, idempotencyKey?: string): Promise<{ id: number | null }>;
  getRecentConversation(input: { userId: string; since: number; limit: number }): Promise<Array<{ role: string; content: string; timestamp: number }>>;
  assembleSessionContext(input: { userId: string; maxChars?: number }): Promise<{
    wakeUp: string; recall: string; coreKnowledge: string;
    soulBundle: { soul: string; profile: string; notes: string; memoryTools: string; coreFacts: string };
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

export interface AbmindSleepApi {
  start(mode: "scheduled" | "manual", level?: string, fresh?: boolean, idempotencyKey?: string): Promise<{ status: "accepted" | "already_running" | "unavailable"; runId?: string; reason?: string }>;
  status(): Promise<{ state: "idle" | "running" | "terminal" | "interrupted"; active?: { runId: string; mode: string; startedAt: number; step?: string; percent: number }; last?: { runId?: string; attemptedAt: number; finishedAt?: number; status: string; report?: string; resumable: boolean; completedSteps: number; failedSteps: number } }>;
  resume(runId?: string, level?: string, idempotencyKey?: string): Promise<{ status: "accepted" | "not_found" | "not_resumable" | "already_running" | "unavailable"; runId?: string; reason?: string }>;
  cancel(runId: string, idempotencyKey?: string): Promise<{ status: "cancelling" | "already_terminal" | "not_found" | "unavailable" }>;
  events(afterSeq: number, limit?: number, waitMs?: number): Promise<{ runId: string; events: Array<{ seq: number; at: number; event: { type: string; detail?: string } }>; nextSeq: number; gap: boolean; terminal: boolean }>;
  runtime: {
    open(providerInstanceId: string, idempotencyKey?: string): Promise<{ status: "ok" | "already_open" | "unavailable"; leaseId?: string; expiresAt?: number }>;
    next(leaseId: string, waitMs?: number): Promise<{ status: "ok" | "lease_expired" | "no_request" | "closed"; completionRequest?: { completionId: string; runId: string; stepId: string; prompt: string; deadline: number }; heartbeat?: true }>;
    complete(leaseId: string, completionId: string, text: string, idempotencyKey?: string): Promise<{ status: "ok" | "invalid_lease" | "invalid_completion" | "run_terminal" }>;
    fail(leaseId: string, completionId: string, code: string, idempotencyKey?: string): Promise<{ status: "ok" | "invalid_lease" | "invalid_completion" | "run_terminal" }>;
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

  constructor(transport: AbmindTransport) {
    this.transport = transport;

    this.system = {
      negotiate: () => this.call<AbmindCapabilitiesV1>("system.negotiate", {}),
      health: () => this.call("system.health", {}),
      status: () => this.call("system.status", {}),
      capabilities: () => this.call("system.capabilities", {}),
    };

    this.privateMemory = {
      instantStore: (p, key) => this.call<InstantStoreResult>("private.instantStore", p, key),
      editMemory: (p, key) => this.callPrivateMutation("private.edit", p, key),
      reclassifyMemory: (p, key) => this.callPrivateMutation("private.reclassify", p, key),
      adjustRelevance: (p, key) => this.callPrivateMutation("private.adjustRelevance", p, key),
      mergeMemories: (p, key) => this.callPrivateMutation("private.merge", p, key),
      cascadeDelete: (input, key) => this.call<CascadeDeleteResultV1>("private.cascadeDelete", input, key),
      recall: (p) => this.call<RecallResult>("private.recall", p),
      rebuildFtsIndexes: () => this.call<{ rebuilt: string[] }>("private.rebuildFts", {}),
      embed: (p) => this.call("private.embed", p),
      findSealedSecrets: (p) => this.call<SealedSecretRefV1[]>("private.findSealedSecrets", p),
      resolveSealedSecret: (p) => this.call<ResolveSealedSecretResult>("private.resolveSealedSecret", p),
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
        nextPending: (userId) => this.call<DreamQuestionWireProjection | null>("private.dreamQuestions.nextPending", { userId }),
        list: (userId, status, limit) => this.call<{ questions: DreamQuestionWireProjection[] }>("private.dreamQuestions.list", { userId, status, limit }),
        markAsked: (p, key) => this.call<{ status: "asked" | "not_found" | "conflict" }>("private.dreamQuestions.markAsked", p, key),
        dismiss: (p, key) => this.call<{ status: "dismissed" | "not_found" | "already_terminal" }>("private.dreamQuestions.dismiss", p, key),
      },
    };

    this.operational = {
      submitDraft: (i, key) => this.call<OperationalResult<OperationalDraft>>("operational.submitDraft", i, key),
      listDrafts: (q) => this.call<OperationalResult<Page<OperationalDraft>>>("operational.listDrafts", q),
      getMemory: (memoryId) => this.call<OperationalResult<OperationalMemoryProjection>>("operational.getMemory", { memoryId }),
      getHistory: (memoryId, page) => this.call<OperationalResult<Page<OperationalMemoryVersion>>>("operational.getHistory", { memoryId, page }),
      promoteDraft: (i, key) => this.call<OperationalResult<OperationalMemoryProjection>>("operational.promoteDraft", i, key),
      rejectDraft: (i, key) => this.call<OperationalResult<OperationalDraft>>("operational.rejectDraft", i, key),
      revise: (i, key) => this.call<OperationalResult<OperationalMemoryProjection>>("operational.revise", i, key),
      retire: (i, key) => this.call<OperationalResult<OperationalMemoryProjection>>("operational.retire", i, key),
      recall: (q) => this.call<OperationalResult<Page<OperationalRecallHit>>>("operational.recall", q),
    };

    this.operator = {
      diagnose: () => this.call<{ checks: DoctorCheckResult[] }>("operator.diagnose", {}),
      repair: (action, key) => this.call<DoctorRepairResult>("operator.repair", { action }, key),
    };

    this.sleep = {
      start: (m, l, f, key) => this.call("sleep.start", { mode: m, level: l, fresh: f }, key),
      status: () => this.call("sleep.status", {}),
      resume: (runId, level, key) => this.call("sleep.resume", { runId, level }, key),
      cancel: (runId, key) => this.call("sleep.cancel", { runId }, key),
      events: (afterSeq, limit, waitMs) => this.call("sleep.events", { afterSeq, limit, waitMs }),
      runtime: {
        open: (id, key) => this.call("sleep.runtime.open", { providerInstanceId: id }, key),
        next: (leaseId, waitMs) => this.call("sleep.runtime.next", { leaseId, waitMs }),
        complete: (leaseId, completionId, text, key) => this.call("sleep.runtime.complete", { leaseId, completionId, text }, key),
        fail: (leaseId, completionId, code, key) => this.call("sleep.runtime.fail", { leaseId, completionId, code }, key),
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
    return this.call(method, payload, idempotencyKey);
  }

  /**
   * Private semantic mutations expose their bounded failure contract as
   * AbmindClientError (same as every other method). The full structural
   * fields — code, requestId, retryable, action, stage, current — survive.
   */
  private async callPrivateMutation(
    method: "private.edit" | "private.reclassify" | "private.adjustRelevance" | "private.merge",
    payload: unknown,
    idempotencyKey?: string,
  ): Promise<PrivateMutationStatusV1> {
    return await this.call<PrivateMutationStatusV1>(method, payload, idempotencyKey);
  }

  private async call<T>(method: string, payload: unknown, idempotencyKey?: string): Promise<T> {
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
