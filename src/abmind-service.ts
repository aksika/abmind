import type Database from "better-sqlite3";
import type {
  AbmindMethod, AbmindMethodMap, AbmindRequestV1, AbmindResponseV1,
  AbmindErrorBodyV1, AbmindCurrentV1, AbmindCapabilitiesV1,
  AbmindSystemHealthOutput, AbmindSystemStatusOutput,
  ServiceCallContext, DomainName, MethodEntry,
} from "./abmind-protocol.js";
import {
  ABMIND_PROTOCOL_VERSION, METHOD_REGISTRY, REQUEST_MAX_BYTES,
  RESPONSE_MAX_BYTES, REQUEST_ID_MAX, IDEMPOTENCY_KEY_MAX,
  SESSION_ORIGIN_MAX, PRINCIPAL_ID_MAX, CONTEXT_SESSION_ID_MAX,
  ABMIND_VERSION, CAS_WRITE_ENABLED, PRIVATE_MUTATION_CONTRACT,
  canonicalPayloadHash, errorBodyV1, isMutatingMethod,
} from "./abmind-protocol.js";
import type { AbmindFailureStageV1 } from "./abmind-protocol.js";
import { logInfo, logWarn } from "./mem-logger.js";
import { fingerprint } from "./request-fingerprint.js";
import type { MemoryManager } from "./memory-manager.js";
import { runDiagnostics, runRepair } from "./operator-diagnostics.js";
import type { DoctorRepairAction, DoctorRepairResult, DoctorCheckResult } from "./abmind-protocol.js";
import type { OperationalMemoryApi } from "./imemory-system.js";
import type { PageRequest } from "./operational-memory-types.js";
import { buildSessionStartContext } from "./session-context.js";
import { buildWakeUp } from "./wake-up-builder.js";
import { getMemoryDb } from "./memory-manager.js";
import { DreamQuestionStore } from "./dream-question-store.js";
import type { DreamQuestionStatus, NextPendingResult, ListResult, MarkAskedResult, DismissResult } from "./dream-question-store.js";
import { ContextProjector, ContextProjectionError } from "./context-projector.js";
import type { ProjectConversationContextInputV1, ProjectConversationContextOutputV1 } from "./abmind-protocol.js";
import { ContextCompactionService } from "./context-compaction.js";
import type {
  PrepareConversationCompactionInputV1, PrepareConversationCompactionOutputV1,
  CommitConversationCompactionInputV1, CommitConversationCompactionOutputV1,
} from "./abmind-protocol.js";
import { QUESTION_ID_MAX, DELIVERY_KEY_MAX } from "./abmind-protocol.js";
import type { SleepCoordinator } from "./sleep-service/sleep-coordinator.js";
import type {
  EffectivePrivateMutationContext, PrivateMutationStatusV1,
  EditPrivateMemoryInputV1, ReclassifyPrivateMemoryInputV1,
  AdjustPrivateRelevanceInputV1, CascadeDeletePrivateMessagesInputV1,
} from "./mem-types.js";

export interface AbmindServiceConfig {
  serverInstanceId: string;
  mode: "embedded" | "daemon";
  manager: MemoryManager;
  operational: OperationalMemoryApi | null;
  requestLedgerDb: Database.Database | null;
  sleepCoordinator?: SleepCoordinator;
  /** Build identity from active release metadata (null for source builds). */
  buildCommit?: string | null;
  releaseId?: string | null;
}

export class AbmindService {
  private readonly serverInstanceId: string;
  private readonly mode_: "embedded" | "daemon";
  private readonly manager: MemoryManager;
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

  async drain(timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (this.inFlight_ > 0 && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  async handle<K extends AbmindMethod>(
    request: AbmindRequestV1<K>,
    context: ServiceCallContext,
  ): Promise<AbmindResponseV1<K>> {
    if (this.closed) return this.err(request.requestId, "unavailable", "Service is closed");

    const parseResult = this.parseAndValidate(request);
    if (!parseResult.ok) return parseResult.response;

    const { method, payload } = parseResult;
    const mutationRequest = isMutatingMethod(method);
    if (mutationRequest) {
      this.traceAccepted(request.requestId, method, request.idempotencyKey);
    }

    const startedAt = Date.now();
    const response = await this.handleParsed(request, method, payload, context);
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

    const payloadError = this.validatePayload(method, payload);
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
   * principal IDs, or raw idempotency keys.
   */
  private traceAccepted(requestId: string, method: AbmindMethod, idempotencyKey?: string): void {
    this.traceSeq++;
    const keyFp = idempotencyKey ? fingerprint(idempotencyKey, 8) : "-";
    logInfo("request-trace", `[ACCEPTED] seq=${this.traceSeq} requestId=${requestId} method=${method} key=${keyFp}`);
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

  private parseAndValidate<K extends AbmindMethod>(
    request: AbmindRequestV1<K>,
  ): { ok: true; method: K; payload: AbmindMethodMap[K]["input"] } | { ok: false; response: AbmindResponseV1<K> } {
    if (request.version !== ABMIND_PROTOCOL_VERSION) {
      return { ok: false, response: this.err(request.requestId, "unsupported_version", `Unsupported protocol version: ${request.version}`) };
    }

    if (!request.method) {
      return { ok: false, response: this.err(request.requestId, "unsupported_method", "Method is required") };
    }

    const entry = METHOD_REGISTRY[request.method];
    if (!entry) {
      return { ok: false, response: this.err(request.requestId, "unsupported_method", `Unsupported method: ${request.method}`) };
    }

    if (typeof request.requestId !== "string" || request.requestId.length > REQUEST_ID_MAX) {
      return { ok: false, response: this.err(request.requestId, "validation_error", "Invalid or oversized requestId") };
    }

    if (request.idempotencyKey != null && (typeof request.idempotencyKey !== "string" || request.idempotencyKey.length > IDEMPOTENCY_KEY_MAX)) {
      return { ok: false, response: this.err(request.requestId, "validation_error", "Invalid or oversized idempotencyKey") };
    }

    if (request.context) {
      if (typeof request.context !== "object" || request.context === null) {
        return { ok: false, response: this.err(request.requestId, "validation_error", "context must be an object") };
      }
      if (request.context.sessionId != null && (typeof request.context.sessionId !== "string" || request.context.sessionId.length > SESSION_ORIGIN_MAX)) {
        return { ok: false, response: this.err(request.requestId, "validation_error", "Invalid sessionId") };
      }
      if (request.context.origin != null && (typeof request.context.origin !== "string" || request.context.origin.length > SESSION_ORIGIN_MAX)) {
        return { ok: false, response: this.err(request.requestId, "validation_error", "Invalid origin") };
      }
    }

    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(request.payload);
    } catch {
      return { ok: false, response: this.err(request.requestId, "validation_error", "Payload must be JSON-serializable") };
    }
    if (typeof serialized !== "string") {
      return { ok: false, response: this.err(request.requestId, "validation_error", "Payload is required") };
    }
    if (Buffer.byteLength(serialized, "utf-8") > Math.min(REQUEST_MAX_BYTES, entry.maxInputBytes)) {
      return { ok: false, response: this.err(request.requestId, "validation_error", "Request payload exceeds maximum size") };
    }

    return { ok: true, method: request.method, payload: request.payload as AbmindMethodMap[K]["input"] };
  }

  private validatePayload(method: AbmindMethod, payload: unknown): string | null {
    if (method.startsWith("private.") || method.startsWith("operational.")) {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return "Payload must be an object";
      }
    }

    const p = payload as Record<string, unknown>;
    const requiredString = (name: string): string | null =>
      typeof p[name] === "string" && (p[name] as string).trim().length > 0 ? null : `${name} must be a non-empty string`;

    switch (method) {
      case "private.recall": {
        const userError = requiredString("userId");
        if (userError) return userError;
        if (!Array.isArray(p.translated) || p.translated.some((v) => typeof v !== "string")) {
          return "translated must be an array of strings";
        }
        return null;
      }
      case "private.instantStore":
        return requiredString("userId") ?? requiredString("contentEn") ?? requiredString("contentOriginal") ?? requiredString("memoryType");
      case "private.edit":
        if (requiredString("userId")) return requiredString("userId");
        if (!Number.isSafeInteger(p.memoryId) || (p.memoryId as number) < 1) return "memoryId must be a positive integer";
        if (!Number.isSafeInteger(p.expectedRevision) || (p.expectedRevision as number) < 1) return "expectedRevision must be a positive integer";
        return null;
      case "private.reclassify":
        if (requiredString("userId")) return requiredString("userId");
        if (!Number.isSafeInteger(p.memoryId) || (p.memoryId as number) < 1) return "memoryId must be a positive integer";
        if (!Number.isSafeInteger(p.expectedRevision) || (p.expectedRevision as number) < 1) return "expectedRevision must be a positive integer";
        if (!Number.isInteger(p.classification) || (p.classification as number) < 0 || (p.classification as number) > 3) return "classification must be 0-3";
        return null;
      case "private.adjustRelevance":
        if (requiredString("userId")) return requiredString("userId");
        if (!Number.isSafeInteger(p.memoryId) || (p.memoryId as number) < 1) return "memoryId must be a positive integer";
        if (!Number.isSafeInteger(p.expectedRevision) || (p.expectedRevision as number) < 1) return "expectedRevision must be a positive integer";
        return Number.isFinite(p.delta) ? null : "delta must be finite";
      case "private.merge":
        if (requiredString("userId")) return requiredString("userId");
        if (!p.first || !p.second || typeof p.first !== "object" || typeof p.second !== "object") return "first and second refs are required";
        for (const name of ["first", "second"] as const) {
          const ref = p[name] as Record<string, unknown>;
          if (!Number.isSafeInteger(ref.memoryId) || (ref.memoryId as number) < 1) return `${name}.memoryId must be a positive integer`;
          if (!Number.isSafeInteger(ref.semanticRevision) || (ref.semanticRevision as number) < 1) return `${name}.semanticRevision must be a positive integer`;
        }
        return null;
      case "private.cascadeDelete": {
        if (requiredString("userId")) return requiredString("userId");
        if (!Array.isArray(p.messageIds) || (p.messageIds as number[]).length < 1 || (p.messageIds as number[]).length > 512) {
          return "messageIds must contain 1-512 message IDs";
        }
        const seen = new Set<number>();
        for (const v of p.messageIds as number[]) {
          if (!Number.isSafeInteger(v) || v < 1) return "messageIds must be positive safe integers";
          if (seen.has(v)) return "messageIds must be unique";
          seen.add(v);
        }
        return null;
      }
      case "private.recordMessage":
      case "private.assembleSessionContext":
      case "private.getCoreKnowledge":
        return requiredString("userId");
      case "private.recordFeedback":
        if (requiredString("userId")) return requiredString("userId");
        if (!Number.isSafeInteger(p.memoryId) || (p.memoryId as number) < 1) return "memoryId must be a positive integer";
        return p.feedbackType === "cite" || p.feedbackType === "reject" ? null : "feedbackType must be cite or reject";
      case "private.projectConversationContext": {
        const userIdError = requiredString("userId");
        if (userIdError) return userIdError;
        if ((p.userId as string).length > PRINCIPAL_ID_MAX) return `userId exceeds ${PRINCIPAL_ID_MAX} characters`;
        const sessionIdError = requiredString("sessionId");
        if (sessionIdError) return sessionIdError;
        if ((p.sessionId as string).length > CONTEXT_SESSION_ID_MAX) return `sessionId exceeds ${CONTEXT_SESSION_ID_MAX} characters`;
        if (!Number.isSafeInteger(p.beforeMessageId) || (p.beforeMessageId as number) < 0) {
          return "beforeMessageId must be a non-negative safe integer";
        }
        if (!Number.isSafeInteger(p.maxContext) || (p.maxContext as number) < 256 || (p.maxContext as number) > 10_000_000) {
          return "maxContext must be within the supported budget";
        }
        const allowed = new Set(["userId", "sessionId", "beforeMessageId", "maxContext"]);
        for (const key of Object.keys(p)) {
          if (!allowed.has(key)) return `unknown field: ${key}`;
        }
        return null;
      }
      case "private.prepareConversationCompaction": {
        const userIdError = requiredString("userId");
        if (userIdError) return userIdError;
        if ((p.userId as string).length > PRINCIPAL_ID_MAX) return `userId exceeds ${PRINCIPAL_ID_MAX} characters`;
        const sessionIdError = requiredString("sessionId");
        if (sessionIdError) return sessionIdError;
        if ((p.sessionId as string).length > CONTEXT_SESSION_ID_MAX) return `sessionId exceeds ${CONTEXT_SESSION_ID_MAX} characters`;
        if (p.beforeMessageId !== undefined && (!Number.isSafeInteger(p.beforeMessageId) || (p.beforeMessageId as number) < 0)) {
          return "beforeMessageId must be a non-negative safe integer";
        }
        if (!Number.isSafeInteger(p.maxHistoryTokens) || (p.maxHistoryTokens as number) < 0) {
          return "maxHistoryTokens must be a non-negative safe integer";
        }
        if (!Number.isSafeInteger(p.minRecentTokens) || (p.minRecentTokens as number) < 0) {
          return "minRecentTokens must be a non-negative safe integer";
        }
        if (p.reason !== "manual" && p.reason !== "automatic") return "reason must be manual or automatic";
        const allowed = new Set(["userId", "sessionId", "beforeMessageId", "maxHistoryTokens", "minRecentTokens", "reason"]);
        for (const key of Object.keys(p)) {
          if (!allowed.has(key)) return `unknown field: ${key}`;
        }
        return null;
      }
      case "private.commitConversationCompaction": {
        const userIdError = requiredString("userId");
        if (userIdError) return userIdError;
        if ((p.userId as string).length > PRINCIPAL_ID_MAX) return `userId exceeds ${PRINCIPAL_ID_MAX} characters`;
        const sessionIdError = requiredString("sessionId");
        if (sessionIdError) return sessionIdError;
        if ((p.sessionId as string).length > CONTEXT_SESSION_ID_MAX) return `sessionId exceeds ${CONTEXT_SESSION_ID_MAX} characters`;
        if (typeof p.summary !== "string" || p.summary.trim().length === 0) return "summary must be a non-empty string";
        if (typeof p.summaryTokenCount !== "number" || !Number.isSafeInteger(p.summaryTokenCount) || p.summaryTokenCount < 0) {
          return "summaryTokenCount must be a non-negative safe integer";
        }
        const sm = p.summarizer as Record<string, unknown> | null | undefined;
        if (!sm || typeof sm !== "object" || Array.isArray(sm)
          || (sm.provider !== null && typeof sm.provider !== "string")
          || (sm.model !== null && typeof sm.model !== "string")) {
          return "summarizer must be { provider: string|null, model: string|null }";
        }
        if (p.activeRequestModel !== null && typeof p.activeRequestModel !== "string") {
          return "activeRequestModel must be a string or null";
        }
        if (p.reason !== "manual" && p.reason !== "automatic") return "reason must be manual or automatic";
        if (p.customInstructionsDigest !== undefined
          && (typeof p.customInstructionsDigest !== "string" || p.customInstructionsDigest.length > 128)) {
          return "customInstructionsDigest must be a short string";
        }
        const c = p.candidate as Record<string, unknown> | null | undefined;
        if (!c || typeof c !== "object" || Array.isArray(c)) return "candidate is required";
        if (c.version !== 1) return "candidate.version must be 1";
        if (!Number.isSafeInteger(c.expectedGeneration) || (c.expectedGeneration as number) < 0) {
          return "candidate.expectedGeneration must be a non-negative safe integer";
        }
        if (c.previousCheckpointId !== null && (!Number.isSafeInteger(c.previousCheckpointId) || (c.previousCheckpointId as number) < 1)) {
          return "candidate.previousCheckpointId must be null or a positive safe integer";
        }
        for (const name of ["sourceMessageStart", "sourceMessageEnd", "firstKeptMessageId"] as const) {
          if (!Number.isSafeInteger(c[name]) || (c[name] as number) < 0) {
            return `candidate.${name} must be a non-negative safe integer`;
          }
        }
        if (typeof c.sourceDigest !== "string" || c.sourceDigest.length === 0 || c.sourceDigest.length > 64) {
          return "candidate.sourceDigest must be a short string";
        }
        if (!Number.isSafeInteger(c.sourceTokenCount) || (c.sourceTokenCount as number) < 0) {
          return "candidate.sourceTokenCount must be a non-negative safe integer";
        }
        const allowed = new Set(["userId", "sessionId", "candidate", "summary", "summaryTokenCount", "summarizer", "activeRequestModel", "reason", "customInstructionsDigest"]);
        for (const key of Object.keys(p)) {
          if (!allowed.has(key)) return `unknown field: ${key}`;
        }
        return null;
      }
      case "private.dreamQuestions.nextPending":
      case "private.dreamQuestions.list": {
        const userIdError = requiredString("userId");
        if (userIdError) return userIdError;
        if ((p.userId as string).length > PRINCIPAL_ID_MAX) return `userId exceeds ${PRINCIPAL_ID_MAX} characters`;
        const list = method === "private.dreamQuestions.list" ? p as { limit?: unknown; status?: unknown } : null;
        if (list) {
          if (list.limit !== undefined && (!Number.isSafeInteger(list.limit) || (list.limit as number) < 1 || (list.limit as number) > 50)) {
            return "limit must be a safe integer within 1-50";
          }
          if (list.status !== undefined
            && !["pending", "asked", "resolved", "expired", "dismissed"].includes(list.status as string)) {
            return "status must be a valid lifecycle status";
          }
        }
        return null;
      }
      case "private.dreamQuestions.markAsked": {
        const userIdError = requiredString("userId");
        if (userIdError) return userIdError;
        if ((p.userId as string).length > PRINCIPAL_ID_MAX) return `userId exceeds ${PRINCIPAL_ID_MAX} characters`;
        if (requiredString("questionId")) return requiredString("questionId");
        if ((p.questionId as string).length > QUESTION_ID_MAX) return `questionId exceeds ${QUESTION_ID_MAX} characters`;
        if (requiredString("deliveryKey")) return requiredString("deliveryKey");
        if ((p.deliveryKey as string).length > DELIVERY_KEY_MAX) return `deliveryKey exceeds ${DELIVERY_KEY_MAX} characters`;
        return null;
      }
      case "private.dreamQuestions.dismiss": {
        const userIdError = requiredString("userId");
        if (userIdError) return userIdError;
        if ((p.userId as string).length > PRINCIPAL_ID_MAX) return `userId exceeds ${PRINCIPAL_ID_MAX} characters`;
        if (requiredString("questionId")) return requiredString("questionId");
        if ((p.questionId as string).length > QUESTION_ID_MAX) return `questionId exceeds ${QUESTION_ID_MAX} characters`;
        return null;
      }
      case "private.embed":
        if (!Array.isArray(p.texts) || p.texts.length < 1 || p.texts.length > 100 || p.texts.some((v) => typeof v !== "string" || v.length > 8192)) {
          return "texts must contain 1-100 strings of at most 8192 characters";
        }
        return null;
      case "operator.diagnose":
        return null;
      case "operator.repair": {
        const validActions = ["rebuild_fts", "checkpoint_wal", "backfill_embeddings", "clear_corrupt_embeddings"];
        return validActions.includes(p.action as string) ? null : `unknown repair action: ${p.action}`;
      }
      default:
        return null;
    }
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
      return this.err(requestId, "unavailable", `Dispatch error: ${(err as Error).message}`);
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
      this.ledger!.markStarted(context.principalId, idempotencyKey);
      response = await this.dispatchMutation(requestId, method, payload, context);
    } catch (err) {
      response = this.err(requestId, "outcome_unknown", `Dispatch outcome unknown: ${(err as Error).message}`, undefined, "response");
    }

    try {
      // A durable outcome_unknown stays a tombstone; only typed outcomes are
      // completed (and therefore cleanable) responses.
      if (!response.ok && response.error.code === "outcome_unknown") {
        this.ledger!.markUnknown(context.principalId, idempotencyKey);
      } else {
        this.ledger!.complete(context.principalId, idempotencyKey, JSON.stringify(response));
      }
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

  /** Custom error that can carry a typed conflict response. */
  static readonly PrivateMutationError = class extends Error {
    constructor(readonly errorBody: AbmindErrorBodyV1) {
      super(errorBody.message);
      this.name = "PrivateMutationError";
    }
  };

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
      // post-dispatch exception is never claimed safe to retry.
      return this.err(requestId, "outcome_unknown", `Dispatch outcome unknown: ${(err as Error).message}`, undefined, "response");
    }
  }

  private async doDispatch<K extends AbmindMethod>(
    method: K,
    payload: AbmindMethodMap[K]["input"],
    _context?: ServiceCallContext,
  ): Promise<AbmindMethodMap[K]["output"]> {
    const m = method;
    const p = payload as unknown;
    switch (m) {
      case "system.negotiate":
        return this.handleNegotiate(_context) as unknown as AbmindMethodMap[K]["output"];
      case "system.health":
        return this.handleHealth() as unknown as AbmindMethodMap[K]["output"];
      case "system.status":
        return this.handleStatus() as unknown as AbmindMethodMap[K]["output"];
      case "system.capabilities":
        return this.handleCapabilities() as unknown as AbmindMethodMap[K]["output"];

      case "private.recall":
        return await this.dispatchPrivateRecall(p as Parameters<typeof this.manager.recallSearch>[0]) as unknown as AbmindMethodMap[K]["output"];
      case "private.instantStore":
        {
          if (!_context) throw new Error("Context required for private mutation");
          const ctx = this.buildPrivateMutationContext(_context, p as { userId?: string });
          const result = await this.manager.editor.instantStore({
            ...(p as Parameters<MemoryManager["editor"]["instantStore"]>[0]),
            userId: ctx.userId,
            createdBy: ctx.actorId,
          });
          if (!result.stored) {
            // A typed instant-store rejection is a definitive pre-dispatch
            // failure: it never began a mutation.
            throw new AbmindService.PrivateMutationError(errorBodyV1(result.code, result.message, "pre_dispatch"));
          }
          return result as unknown as AbmindMethodMap[K]["output"];
        }
      case "private.edit": {
        if (!_context) throw new Error("Context required for private mutation");
        const input = p as EditPrivateMemoryInputV1;
        const ctx = this.buildPrivateMutationContext(_context, input);
        const result = this.manager.editor.getMutationStore().edit(ctx, input);
        this.storeOkOrThrow(result);
        return {
          ...result,
          memoriesUpdated: 1,
          ids: [input.memoryId],
          semanticRevision: result.ok ? result.ref.semanticRevision : undefined,
        } as unknown as AbmindMethodMap[K]["output"];
      }
      case "private.reclassify": {
        if (!_context) throw new Error("Context required for private mutation");
        const rp = p as ReclassifyPrivateMemoryInputV1;
        const result = this.manager.editor.getMutationStore().reclassify(
          this.buildPrivateMutationContext(_context, rp), rp,
        );
        this.storeOkOrThrow(result);
        return result as unknown as AbmindMethodMap[K]["output"];
      }
      case "private.adjustRelevance": {
        if (!_context) throw new Error("Context required for private mutation");
        const ap = p as AdjustPrivateRelevanceInputV1;
        const result = this.manager.editor.getMutationStore().adjustRelevance(
          this.buildPrivateMutationContext(_context, ap), ap,
        );
        this.storeOkOrThrow(result);
        return result as unknown as AbmindMethodMap[K]["output"];
      }
      case "private.merge":
        return this.dispatchStoreMerge(_context, p as Record<string, unknown>) as unknown as AbmindMethodMap[K]["output"];
      case "private.cascadeDelete": {
        if (!_context) throw new Error("Context required for private mutation");
        const input = p as CascadeDeletePrivateMessagesInputV1;
        const ctx = this.buildPrivateMutationContext(_context, input);
        return this.manager.editor.getMutationStore().cascadeDelete(ctx, input) as unknown as AbmindMethodMap[K]["output"];
      }
      case "private.rebuildFts":
        return this.manager.rebuildFtsIndexes() as unknown as AbmindMethodMap[K]["output"];
      case "private.embed": {
        const provider = this.manager.getEmbeddingProvider();
        if (!provider) throw new Error("Embeddings are not configured");
        const vectors = await provider.batchEmbed((p as { texts: string[] }).texts);
        return { vectors: vectors.map(v => v ? Array.from(v) : null), model: provider.name } as unknown as AbmindMethodMap[K]["output"];
      }

      case "private.recordMessage": {
        const id = this.manager.recordMessage(p as Parameters<MemoryManager["recordMessage"]>[0]);
        return { id } as AbmindMethodMap[K]["output"];
      }
      case "private.getRecentConversation": {
        const rcp = p as { userId: string; since: number; limit: number };
        return this.manager.getRecentConversation(rcp.userId, rcp.since, rcp.limit) as any;
      }
      case "private.assembleSessionContext": {
        const scp = p as { userId: string; maxChars?: number };
        const maxChars = scp.maxChars == null ? undefined : Math.max(256, Math.min(131072, Math.floor(scp.maxChars)));
        const session = buildSessionStartContext(this.manager, scp.userId, maxChars);
        return {
          wakeUp: this.manager.buildWakeUp(maxChars),
          recall: session.text ?? "",
          coreKnowledge: this.manager.readCoreKnowledge(),
          soulBundle: this.manager.getSessionBundle(),
        } as any;
      }
      case "private.getRuntimeStatus":
        return this.manager.getStats((p as any)?.userId) as any;
      case "private.getCoreKnowledge":
        return this.manager.readCoreKnowledge() as any;
      case "private.recordFeedback": {
        const fp = p as { userId: string; memoryId: number; feedbackType: "cite" | "reject" };
        if (!this.manager.hasExtractedMemoryForUser(fp.memoryId, fp.userId)) {
          throw new Error("Memory no longer belongs to the authenticated user");
        }
        if (fp.feedbackType === "cite") this.manager.bumpCitedCount([fp.memoryId]);
        else this.manager.bumpRejectedCount([fp.memoryId]);
        return undefined as any;
      }
      case "private.projectConversationContext":
        return this.dispatchContextProjection(p as ProjectConversationContextInputV1) as unknown as AbmindMethodMap[K]["output"];
      case "private.prepareConversationCompaction":
        return this.dispatchPrepareCompaction(p as PrepareConversationCompactionInputV1) as unknown as AbmindMethodMap[K]["output"];
      case "private.commitConversationCompaction":
        return this.dispatchCommitCompaction(p as CommitConversationCompactionInputV1) as unknown as AbmindMethodMap[K]["output"];

      // #1515: owner-scoped dream-question lifecycle. The store owns all SQL;
      // dispatch only validates bounds (done above) and enforces ownership
      // (resolveUserId guarantees payload.userId === principalId here).
      case "private.dreamQuestions.nextPending":
      case "private.dreamQuestions.list":
      case "private.dreamQuestions.markAsked":
      case "private.dreamQuestions.dismiss":
        return this.dispatchDreamQuestions(m, p) as unknown as AbmindMethodMap[K]["output"];

      case "operational.submitDraft":
        return await this.operational!.submitDraft(p as Parameters<OperationalMemoryApi["submitDraft"]>[0]) as unknown as AbmindMethodMap[K]["output"];
      case "operational.listDrafts":
        return await this.operational!.listDrafts(p as Parameters<OperationalMemoryApi["listDrafts"]>[0]) as unknown as AbmindMethodMap[K]["output"];
      case "operational.getMemory":
        return await this.operational!.getMemory((p as { memoryId: string }).memoryId) as unknown as AbmindMethodMap[K]["output"];
      case "operational.getHistory":
        return await this.operational!.getHistory(
          (p as { memoryId: string; page: PageRequest }).memoryId,
          (p as { memoryId: string; page: PageRequest }).page,
        ) as unknown as AbmindMethodMap[K]["output"];
      case "operational.promoteDraft":
        return await this.operational!.promoteDraft(p as Parameters<OperationalMemoryApi["promoteDraft"]>[0]) as unknown as AbmindMethodMap[K]["output"];
      case "operational.rejectDraft":
        return await this.operational!.rejectDraft(p as Parameters<OperationalMemoryApi["rejectDraft"]>[0]) as unknown as AbmindMethodMap[K]["output"];
      case "operational.revise":
        return await this.operational!.revise(p as Parameters<OperationalMemoryApi["revise"]>[0]) as unknown as AbmindMethodMap[K]["output"];
      case "operational.retire":
        return await this.operational!.retire(p as Parameters<OperationalMemoryApi["retire"]>[0]) as unknown as AbmindMethodMap[K]["output"];
      case "operational.recall":
        return await this.operational!.recall(p as Parameters<OperationalMemoryApi["recall"]>[0]) as unknown as AbmindMethodMap[K]["output"];

      // ── Sleep service (#1381) ──────────────────────────────────────────────
      case "sleep.start": {
        const sp = p as { mode: "scheduled" | "manual"; level?: string; fresh?: boolean };
        return this.sleepCoordinator!.start(sp.mode, sp.level, sp.fresh) as unknown as AbmindMethodMap[K]["output"];
      }
      case "sleep.status": {
        return this.sleepCoordinator!.getStatus() as unknown as AbmindMethodMap[K]["output"];
      }
      case "sleep.resume": {
        const rp = p as { runId?: string; level?: string };
        return this.sleepCoordinator!.resume(rp.runId, rp.level) as unknown as AbmindMethodMap[K]["output"];
      }
      case "sleep.cancel": {
        const cp = p as { runId: string };
        return this.sleepCoordinator!.cancel(cp.runId) as unknown as AbmindMethodMap[K]["output"];
      }
      case "sleep.events": {
        const ep = p as { afterSeq: number; limit?: number; waitMs?: number };
        const status = this.sleepCoordinator!.getStatus();
        const result = await this.sleepCoordinator!.eventRing.readAfter(ep.afterSeq, ep.limit ?? 50, ep.waitMs ?? 0);
        return {
          runId: status.active?.runId ?? status.last?.runId ?? "",
          events: result.events,
          nextSeq: result.nextSeq,
          gap: result.gap,
          terminal: result.terminal,
        } as unknown as AbmindMethodMap[K]["output"];
      }
      case "sleep.runtime.open": {
        const op = p as { providerInstanceId: string };
        return this.sleepCoordinator!.runtimeBroker.open(op.providerInstanceId) as unknown as AbmindMethodMap[K]["output"];
      }
      case "sleep.runtime.next": {
        const np = p as { leaseId: string; waitMs?: number };
        return await this.sleepCoordinator!.runtimeBroker.next(np.leaseId, np.waitMs ?? 30_000) as unknown as AbmindMethodMap[K]["output"];
      }
      case "sleep.runtime.complete": {
        const cp = p as { leaseId: string; completionId: string; text: string };
        return this.sleepCoordinator!.runtimeBroker.complete(cp.leaseId, cp.completionId, cp.text) as unknown as AbmindMethodMap[K]["output"];
      }
      case "sleep.runtime.fail": {
        const fp = p as { leaseId: string; completionId: string; code: string };
        return this.sleepCoordinator!.runtimeBroker.fail(fp.leaseId, fp.completionId, fp.code) as unknown as AbmindMethodMap[K]["output"];
      }
      case "sleep.runtime.close": {
        const clp = p as { leaseId: string };
        return this.sleepCoordinator!.runtimeBroker.close(clp.leaseId) as unknown as AbmindMethodMap[K]["output"];
      }

      case "operator.diagnose": {
        const checks = await runDiagnostics({ manager: this.manager, memoryDir: this.manager.getConfig().memoryDir });
        return { checks } as unknown as AbmindMethodMap[K]["output"];
      }
      case "operator.repair": {
        const rp = p as { action: DoctorRepairAction };
        return await runRepair(this.manager, this.manager.getConfig().memoryDir, rp.action) as unknown as AbmindMethodMap[K]["output"];
      }

      default:
        throw new Error(`Unhandled method: ${method}`);
    }
  }

  private buildPrivateMutationContext(context: ServiceCallContext, payload: { userId?: string }): EffectivePrivateMutationContext {
    return {
      userId: payload.userId ?? context.principalId,
      actorId: context.principalId,
      operationKey: `srv-${context.principalId}-${Date.now()}`,
      canDeclassifySecret: context.capabilities?.has("private_declassify") === true,
      origin: context.authenticatedBy === "embedded" ? "local" : "remote",
    };
  }

  private storeOkOrThrow(storeResult: PrivateMutationStatusV1): void {
    if (storeResult.ok) return;
    let message: string;
    switch (storeResult.code) {
      case "conflict": message = "Semantic revision conflict"; break;
      case "not_found": message = "Memory not found"; break;
      case "unauthorized": message = "Not authorized"; break;
      case "validation_error": message = storeResult.message; break;
      default: message = "Mutation unavailable";
    }
    // Typed store rejections are definitive pre-dispatch failures.
    const error = errorBodyV1(storeResult.code, message, "pre_dispatch");
    if (storeResult.code === "conflict" && storeResult.current) {
      error.current = { kind: "private_memory", memoryId: storeResult.current.memoryId, semanticRevision: storeResult.current.semanticRevision };
    }
    throw new AbmindService.PrivateMutationError(error);
  }

  private dispatchStoreMerge(context: ServiceCallContext | undefined, p: Record<string, unknown>): Record<string, unknown> {
    if (!context) throw new Error("Context required for private mutation");
    const pp = p as { userId?: string; first?: { memoryId: number; semanticRevision: number }; second?: { memoryId: number; semanticRevision: number } };
    if (!pp.first || !pp.second) throw new Error("merge requires first and second refs");
    const ctx = this.buildPrivateMutationContext(context, pp);
    const result = this.manager.editor.getMutationStore().merge(ctx, {
      userId: ctx.userId,
      first: { memoryId: pp.first.memoryId, semanticRevision: pp.first.semanticRevision },
      second: { memoryId: pp.second.memoryId, semanticRevision: pp.second.semanticRevision },
    });
    this.storeOkOrThrow(result);
    return result;
  }

  private async dispatchPrivateRecall(
    params: Parameters<MemoryManager["recallSearch"]>[0],
  ): Promise<Awaited<ReturnType<MemoryManager["recallSearch"]>>> {
    return this.manager.recallSearch(params);
  }

  /**
   * #1527: daemon-owned durable context projection. Authorization is enforced
   * by the projector against the cursor row (user + session) and the
   * mixed-owner invariant. Rejections are bounded and content-free.
   */
  private dispatchContextProjection(input: ProjectConversationContextInputV1): ProjectConversationContextOutputV1 {
    const db = getMemoryDb(this.manager);
    if (!db) {
      throw new AbmindService.PrivateMutationError(errorBodyV1("unavailable", "Memory is not initialized", "pre_dispatch"));
    }
    try {
      return new ContextProjector(db).project(input);
    } catch (err) {
      if (err instanceof ContextProjectionError) {
        const code = err.code === "cursor_not_found" ? "not_found"
          : err.code === "cursor_invalid" ? "validation_error"
          : err.code === "legacy_lineage_unavailable" ? "unavailable"
          : "unauthorized";
        const message = code === "validation_error"
          ? "Conversation cursor is not a user message"
          : code === "unavailable"
            ? "Conversation checkpoint lineage unavailable"
          : "Conversation projection rejected";
        throw new AbmindService.PrivateMutationError(errorBodyV1(code, message, "pre_dispatch"));
      }
      throw err;
    }
  }

  /**
   * #1406: bounded, owner-scoped compaction prepare. The candidate is derived
   * inside the daemon from append-only durable rows; the caller summarizes it
   * provider-side and returns a proposed summary for server-side commit.
   */
  private dispatchPrepareCompaction(input: PrepareConversationCompactionInputV1): PrepareConversationCompactionOutputV1 {
    const db = getMemoryDb(this.manager);
    if (!db) {
      throw new AbmindService.PrivateMutationError(errorBodyV1("unavailable", "Memory is not initialized", "pre_dispatch"));
    }
    return this.getCompactionService(db).prepare(input);
  }

  /**
   * #1406: transactional checkpoint commit with generation CAS. Outcome is
   * data (committed/stale/rejected), never a fake success.
   */
  private dispatchCommitCompaction(input: CommitConversationCompactionInputV1): CommitConversationCompactionOutputV1 {
    const db = getMemoryDb(this.manager);
    if (!db) {
      throw new AbmindService.PrivateMutationError(errorBodyV1("unavailable", "Memory is not initialized", "pre_dispatch"));
    }
    return this.getCompactionService(db).commit(input);
  }

  private getCompactionService(db: Database.Database): ContextCompactionService {
    if (!this.compactionService) {
      this.compactionService = new ContextCompactionService(db);
    }
    return this.compactionService;
  }

  /**
   * #1515: owner-scoped dream-question methods. Every mutation is a single-row
   * CAS whose outcome is data (asked/conflict/not_found, dismissed/
   * already_terminal/not_found); owner mismatch never reveals row existence.
   */
  private dispatchDreamQuestions(
    method: "private.dreamQuestions.nextPending" | "private.dreamQuestions.list" | "private.dreamQuestions.markAsked" | "private.dreamQuestions.dismiss",
    payload: unknown,
  ): NextPendingResult | ListResult | MarkAskedResult | DismissResult {
    const db = getMemoryDb(this.manager);
    if (!db) {
      throw new AbmindService.PrivateMutationError(errorBodyV1("unavailable", "Memory is not initialized", "pre_dispatch"));
    }
    const store = new DreamQuestionStore(db);
    const p = payload as { userId: string; questionId?: string; deliveryKey?: string; status?: string; limit?: number };
    switch (method) {
      case "private.dreamQuestions.nextPending":
        return store.nextPending(p.userId);
      case "private.dreamQuestions.list":
        return store.list(p.userId, p.status as DreamQuestionStatus | undefined, p.limit);
      case "private.dreamQuestions.markAsked":
        return store.markAsked(p.userId, p.questionId!, p.deliveryKey!);
      case "private.dreamQuestions.dismiss":
        return store.dismiss(p.userId, p.questionId!);
    }
  }

  private handleNegotiate(context?: ServiceCallContext): AbmindCapabilitiesV1 {
    let methods: string[];
    if (context?.allowedMethods) {
      methods = [...context.allowedMethods].filter(m => m in METHOD_REGISTRY && METHOD_REGISTRY[m as AbmindMethod].safety !== "unavailable");
    } else {
      methods = Object.entries(METHOD_REGISTRY)
        .filter(([, entry]) => entry.safety !== "unavailable")
        .map(([method]) => method);
    }
    const domains = ["system", "private", "operational", "operator"];
    const features = this.buildFeatureSnapshot();
    return { version: ABMIND_PROTOCOL_VERSION, methods, domains, features };
  }

  private buildFeatureSnapshot(): Record<string, string> {
    return {
      mode: this.mode_,
      private_read: "true",
      private_write: String(CAS_WRITE_ENABLED),
      private_mutation_contract: CAS_WRITE_ENABLED ? PRIVATE_MUTATION_CONTRACT : "unavailable",
      operational: String(this.operational !== null),
      memory_enabled: String(this.manager.getConfig().memoryEnabled),
    };
  }

  private handleHealth(): AbmindSystemHealthOutput {
    const enabled = this.manager.getConfig().memoryEnabled;
    return { status: enabled ? "healthy" : "degraded", uptimeMs: Date.now() - this.startTime, memoryEnabled: enabled };
  }

  private handleStatus(): AbmindSystemStatusOutput {
    return {
      version: ABMIND_VERSION,
      buildCommit: this.buildCommit_,
      releaseId: this.releaseId_,
      mode: this.mode_,
      instanceId: this.serverInstanceId,
      pid: process.pid,
      databaseSizeBytes: 0,
      operationalDbSizeBytes: 0,
      uptimeMs: Date.now() - this.startTime,
      requestCount: this.requestCount_,
    };
  }

  private handleCapabilities(): Record<string, string> {
    return {
      version: String(ABMIND_PROTOCOL_VERSION),
      mode: this.mode_,
      ...this.buildFeatureSnapshot(),
    };
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

// ── Idempotency ledger ──────────────────────────────────────────────────────

export type ReservationResult =
  | { status: "completed"; responseJson: string }
  | { status: "conflict"; message: string }
  | { status: "in_flight" }
  | { status: "outcome_unknown" }
  | { status: "reserved" };

/** In-process ownership of one live mutation dispatch (#1659). Content-free. */
export type InFlightMutation = {
  readonly method: AbmindMethod;
  readonly payloadHash: string;
  readonly outcome: Promise<AbmindResponseV1>;
};

export class AbmindRequestLedger {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  reserve(principalId: string, idempotencyKey: string, method: string, payloadHash: string): ReservationResult {
    const existing = this.db.prepare(`
      SELECT method, payload_hash, state, response_json, created_at, updated_at FROM abmind_service_requests
      WHERE principal_id = ? AND idempotency_key = ?
    `).get(principalId, idempotencyKey) as { method: string; payload_hash: string; state: string; response_json: string | null; created_at: number; updated_at: number } | undefined;
    if (existing) {
      if (existing.method !== method || existing.payload_hash !== payloadHash) {
        const rowAge = Date.now() - existing.created_at;
        const existingPrefix = existing.payload_hash.slice(0, 8);
        const incomingPrefix = payloadHash.slice(0, 8);
        const keyFingerprint = fingerprint(idempotencyKey, 8);
        const principalFingerprint = fingerprint(principalId, 8);
        logWarn("request-ledger", `Conflict: method=${existing.method}→${method} key=${keyFingerprint}.. principal=${principalFingerprint}.. existing_hash=${existingPrefix}.. incoming_hash=${incomingPrefix}.. state=${existing.state} age=${rowAge}ms`);
        return { status: "conflict", message: "Idempotency key used with different method or payload" };
      }
      if (existing.state === "completed") {
        return { status: "completed", responseJson: existing.response_json! };
      }
      if (existing.state === "in_flight") {
        return { status: "in_flight" };
      }
      // reserved / dispatch_started / outcome_unknown rows are not live in
      // this process: the mutation may or may not have committed.
      return { status: "outcome_unknown" };
    }

    const now = Date.now();
    try {
      this.db.prepare(`
        INSERT INTO abmind_service_requests (principal_id, idempotency_key, method, payload_hash, state, response_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'reserved', NULL, ?, ?)
      `).run(principalId, idempotencyKey, method, payloadHash, now, now);
      return { status: "reserved" };
    } catch {
      return { status: "outcome_unknown" };
    }
  }

  markStarted(principalId: string, idempotencyKey: string): void {
    this.db.prepare(`
      UPDATE abmind_service_requests SET state = 'in_flight', updated_at = ?
      WHERE principal_id = ? AND idempotency_key = ? AND state = 'reserved'
    `).run(Date.now(), principalId, idempotencyKey);
  }

  complete(principalId: string, idempotencyKey: string, responseJson: string): void {
    this.db.prepare(`
      UPDATE abmind_service_requests SET state = 'completed', response_json = ?, updated_at = ?
      WHERE principal_id = ? AND idempotency_key = ?
    `).run(responseJson, Date.now(), principalId, idempotencyKey);
  }

  markUnknown(principalId: string, idempotencyKey: string): void {
    this.db.prepare(`
      UPDATE abmind_service_requests SET state = 'outcome_unknown', updated_at = ?
      WHERE principal_id = ? AND idempotency_key = ?
    `).run(Date.now(), principalId, idempotencyKey);
  }

  /** Transition rows left in flight by a crash to durable unknown tombstones. */
  recoverCrashed(): void {
    const result = this.db.prepare(`
      UPDATE abmind_service_requests SET state = 'outcome_unknown', updated_at = ?
      WHERE state = 'in_flight' OR state = 'dispatch_started' OR state = 'reserved'
    `).run(Date.now());
    const tombstones = this.db.prepare("SELECT COUNT(*) as c FROM abmind_service_requests WHERE state = 'outcome_unknown'").get() as { c: number };
    if (result.changes > 0 || tombstones.c > 0) {
      logWarn("request-ledger", `Recovered ${result.changes} crashed dispatch(es); ${tombstones.c} outcome_unknown tombstone(s) retained (never reusable)`);
    }
  }

  cleanup(): void {
    const cutoff = Date.now() - 30 * 24 * 3600_000;
    this.db.prepare(`
      DELETE FROM abmind_service_requests WHERE state = 'completed' AND updated_at < ?
    `).run(cutoff);

    const count = this.db.prepare("SELECT COUNT(*) as c FROM abmind_service_requests WHERE state = 'completed'").get() as { c: number };
    if (count.c > 10000) {
      this.db.prepare(`
        DELETE FROM abmind_service_requests WHERE rowid IN (
          SELECT rowid FROM abmind_service_requests WHERE state = 'completed'
          ORDER BY updated_at ASC LIMIT ?
        )
      `).run(count.c - 10000);
    }
  }
}
