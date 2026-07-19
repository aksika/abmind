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
  status(): Promise<{ version: string; mode: string; instanceId: string; memoryDir: string; databaseSizeBytes: number; operationalDbSizeBytes: number; uptimeMs: number; requestCount: number }>;
  capabilities(): Promise<Record<string, string>>;
}

export interface AbmindPrivateMemoryApi {
  instantStore(params: InstantStoreParams): Promise<InstantStoreResult>;
  editMemory(params: EditMemoryParams): Promise<EditMemoryResult>;
  reclassifyMemory(id: number, level: number, userOverride: boolean): Promise<void>;
  adjustRelevance(id: number, delta: number): Promise<void>;
  mergeMemories(idA: number, idB: number): Promise<MergeResult>;
  cascadeDelete(messageIds: number[], userId: string): Promise<ForgetResult>;
  recall(params: RecallParams): Promise<RecallResult>;
  rebuildFtsIndexes(): Promise<{ rebuilt: string[] }>;
}

export type MergeResult = { merged: true; keptId: number; deletedId: number } | { merged: false; error: string };

export class AbmindClient {
  private transport: AbmindTransport;
  private capabilities_: AbmindCapabilitiesV1 | null = null;

  readonly system: AbmindSystemApi;
  readonly privateMemory: AbmindPrivateMemoryApi;
  readonly operational: OperationalMemoryApi;

  constructor(transport: AbmindTransport) {
    this.transport = transport;

    this.system = {
      negotiate: () => this.call<AbmindCapabilitiesV1>("system.negotiate", {}),
      health: () => this.call("system.health", {}),
      status: () => this.call("system.status", {}),
      capabilities: () => this.call("system.capabilities", {}),
    };

    this.privateMemory = {
      instantStore: (p) => this.call<InstantStoreResult>("private.instantStore", p),
      editMemory: (p) => this.call<EditMemoryResult>("private.edit", p),
      reclassifyMemory: (id, level, userOverride) => this.call<void>("private.reclassify", { id, level, userOverride }),
      adjustRelevance: (id, delta) => this.call<void>("private.adjustRelevance", { id, delta }),
      mergeMemories: (idA, idB) => this.call<MergeResult>("private.merge", { idA, idB }),
      cascadeDelete: (messageIds, userId) => this.call<ForgetResult>("private.cascadeDelete", { messageIds, userId }),
      recall: (p) => this.call<RecallResult>("private.recall", p),
      rebuildFtsIndexes: () => this.call<{ rebuilt: string[] }>("private.rebuildFts", {}),
    };

    this.operational = {
      submitDraft: (i) => this.call<OperationalResult<OperationalDraft>>("operational.submitDraft", i),
      listDrafts: (q) => this.call<OperationalResult<Page<OperationalDraft>>>("operational.listDrafts", q),
      getMemory: (memoryId) => this.call<OperationalResult<OperationalMemoryProjection>>("operational.getMemory", { memoryId }),
      getHistory: (memoryId, page) => this.call<OperationalResult<Page<OperationalMemoryVersion>>>("operational.getHistory", { memoryId, page }),
      promoteDraft: (i) => this.call<OperationalResult<OperationalMemoryProjection>>("operational.promoteDraft", i),
      rejectDraft: (i) => this.call<OperationalResult<OperationalDraft>>("operational.rejectDraft", i),
      revise: (i) => this.call<OperationalResult<OperationalMemoryProjection>>("operational.revise", i),
      retire: (i) => this.call<OperationalResult<OperationalMemoryProjection>>("operational.retire", i),
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
