import { createHash } from "node:crypto";
import type {
  OperationalMemoryProjection, OperationalDraft, OperationalMemoryVersion,
  OperationalRecallHit, Page, PageRequest, DraftListQuery, OperationalRecallQuery,
  SubmitOperationalDraftInput, PromoteDraftInput, RejectDraftInput,
  ReviseOperationalMemoryInput, RetireOperationalMemoryInput, OperationalResult,
} from "./operational-memory-types.js";
import type { InstantStoreParams, InstantStoreResult, EditMemoryParams, EditMemoryResult, ForgetResult } from "./mem-types.js";
import type { RecallParams, RecallResult } from "./recall-engine.js";
import type { MergeResult } from "./memory-backend.js";

export const ABMIND_PROTOCOL_VERSION = 1 as const;
export const ABMIND_VERSION = "0.1.0";

/** #1449: private-mutation expected-hash CAS enforcement. False until CAS is implemented. */
export const CAS_WRITE_ENABLED = false;

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

// ── Current conflict shapes (#1372) ─────────────────────────────────────────

export type AbmindCurrentV1 =
  | { kind: "memory"; memoryId: string; versionId: string; contentHash: string }
  | { kind: "draft"; draftId: string; status: "promoted" | "rejected"; promotedMemoryId?: string };

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

// ── Method map ──────────────────────────────────────────────────────────────

export interface AbmindSystemHealthOutput {
  status: "healthy" | "degraded" | "unavailable";
  uptimeMs: number;
  memoryEnabled: boolean;
}

export interface AbmindSystemStatusOutput {
  version: string;
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
  "private.edit": { input: EditMemoryParams; output: EditMemoryResult };
  "private.reclassify": { input: { id: number; level: number; userOverride: boolean }; output: void };
  "private.adjustRelevance": { input: { id: number; delta: number }; output: void };
  "private.merge": { input: { idA: number; idB: number }; output: MergeResult };
  "private.cascadeDelete": { input: { messageIds: number[]; userId: string }; output: ForgetResult };
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
      platformMessageId?: number;
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
      last?: { runId?: string; attemptedAt: number; finishedAt?: number; status: string; resumable: boolean; completedSteps: number; failedSteps: number };
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
  /** Direct rack edits remain disabled until #1449 CAS is available. */
  requiresCas?: boolean;
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
  "private.instantStore": { domain: "private", mutation: "mutate", requiresCas: true, maxInputBytes: 65536, maxOutputBytes: 8192 },
  "private.edit": { domain: "private", mutation: "mutate", requiresCas: true, maxInputBytes: 65536, maxOutputBytes: 8192 },
  "private.reclassify": { domain: "private", mutation: "mutate", requiresCas: true, maxInputBytes: 4096, maxOutputBytes: 1024 },
  "private.adjustRelevance": { domain: "private", mutation: "mutate", requiresCas: true, maxInputBytes: 4096, maxOutputBytes: 1024 },
  "private.merge": { domain: "private", mutation: "mutate", requiresCas: true, maxInputBytes: 4096, maxOutputBytes: 4096 },
  "private.cascadeDelete": { domain: "private", mutation: "mutate", requiresCas: true, maxInputBytes: 65536, maxOutputBytes: 8192 },
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

  "private.recordMessage": { domain: "private", mutation: "mutate", maxInputBytes: 65536, maxOutputBytes: 1024 },
  "private.getRecentConversation": { domain: "private", mutation: "read", maxInputBytes: 4096, maxOutputBytes: 262144 },
  "private.assembleSessionContext": { domain: "private", mutation: "read", maxInputBytes: 4096, maxOutputBytes: 131072 },
  "private.getRuntimeStatus": { domain: "private", mutation: "read", maxInputBytes: 1024, maxOutputBytes: 65536 },
  "private.getCoreKnowledge": { domain: "private", mutation: "read", maxInputBytes: 1024, maxOutputBytes: 65536 },
  "private.recordFeedback": { domain: "private", mutation: "mutate", maxInputBytes: 4096, maxOutputBytes: 1024 },

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
