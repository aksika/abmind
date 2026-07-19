import type {
  AbmindTransport, AbmindCapabilitiesV1,
} from "./abmind-protocol.js";
import { ABMIND_PROTOCOL_VERSION, isIdempotencyRequired } from "./abmind-protocol.js";
import type { OperationalMemoryApi } from "./imemory-system.js";
import type {
  OperationalDraft, OperationalMemoryProjection, OperationalMemoryVersion,
  OperationalRecallHit, OperationalResult, Page, PageRequest, DraftListQuery,
  OperationalRecallQuery, SubmitOperationalDraftInput, PromoteDraftInput,
  RejectDraftInput, ReviseOperationalMemoryInput, RetireOperationalMemoryInput,
} from "./operational-memory-types.js";
import type { InstantStoreParams, InstantStoreResult, EditMemoryParams, EditMemoryResult, ForgetResult } from "./mem-types.js";
import type { RecallParams, RecallResult } from "./recall-engine.js";

let idemCounter = 0;
function idempotencyKeyFor(method: string, _payload: unknown): string {
  idemCounter++;
  return `idem-${method}-${Date.now()}-${idemCounter}`;
}

export interface AbmindSystemApi {
  negotiate(): Promise<AbmindCapabilitiesV1>;
  health(): Promise<{ status: string; uptimeMs: number; memoryEnabled: boolean }>;
  status(): Promise<{ version: string; mode: string; instanceId: string; databaseSizeBytes: number; operationalDbSizeBytes: number; uptimeMs: number; requestCount: number }>;
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
  editMemory(params: EditMemoryParams, idempotencyKey?: string): Promise<EditMemoryResult>;
  reclassifyMemory(id: number, level: number, userOverride: boolean, idempotencyKey?: string): Promise<void>;
  adjustRelevance(id: number, delta: number, idempotencyKey?: string): Promise<void>;
  mergeMemories(idA: number, idB: number, idempotencyKey?: string): Promise<MergeResult>;
  cascadeDelete(messageIds: number[], userId: string, idempotencyKey?: string): Promise<ForgetResult>;
  recall(params: RecallParams): Promise<RecallResult>;
  rebuildFtsIndexes(): Promise<{ rebuilt: string[] }>;
  embed(input: { texts: string[] }): Promise<{ vectors: Array<number[] | null>; model: string }>;
  recordMessage(input: { userId: string; sessionId: string; role: string; content: string; timestamp: number; platformMessageId?: number; emotionScore?: number; typeHint?: string; topicHint?: string; emotionHint?: string }, idempotencyKey?: string): Promise<{ id: number | null }>;
  getRecentConversation(input: { userId: string; since: number; limit: number }): Promise<Array<{ role: string; content: string; timestamp: number }>>;
  assembleSessionContext(input: { userId: string; maxChars?: number }): Promise<{
    wakeUp: string; recall: string; coreKnowledge: string;
    soulBundle: { soul: string; profile: string; notes: string; memoryTools: string; coreFacts: string };
  }>;
  getRuntimeStatus(input?: { userId?: string }): Promise<any>;
  getCoreKnowledge(input: { userId: string }): Promise<string>;
  recordFeedback(input: { userId: string; memoryId: number; feedbackType: "cite" | "reject" }, idempotencyKey?: string): Promise<void>;
}

export type MergeResult = { merged: true; keptId: number; deletedId: number } | { merged: false; error: string };

export class AbmindClient {
  private transport: AbmindTransport;
  private capabilities_: AbmindCapabilitiesV1 | null = null;

  readonly system: AbmindSystemApi;
  readonly privateMemory: AbmindPrivateMemoryApi;
  readonly operational: AbmindOperationalApi;

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
      editMemory: (p, key) => this.call<EditMemoryResult>("private.edit", p, key),
      reclassifyMemory: (id, level, userOverride, key) => this.call<void>("private.reclassify", { id, level, userOverride }, key),
      adjustRelevance: (id, delta, key) => this.call<void>("private.adjustRelevance", { id, delta }, key),
      mergeMemories: (idA, idB, key) => this.call<MergeResult>("private.merge", { idA, idB }, key),
      cascadeDelete: (messageIds, userId, key) => this.call<ForgetResult>("private.cascadeDelete", { messageIds, userId }, key),
      recall: (p) => this.call<RecallResult>("private.recall", p),
      rebuildFtsIndexes: () => this.call<{ rebuilt: string[] }>("private.rebuildFts", {}),
      embed: (p) => this.call("private.embed", p),
      recordMessage: (p, key) => this.call("private.recordMessage", p, key),
      getRecentConversation: (p) => this.call("private.getRecentConversation", p),
      assembleSessionContext: (p) => this.call("private.assembleSessionContext", p),
      getRuntimeStatus: (p) => this.call("private.getRuntimeStatus", p ?? {}),
      getCoreKnowledge: (p) => this.call("private.getCoreKnowledge", p),
      recordFeedback: (p, key) => this.call("private.recordFeedback", p, key),
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
  }

  get capabilities(): AbmindCapabilitiesV1 | null { return this.capabilities_; }

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

    const err = (response as Record<string, unknown>).error as { code: string; message: string; current?: unknown };
    const errObj = new Error(err.message) as Error & { code: string; current?: unknown };
    errObj.code = err.code;
    errObj.current = err.current;
    throw errObj;
  }
}
