import { createHash } from "node:crypto";
import type {
  OperationalMemoryProjection, OperationalDraft, OperationalMemoryVersion,
  OperationalRecallHit, Page, PageRequest, DraftListQuery, OperationalRecallQuery,
  SubmitOperationalDraftInput, PromoteDraftInput, RejectDraftInput,
  ReviseOperationalMemoryInput, RetireOperationalMemoryInput, OperationalResult,
} from "./operational-memory-types.js";
import type {
  DreamQuestionStatus, DreamQuestionWireProjection,
  NextPendingResult, ListResult, MarkAskedResult, DismissResult,
} from "./dream-question-store.js";
import type { InstantStoreParams, InstantStoreResult, PrivateMutationSafety, ReclassifyPrivateMemoryInputV1, AdjustPrivateRelevanceInputV1, MergePrivateMemoriesInputV1, EditPrivateMemoryInputV1, PrivateMutationStatusV1, CascadeDeletePrivateMessagesInputV1, CascadeDeleteResultV1 } from "./mem-types.js";
import type { RecallParams, RecallResult } from "./recall-engine.js";
import { redactSecrets } from "./redact-secrets.js";

export const ABMIND_PROTOCOL_VERSION = 1 as const;
export { ABMIND_VERSION } from "./_version.js";

/** #1449: private-mutation safety enforcement. False until all represented methods pass conformance tests. */
export const CAS_WRITE_ENABLED = true;
export const PRIVATE_MUTATION_CONTRACT = "revision-v1" as const;

// ── Bounds ──────────────────────────────────────────────────────────────────

export const REQUEST_ID_MAX = 128;
export const IDEMPOTENCY_KEY_MAX = 128;
export const PRINCIPAL_ID_MAX = 256;
export const SESSION_ORIGIN_MAX = 256;
export const REQUEST_MAX_BYTES = 262144;
export const RESPONSE_MAX_BYTES = 524288;
export const HEALTH_MAX_BYTES = 4096;
export const STATUS_MAX_BYTES = 16384;
export const CAPABILITIES_MAX_BYTES = 65536;
export const SERVER_INSTANCE_ID_MAX = 64;
export const ERROR_MESSAGE_MAX = 512;
export const CONTEXT_SESSION_ID_MAX = 128;
export const CONTEXT_ORIGIN_MAX = 256;
export const QUESTION_ID_MAX = 128;
export const DELIVERY_KEY_MAX = 128;

// ── Current conflict shapes (#1372) ─────────────────────────────────────────

export type AbmindCurrentV1 =
  | { kind: "memory"; memoryId: string; versionId: string; contentHash: string }
  | { kind: "draft"; draftId: string; status: "promoted" | "rejected"; promotedMemoryId?: string }
  | { kind: "private_memory"; memoryId: number; semanticRevision: number };

// ── Error codes ─────────────────────────────────────────────────────────────

export type AbmindErrorCodeV1 =
  | "owner_active"
  | "unavailable"
  | "unauthorized"
  | "validation_error"
  | "not_found"
  | "conflict"
  | "idempotency_conflict"
  | "outcome_unknown"
  | "unsupported_version"
  | "unsupported_method";

// ── Failure contract (#1659) ────────────────────────────────────────────────

/** What the caller should do with a mutation failure. */
export type AbmindFailureActionV1 =
  | "fix_input"
  | "re_recall"
  | "retry"
  | "reconcile"
  | "stop";

/**
 * Where the failure was classified in the mutation lifecycle.
 * - `pre_dispatch`: the mutation definitely did not begin.
 * - `dispatch`: the mutation was dispatched and its typed outcome is known.
 * - `response`: the mutation may have been accepted; the response is uncertain.
 */
export type AbmindFailureStageV1 = "pre_dispatch" | "dispatch" | "response";

/** Exhaustive code → retryability/action mapping. No call site may override. */
export function errorContract(code: AbmindErrorCodeV1): { retryable: boolean; action: AbmindFailureActionV1 } {
  switch (code) {
    case "validation_error": return { retryable: false, action: "fix_input" };
    case "not_found": return { retryable: false, action: "stop" };
    case "conflict": return { retryable: false, action: "re_recall" };
    case "unauthorized": return { retryable: false, action: "stop" };
    case "idempotency_conflict": return { retryable: false, action: "stop" };
    case "unavailable": return { retryable: true, action: "retry" };
    case "outcome_unknown": return { retryable: false, action: "reconcile" };
    case "owner_active": return { retryable: false, action: "stop" };
    case "unsupported_version":
    case "unsupported_method": return { retryable: false, action: "fix_input" };
    // Defensive runtime fallback for a malformed/forward-version peer. The
    // wire type is closed, but an untrusted transport must never produce
    // undefined retry metadata.
    default: return { retryable: false, action: "reconcile" };
  }
}

/** Build a complete error body from code, bounded message, and explicit stage. */
export function errorBodyV1(
  code: AbmindErrorCodeV1,
  message: string,
  stage: AbmindFailureStageV1,
  current?: AbmindCurrentV1,
): AbmindErrorBodyV1 {
  const contract = errorContract(code);
  const redacted = redactSecrets(String(message));
  const boundedMessage = redacted.length <= ERROR_MESSAGE_MAX
    ? redacted
    : `${redacted.slice(0, ERROR_MESSAGE_MAX - 3)}...`;
  return { code, message: boundedMessage, retryable: contract.retryable, action: contract.action, stage, ...(current ? { current } : {}) };
}

// ── Method map ──────────────────────────────────────────────────────────────

export interface AbmindSystemHealthOutput {
  status: "healthy" | "degraded" | "unavailable";
  uptimeMs: number;
  memoryEnabled: boolean;
}

export interface AbmindSystemStatusOutput {
  version: string;
  buildCommit: string | null;
  releaseId: string | null;
  mode: "embedded" | "daemon";
  instanceId: string;
  pid: number;
  databaseSizeBytes: number;
  operationalDbSizeBytes: number;
  uptimeMs: number;
  requestCount: number;
}

export interface AbmindCapabilitiesV1 {
  version: number;
  methods: string[];
  domains: string[];
  features: Record<string, string>;
}

export interface AbmindMethodMap {
  "system.negotiate": { input: Record<string, never>; output: AbmindCapabilitiesV1 };
  "system.health": { input: Record<string, never>; output: AbmindSystemHealthOutput };
  "system.status": { input: Record<string, never>; output: AbmindSystemStatusOutput };
  "system.capabilities": { input: Record<string, never>; output: Record<string, string> };

  "private.recall": { input: RecallParams; output: RecallResult };
  "private.instantStore": { input: InstantStoreParams; output: InstantStoreResult };
  "private.edit": { input: EditPrivateMemoryInputV1; output: PrivateMutationStatusV1 };
  "private.reclassify": { input: ReclassifyPrivateMemoryInputV1; output: PrivateMutationStatusV1 };
  "private.adjustRelevance": { input: AdjustPrivateRelevanceInputV1; output: PrivateMutationStatusV1 };
  "private.merge": { input: MergePrivateMemoriesInputV1; output: PrivateMutationStatusV1 };
  "private.cascadeDelete": { input: CascadeDeletePrivateMessagesInputV1; output: CascadeDeleteResultV1 };
  "private.rebuildFts": { input: Record<string, never>; output: { rebuilt: string[] } };
  "private.embed": { input: { texts: string[] }; output: { vectors: Array<number[] | null>; model: string } };

  "operational.submitDraft": { input: SubmitOperationalDraftInput; output: OperationalResult<OperationalDraft> };
  "operational.listDrafts": { input: DraftListQuery; output: OperationalResult<Page<OperationalDraft>> };
  "operational.getMemory": { input: { memoryId: string }; output: OperationalResult<OperationalMemoryProjection> };
  "operational.getHistory": { input: { memoryId: string; page: PageRequest }; output: OperationalResult<Page<OperationalMemoryVersion>> };
  "operational.promoteDraft": { input: PromoteDraftInput; output: OperationalResult<OperationalMemoryProjection> };
  "operational.rejectDraft": { input: RejectDraftInput; output: OperationalResult<OperationalDraft> };
  "operational.revise": { input: ReviseOperationalMemoryInput; output: OperationalResult<OperationalMemoryProjection> };
  "operational.retire": { input: RetireOperationalMemoryInput; output: OperationalResult<OperationalMemoryProjection> };
  "operational.recall": { input: OperationalRecallQuery; output: OperationalResult<Page<OperationalRecallHit>> };

  "private.recordMessage": {
    input: {
      userId: string;
      sessionId: string;
      role: string;
      content: string;
      timestamp: number;
      platformMessageId?: number | string;
      emotionScore?: number;
      typeHint?: string;
      topicHint?: string;
      emotionHint?: string;
    };
    output: { id: number | null };
  };
  "private.getRecentConversation": {
    input: { userId: string; since: number; limit: number };
    output: Array<{ role: string; content: string; timestamp: number }>;
  };
  "private.assembleSessionContext": {
    input: { userId: string; maxChars?: number };
    output: {
      wakeUp: string; recall: string; coreKnowledge: string;
      soulBundle: { soul: string; profile: string; notes: string; memoryTools: string; coreFacts: string };
    };
  };
  "private.getRuntimeStatus": {
    input: { userId?: string };
    output: {
      totalMessages: number; extractedMemories: number; extractedByType: Record<string, number>;
      consolidationFiles: { daily: number; weekly: number; quarterly: number };
      ingestedDocuments: number; preservedKeywords: number; dbSizeBytes: number;
      rejectedByScanner: number;
    } | null;
  };
  "private.getCoreKnowledge": {
    input: { userId: string };
    output: string;
  };
  "private.recordFeedback": {
    input: { userId: string; memoryId: number; feedbackType: "cite" | "reject"; };
    output: void;
  };
  // #1527: daemon-owned durable context projection for Pi sessions.
  "private.projectConversationContext": {
    input: { userId: string; sessionId: string; beforeMessageId: number; maxContext: number };
    output: {
      version: 1;
      messages: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
      estimatedTokens: number;
      prunedToolResults: number;
      sourceMessageCount: number;
    };
  };

  // #1406: owner-scoped durable conversation compaction. Prepare is a bounded
  // read; commit revalidates owner/session/candidate/source invariants and
  // atomically inserts the checkpoint plus a generation-guarded active pointer.
  "private.prepareConversationCompaction": {
    input: PrepareConversationCompactionInputV1;
    output: PrepareConversationCompactionOutputV1;
  };
  "private.commitConversationCompaction": {
    input: CommitConversationCompactionInputV1;
    output: CommitConversationCompactionOutputV1;
  };

  // #1515: durable Dreamy clarification questions. The first two are reads;
  // the latter two are single-row state-CAS mutations (idempotency required).
  "private.dreamQuestions.nextPending": {
    input: { userId: string };
    output: NextPendingResult;
  };
  "private.dreamQuestions.list": {
    input: { userId: string; status?: DreamQuestionStatus; limit?: number };
    output: ListResult;
  };
  "private.dreamQuestions.markAsked": {
    input: { userId: string; questionId: string; deliveryKey: string };
    output: MarkAskedResult;
  };
  "private.dreamQuestions.dismiss": {
    input: { userId: string; questionId: string };
    output: DismissResult;
  };

  // ── Sleep service (#1381) ──────────────────────────────────────────────────
  "sleep.start": {
    input: { mode: "scheduled" | "manual"; level?: string; fresh?: boolean };
    output: { status: "accepted" | "already_running" | "unavailable"; runId?: string; reason?: string };
  };
  "sleep.status": {
    input: Record<string, never>;
    output: {
      state: "idle" | "running" | "terminal" | "interrupted";
      active?: { runId: string; mode: string; startedAt: number; step?: string; percent: number };
      last?: { runId?: string; attemptedAt: number; finishedAt?: number; status: string; report?: string; resumable: boolean; completedSteps: number; failedSteps: number };
    };
  };
  "sleep.resume": {
    input: { runId?: string; level?: string };
    output: { status: "accepted" | "not_found" | "not_resumable" | "already_running" | "unavailable"; runId?: string; reason?: string };
  };
  "sleep.cancel": {
    input: { runId: string };
    output: { status: "cancelling" | "already_terminal" | "not_found" | "unavailable" };
  };
  "sleep.events": {
    input: { afterSeq: number; limit?: number; waitMs?: number };
    output: {
      runId: string; events: Array<{ seq: number; at: number; event: { type: string; detail?: string } }>;
      nextSeq: number; gap: boolean; terminal: boolean;
    };
  };
  "sleep.runtime.open": {
    input: { providerInstanceId: string };
    output: { status: "ok" | "already_open" | "unavailable"; leaseId?: string; expiresAt?: number };
  };
  "sleep.runtime.next": {
    input: { leaseId: string; waitMs?: number };
    output: { status: "ok" | "lease_expired" | "no_request" | "closed"; completionRequest?: { completionId: string; runId: string; stepId: string; prompt: string; deadline: number }; heartbeat?: true };
  };
  "sleep.runtime.complete": {
    input: { leaseId: string; completionId: string; text: string };
    output: { status: "ok" | "invalid_lease" | "invalid_completion" | "run_terminal" };
  };
  "sleep.runtime.fail": {
    input: { leaseId: string; completionId: string; code: string };
    output: { status: "ok" | "invalid_lease" | "invalid_completion" | "run_terminal" };
  };
  "sleep.runtime.close": {
    input: { leaseId: string };
    output: { status: "ok" | "not_found" };
  };

  // #1452 — operator diagnostics
  "operator.diagnose": {
    input: Record<string, never>;
    output: { checks: DoctorCheckResult[] };
  };
  "operator.repair": {
    input: { action: DoctorRepairAction };
    output: DoctorRepairResult;
  };
}

// #1452 — doctor types
export type DoctorStatus = "ok" | "warn" | "error" | "skip";

export interface DoctorCheckResult {
  id: string;
  name: string;
  status: DoctorStatus;
  message: string;
  repair?: DoctorRepairAction;
}

export type DoctorRepairAction =
  | "rebuild_fts"
  | "checkpoint_wal"
  | "backfill_embeddings"
  | "clear_corrupt_embeddings";

export interface DoctorRepairResult {
  action: DoctorRepairAction;
  outcome: "applied" | "refused" | "failed";
  message: string;
}

export type AbmindMethod = keyof AbmindMethodMap;

// ── Envelope types ──────────────────────────────────────────────────────────

export interface AbmindRequestV1<K extends AbmindMethod = AbmindMethod> {
  version: typeof ABMIND_PROTOCOL_VERSION;
  requestId: string;
  method: K;
  idempotencyKey?: string;
  context?: { sessionId?: string; origin?: string };
  payload: AbmindMethodMap[K]["input"];
}

export interface AbmindErrorBodyV1 {
  code: AbmindErrorCodeV1;
  message: string;
  /** Safe to retry only when the mutation definitely did not begin. */
  retryable: boolean;
  /** The action the caller should take. */
  action: AbmindFailureActionV1;
  /** Where in the mutation lifecycle the failure was classified. */
  stage: AbmindFailureStageV1;
  current?: AbmindCurrentV1;
}

export type AbmindResponseV1<K extends AbmindMethod = AbmindMethod> =
  | { ok: true; requestId: string; serverInstanceId: string; result: AbmindMethodMap[K]["output"] }
  | { ok: false; requestId: string; serverInstanceId?: string; error: AbmindErrorBodyV1 };

// ── Transport / context ─────────────────────────────────────────────────────

export type AuthenticatedBy = "embedded" | "local_peer" | "signed_peer";
export type CallerRole = "local_user" | "host_agent" | "service" | "peer";
export type DomainName = "system" | "private" | "operational" | "operator";

export interface ServiceCallContext {
  principalId: string;
  role: CallerRole;
  grantedDomains: ReadonlySet<DomainName>;
  /** Narrow capabilities granted by the authenticated transport. */
  capabilities?: ReadonlySet<string>;
  /** Exact method allowlist for remote/signed peers. Absent = all domain methods allowed. */
  allowedMethods?: ReadonlySet<AbmindMethod>;
  /** Local host agents may explicitly delegate a private call to a user identity. */
  allowPrivateDelegation?: boolean;
  /** Private user identity granted by remote policy (signed peer only). */
  privateUserId?: string;
  authenticatedBy: AuthenticatedBy;
}

export interface AbmindTransport {
  negotiate(): Promise<AbmindCapabilitiesV1>;
  request<K extends AbmindMethod>(req: AbmindRequestV1<K>): Promise<AbmindResponseV1<K>>;
  close(): Promise<void>;
}

// ── Method registry metadata ────────────────────────────────────────────────

export type MutationFlag = "read" | "mutate";

export interface MethodEntry<K extends AbmindMethod = AbmindMethod> {
  domain: DomainName;
  mutation: MutationFlag;
  /** #1449: mutation safety classification. */
  safety?: PrivateMutationSafety;
  capability?: string;
  maxInputBytes: number;
  maxOutputBytes: number;
}

export const METHOD_REGISTRY: { [K in AbmindMethod]: MethodEntry<K> } = {
  "system.negotiate": { domain: "system", mutation: "read", maxInputBytes: 1024, maxOutputBytes: CAPABILITIES_MAX_BYTES },
  "system.health": { domain: "system", mutation: "read", maxInputBytes: 1024, maxOutputBytes: HEALTH_MAX_BYTES },
  "system.status": { domain: "system", mutation: "read", maxInputBytes: 1024, maxOutputBytes: STATUS_MAX_BYTES },
  "system.capabilities": { domain: "system", mutation: "read", maxInputBytes: 1024, maxOutputBytes: STATUS_MAX_BYTES },
  "private.recall": { domain: "private", mutation: "read", maxInputBytes: 32768, maxOutputBytes: RESPONSE_MAX_BYTES },
  "private.instantStore": { domain: "private", mutation: "mutate", safety: "append-idempotent", maxInputBytes: 65536, maxOutputBytes: 8192 },
  "private.edit": { domain: "private", mutation: "mutate", safety: "semantic-revision-cas", maxInputBytes: 65536, maxOutputBytes: 8192 },
  "private.reclassify": { domain: "private", mutation: "mutate", safety: "semantic-revision-cas", maxInputBytes: 4096, maxOutputBytes: 1024 },
  "private.adjustRelevance": { domain: "private", mutation: "mutate", safety: "semantic-revision-cas", maxInputBytes: 4096, maxOutputBytes: 1024 },
  "private.merge": { domain: "private", mutation: "mutate", safety: "semantic-revision-cas", maxInputBytes: 4096, maxOutputBytes: 4096 },
  "private.cascadeDelete": { domain: "private", mutation: "mutate", safety: "owner-cascade-delete", maxInputBytes: 65536, maxOutputBytes: 8192 },
  "private.rebuildFts": { domain: "operator", mutation: "mutate", capability: "rebuild_fts", maxInputBytes: 1024, maxOutputBytes: 4096 },
  "private.embed": { domain: "private", mutation: "read", maxInputBytes: 65536, maxOutputBytes: RESPONSE_MAX_BYTES },
  "operational.submitDraft": { domain: "operational", mutation: "mutate", maxInputBytes: 65536, maxOutputBytes: 65536 },
  "operational.listDrafts": { domain: "operational", mutation: "read", maxInputBytes: 4096, maxOutputBytes: RESPONSE_MAX_BYTES },
  "operational.getMemory": { domain: "operational", mutation: "read", maxInputBytes: 2048, maxOutputBytes: RESPONSE_MAX_BYTES },
  "operational.getHistory": { domain: "operational", mutation: "read", maxInputBytes: 4096, maxOutputBytes: RESPONSE_MAX_BYTES },
  "operational.promoteDraft": { domain: "operational", mutation: "mutate", maxInputBytes: 65536, maxOutputBytes: RESPONSE_MAX_BYTES },
  "operational.rejectDraft": { domain: "operational", mutation: "mutate", maxInputBytes: 4096, maxOutputBytes: 65536 },
  "operational.revise": { domain: "operational", mutation: "mutate", maxInputBytes: 65536, maxOutputBytes: RESPONSE_MAX_BYTES },
  "operational.retire": { domain: "operational", mutation: "mutate", maxInputBytes: 4096, maxOutputBytes: RESPONSE_MAX_BYTES },
  "operational.recall": { domain: "operational", mutation: "read", maxInputBytes: 4096, maxOutputBytes: RESPONSE_MAX_BYTES },

  "private.recordMessage": { domain: "private", mutation: "mutate", safety: "atomic-counter", maxInputBytes: 65536, maxOutputBytes: 1024 },
  "private.getRecentConversation": { domain: "private", mutation: "read", maxInputBytes: 4096, maxOutputBytes: 262144 },
  "private.assembleSessionContext": { domain: "private", mutation: "read", maxInputBytes: 4096, maxOutputBytes: 131072 },
  "private.getRuntimeStatus": { domain: "private", mutation: "read", maxInputBytes: 1024, maxOutputBytes: 65536 },
  "private.getCoreKnowledge": { domain: "private", mutation: "read", maxInputBytes: 1024, maxOutputBytes: 65536 },
  "private.recordFeedback": { domain: "private", mutation: "mutate", safety: "atomic-counter", maxInputBytes: 4096, maxOutputBytes: 1024 },
  "private.projectConversationContext": { domain: "private", mutation: "read", maxInputBytes: 4096, maxOutputBytes: 262144 },
  "private.prepareConversationCompaction": { domain: "private", mutation: "read", maxInputBytes: 4096, maxOutputBytes: 262144 },
  "private.commitConversationCompaction": { domain: "private", mutation: "mutate", safety: "append-idempotent", maxInputBytes: 262144, maxOutputBytes: 4096 },
  "private.dreamQuestions.nextPending": { domain: "private", mutation: "read", maxInputBytes: 2048, maxOutputBytes: 8192 },
  "private.dreamQuestions.list": { domain: "private", mutation: "read", maxInputBytes: 2048, maxOutputBytes: 65536 },
  "private.dreamQuestions.markAsked": { domain: "private", mutation: "mutate", safety: "single-row-state-cas", maxInputBytes: 4096, maxOutputBytes: 1024 },
  "private.dreamQuestions.dismiss": { domain: "private", mutation: "mutate", safety: "single-row-state-cas", maxInputBytes: 2048, maxOutputBytes: 1024 },

  // ── Sleep service (#1381, system domain with capability gates) ─────────────
  "sleep.start": { domain: "system", mutation: "mutate", capability: "sleep_start", maxInputBytes: 2048, maxOutputBytes: 2048 },
  "sleep.status": { domain: "system", mutation: "read", capability: "sleep_status", maxInputBytes: 1024, maxOutputBytes: 16384 },
  "sleep.resume": { domain: "system", mutation: "mutate", capability: "sleep_resume", maxInputBytes: 2048, maxOutputBytes: 2048 },
  "sleep.cancel": { domain: "system", mutation: "mutate", capability: "sleep_cancel", maxInputBytes: 2048, maxOutputBytes: 1024 },
  "sleep.events": { domain: "system", mutation: "read", capability: "sleep_events", maxInputBytes: 4096, maxOutputBytes: 65536 },
  "sleep.runtime.open": { domain: "system", mutation: "mutate", capability: "sleep_runtime_provider", maxInputBytes: 2048, maxOutputBytes: 2048 },
  "sleep.runtime.next": { domain: "system", mutation: "read", capability: "sleep_runtime_provider", maxInputBytes: 2048, maxOutputBytes: 131072 },
  "sleep.runtime.complete": { domain: "system", mutation: "mutate", capability: "sleep_runtime_provider", maxInputBytes: 131072, maxOutputBytes: 1024 },
  "sleep.runtime.fail": { domain: "system", mutation: "mutate", capability: "sleep_runtime_provider", maxInputBytes: 4096, maxOutputBytes: 1024 },
  "sleep.runtime.close": { domain: "system", mutation: "mutate", capability: "sleep_runtime_provider", maxInputBytes: 2048, maxOutputBytes: 1024 },

  // #1452 — operator diagnostics contracts
  "operator.diagnose": { domain: "operator", mutation: "read", capability: "doctor_diagnose", maxInputBytes: 1024, maxOutputBytes: RESPONSE_MAX_BYTES },
  "operator.repair": { domain: "operator", mutation: "mutate", capability: "doctor_fix", maxInputBytes: 4096, maxOutputBytes: 65536 },
};

export function isMutatingMethod(method: AbmindMethod): boolean {
  return METHOD_REGISTRY[method].mutation === "mutate";
}

export function isIdempotencyRequired(method: string): boolean {
  const entry = METHOD_REGISTRY[method as AbmindMethod];
  return entry ? entry.mutation === "mutate" : false;
}

export function methodDomain(method: string): DomainName | undefined {
  const entry = METHOD_REGISTRY[method as AbmindMethod];
  return entry?.domain;
}

// ── Canonical payload hash ──────────────────────────────────────────────────

export function canonicalPayloadHash(version: number, method: string, payload: unknown): string {
  const prefix = `abmind-idem-v${version}\0`;
  const canonical = canonicalJson(payload);
  return createHash("sha256").update(prefix, "utf-8").update(canonical, "utf-8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Non-finite number in canonical JSON: ${value}`);
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(v => canonicalJson(v)).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return "{" + keys.map(k => `${canonicalJson(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",") + "}";
  }
  throw new Error(`Unsupported type in canonical JSON: ${typeof value}`);
}

// ── Named type exports for new methods (#1380) ───────────────────────────────

export type RecordMessageInput = AbmindMethodMap["private.recordMessage"]["input"];
export type RecordMessageOutput = AbmindMethodMap["private.recordMessage"]["output"];
export type GetRecentConversationInput = AbmindMethodMap["private.getRecentConversation"]["input"];
export type GetRecentConversationOutput = AbmindMethodMap["private.getRecentConversation"]["output"];
export type AssembleSessionContextInput = AbmindMethodMap["private.assembleSessionContext"]["input"];
export type AssembleSessionContextOutput = AbmindMethodMap["private.assembleSessionContext"]["output"];
export type GetRuntimeStatusInput = AbmindMethodMap["private.getRuntimeStatus"]["input"];
export type GetRuntimeStatusOutput = AbmindMethodMap["private.getRuntimeStatus"]["output"];
export type GetCoreKnowledgeInput = AbmindMethodMap["private.getCoreKnowledge"]["input"];
export type GetCoreKnowledgeOutput = AbmindMethodMap["private.getCoreKnowledge"]["output"];
export type RecordFeedbackInput = AbmindMethodMap["private.recordFeedback"]["input"];
export type RecordFeedbackOutput = AbmindMethodMap["private.recordFeedback"]["output"];
export type ProjectConversationContextInputV1 = AbmindMethodMap["private.projectConversationContext"]["input"];
export type ProjectConversationContextOutputV1 = AbmindMethodMap["private.projectConversationContext"]["output"];
export type DreamQuestionsNextPendingInput = AbmindMethodMap["private.dreamQuestions.nextPending"]["input"];
export type DreamQuestionsListInput = AbmindMethodMap["private.dreamQuestions.list"]["input"];
export type DreamQuestionsMarkAskedInput = AbmindMethodMap["private.dreamQuestions.markAsked"]["input"];
export type DreamQuestionsDismissInput = AbmindMethodMap["private.dreamQuestions.dismiss"]["input"];

// ── #1406: durable conversation compaction ───────────────────────────────────

export interface PrepareConversationCompactionInputV1 {
  userId: string;
  sessionId: string;
  beforeMessageId?: number;
  maxHistoryTokens: number;
  minRecentTokens: number;
  reason: "manual" | "automatic";
}

export interface CompactionCandidateV1 {
  version: 1;
  expectedGeneration: number;
  previousCheckpointId: number | null;
  sourceMessageStart: number;
  sourceMessageEnd: number;
  firstKeptMessageId: number;
  sourceDigest: string;
  sourceTokenCount: number;
  serializedTurns: string;
  priorCheckpoint: string;
  summaryTokenBudget: number;
}

export type PrepareConversationCompactionOutputV1 =
  | { status: "nothing_to_compact" }
  | { status: "busy" }
  | { status: "ready"; candidate: CompactionCandidateV1 };

export interface CommitConversationCompactionInputV1 {
  userId: string;
  sessionId: string;
  candidate: Omit<CompactionCandidateV1, "serializedTurns" | "priorCheckpoint" | "summaryTokenBudget">;
  summary: string;
  summaryTokenCount: number;
  summarizer: { provider: string | null; model: string | null };
  activeRequestModel: string | null;
  reason: "manual" | "automatic";
  customInstructionsDigest?: string;
}

export type CommitConversationCompactionOutputV1 =
  | { status: "committed"; checkpointId: number; generation: number }
  | { status: "stale" }
  | { status: "rejected" };
