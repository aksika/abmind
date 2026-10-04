import type {
  AbmindMethod, AbmindMethodMap, AbmindRequestV1, AbmindErrorBodyV1,
} from "./abmind-protocol.js";
import {
  ABMIND_PROTOCOL_VERSION, METHOD_REGISTRY, REQUEST_MAX_BYTES,
  REQUEST_ID_MAX, IDEMPOTENCY_KEY_MAX,
  SESSION_ORIGIN_MAX, PRINCIPAL_ID_MAX, CONTEXT_SESSION_ID_MAX,
  QUESTION_ID_MAX, DELIVERY_KEY_MAX,
} from "./abmind-protocol.js";

// ── Request validation (#1695) ─────────────────────────────────────────────
// Pure functions extracted from AbmindService. They report failure codes and
// messages; the service still builds protocol responses (via this.err), so
// failure stage and message text cannot drift by moving them here.

export type EnvelopeFailure = {
  ok: false;
  code: AbmindErrorBodyV1["code"];
  message: string;
};

export type EnvelopeResult<K extends AbmindMethod> =
  | { ok: true; method: K; payload: AbmindMethodMap[K]["input"] }
  | EnvelopeFailure;

/** Envelope admission: version, method, request ID, context, payload size. */
export function parseEnvelope<K extends AbmindMethod>(
  request: AbmindRequestV1<K>,
): EnvelopeResult<K> {
  if (request.version !== ABMIND_PROTOCOL_VERSION) {
    return { ok: false, code: "unsupported_version", message: `Unsupported protocol version: ${request.version}` };
  }

  if (!request.method) {
    return { ok: false, code: "unsupported_method", message: "Method is required" };
  }

  const entry = METHOD_REGISTRY[request.method];
  if (!entry) {
    return { ok: false, code: "unsupported_method", message: `Unsupported method: ${request.method}` };
  }

  if (typeof request.requestId !== "string" || request.requestId.length > REQUEST_ID_MAX) {
    return { ok: false, code: "validation_error", message: "Invalid or oversized requestId" };
  }

  if (request.idempotencyKey != null && (typeof request.idempotencyKey !== "string" || request.idempotencyKey.length > IDEMPOTENCY_KEY_MAX)) {
    return { ok: false, code: "validation_error", message: "Invalid or oversized idempotencyKey" };
  }

  if (request.context) {
    if (typeof request.context !== "object" || request.context === null) {
      return { ok: false, code: "validation_error", message: "context must be an object" };
    }
    if (request.context.sessionId != null && (typeof request.context.sessionId !== "string" || request.context.sessionId.length > SESSION_ORIGIN_MAX)) {
      return { ok: false, code: "validation_error", message: "Invalid sessionId" };
    }
    if (request.context.origin != null && (typeof request.context.origin !== "string" || request.context.origin.length > SESSION_ORIGIN_MAX)) {
      return { ok: false, code: "validation_error", message: "Invalid origin" };
    }
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(request.payload);
  } catch {
    return { ok: false, code: "validation_error", message: "Payload must be JSON-serializable" };
  }
  if (typeof serialized !== "string") {
    return { ok: false, code: "validation_error", message: "Payload is required" };
  }
  if (Buffer.byteLength(serialized, "utf-8") > Math.min(REQUEST_MAX_BYTES, entry.maxInputBytes)) {
    return { ok: false, code: "validation_error", message: "Request payload exceeds maximum size" };
  }

  return { ok: true, method: request.method, payload: request.payload as AbmindMethodMap[K]["input"] };
}

// ── Per-method payload validators (#1885) ──────────────────────────────────
// One pure function per method with rules; methods without per-method rules
// share the pass-through no-op, reproducing exactly the old switch fall-through
// (which applied only the private./operational. object-shape gate in
// validatePayload below). Adding real field checks to a no-op entry would
// reject payloads current callers send and is a behavior change, not a refactor.

type PayloadValidator = (payload: unknown) => string | null;

function payloadRequiredString(p: Record<string, unknown>, name: string): string | null {
  return typeof p[name] === "string" && (p[name] as string).trim().length > 0 ? null : `${name} must be a non-empty string`;
}

function isFiniteNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

/** Pass-through reproducing the old `default: return null` acceptance. */
const acceptAnyPayload: PayloadValidator = () => null;

function validateRecallPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  const userError = payloadRequiredString(p, "userId");
  if (userError) return userError;
  if (!Array.isArray(p.translated) || p.translated.some((v) => typeof v !== "string")) {
    return "translated must be an array of strings";
  }
  return null;
}

function validateWorthRetrievingPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  const userError = payloadRequiredString(p, "userId");
  if (userError) return userError;
  // Missing/empty original is a search verdict in the engine, not a
  // validation error: failure must favor searching, never a rejection.
  if (p.original !== undefined && typeof p.original !== "string") {
    return "original must be a string";
  }
  return null;
}

function validateInstantStorePayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  // #1660: class-3 sealed stores carry the label in sealedLabel, not
  // contentEn; contentEn is required only for class 0-2.
  if (payloadRequiredString(p, "userId")) return payloadRequiredString(p, "userId");
  if (!Number.isSafeInteger(p.classification ?? 1) || (p.classification as number | undefined ?? 1) < 0 || (p.classification as number | undefined ?? 1) > 3) {
    return "classification must be 0-3";
  }
  if ((p.classification as number | undefined ?? 1) < 3 && payloadRequiredString(p, "contentEn")) return payloadRequiredString(p, "contentEn");
  if (payloadRequiredString(p, "contentOriginal")) return payloadRequiredString(p, "contentOriginal");
  return payloadRequiredString(p, "memoryType");
}

function validateEditPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  if (payloadRequiredString(p, "userId")) return payloadRequiredString(p, "userId");
  if (!Number.isSafeInteger(p.memoryId) || (p.memoryId as number) < 1) return "memoryId must be a positive integer";
  if (!Number.isSafeInteger(p.expectedRevision) || (p.expectedRevision as number) < 1) return "expectedRevision must be a positive integer";
  return null;
}

function validateReclassifyPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  if (payloadRequiredString(p, "userId")) return payloadRequiredString(p, "userId");
  if (!Number.isSafeInteger(p.memoryId) || (p.memoryId as number) < 1) return "memoryId must be a positive integer";
  if (!Number.isSafeInteger(p.expectedRevision) || (p.expectedRevision as number) < 1) return "expectedRevision must be a positive integer";
  if (!Number.isInteger(p.classification) || (p.classification as number) < 0 || (p.classification as number) > 3) return "classification must be 0-3";
  return null;
}

function validateAdjustRelevancePayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  if (payloadRequiredString(p, "userId")) return payloadRequiredString(p, "userId");
  if (!Number.isSafeInteger(p.memoryId) || (p.memoryId as number) < 1) return "memoryId must be a positive integer";
  if (!Number.isSafeInteger(p.expectedRevision) || (p.expectedRevision as number) < 1) return "expectedRevision must be a positive integer";
  return Number.isFinite(p.delta) ? null : "delta must be finite";
}

function validateMergePayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  if (payloadRequiredString(p, "userId")) return payloadRequiredString(p, "userId");
  if (!p.first || !p.second || typeof p.first !== "object" || typeof p.second !== "object") return "first and second refs are required";
  for (const name of ["first", "second"] as const) {
    const ref = p[name] as Record<string, unknown>;
    if (!Number.isSafeInteger(ref.memoryId) || (ref.memoryId as number) < 1) return `${name}.memoryId must be a positive integer`;
    if (!Number.isSafeInteger(ref.semanticRevision) || (ref.semanticRevision as number) < 1) return `${name}.semanticRevision must be a positive integer`;
  }
  return null;
}

function validateCascadeDeletePayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  if (payloadRequiredString(p, "userId")) return payloadRequiredString(p, "userId");
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

function validateLifecycleIdentityPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  if (typeof p.identity !== "object" || p.identity === null) {
    return "identity must be an object";
  }
  return null;
}

// #1383 — shape-level validation for lifecycle payloads. Semantic checks
// (identity fields, ownership, policy bounds) belong to the lifecycle
// service, which returns diagnostics-bearing results instead of errors.
function validateLifecycleStartSessionPayload(payload: unknown): string | null {
  const identityError = validateLifecycleIdentityPayload(payload);
  if (identityError) return identityError;
  const p = payload as Record<string, unknown>;
  return isFiniteNumber(p.maxChars) ? null : "maxChars must be a finite number";
}

function validateLifecyclePrepareTurnPayload(payload: unknown): string | null {
  const identityError = validateLifecycleIdentityPayload(payload);
  if (identityError) return identityError;
  const p = payload as Record<string, unknown>;
  const q = p.query as Record<string, unknown> | undefined;
  // #1908 — raw-turn callers need not supply keywords; supplied translated
  // terms are bounded hints when present.
  if (q !== undefined && !Array.isArray(q.translated)) return "query.translated must be an array of strings";
  const contextError = validateAmbientContextPayload(p.context);
  if (contextError) return contextError;
  const pol = p.policy as Record<string, unknown> | undefined;
  if (!pol || !isFiniteNumber(pol.limit) || !isFiniteNumber(pol.maxChars)) return "policy.limit and policy.maxChars must be finite numbers";
  return null;
}

function validateAmbientContextPayload(context: unknown): string | null {
  if (context === undefined) return null;
  if (!Array.isArray(context)) return "context must be an array of completed-turn snapshots";
  if (context.length > 8) return "context must contain at most 8 snapshots";
  for (const entry of context) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return "context entries must be objects";
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.text !== "string" || typeof e.principal !== "string"
      || typeof e.host !== "string" || typeof e.conversation !== "string") {
      return "context entries need string text, principal, host, and conversation";
    }
    if (e.text.length > 16384) return "context entry text must fit 16 KiB";
    if (typeof e.complete !== "boolean") return "context entries need a boolean complete flag";
  }
  return null;
}

function validateLifecycleRecallPayload(payload: unknown): string | null {
  const identityError = validateLifecycleIdentityPayload(payload);
  if (identityError) return identityError;
  const p = payload as Record<string, unknown>;
  const q = p.query as Record<string, unknown> | undefined;
  if (!q || !Array.isArray(q.translated)) return "query.translated must be an array of strings";
  return null;
}

function validateLifecycleStorePayload(payload: unknown): string | null {
  const identityError = validateLifecycleIdentityPayload(payload);
  if (identityError) return identityError;
  const p = payload as Record<string, unknown>;
  if (typeof p.contentEn !== "string" || !p.contentEn.trim()) return "contentEn must be a non-empty string";
  if (typeof p.contentOriginal !== "string" || !p.contentOriginal.trim()) return "contentOriginal must be a non-empty string";
  if (typeof p.memoryType !== "string" || !p.memoryType.trim()) return "memoryType must be a non-empty string";
  return null;
}

function validateLifecycleCheckpointPayload(payload: unknown): string | null {
  const identityError = validateLifecycleIdentityPayload(payload);
  if (identityError) return identityError;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.messages)) return "messages must be an array";
  if ((p.messages as unknown[]).length > 50) return "messages must contain at most 50 entries";
  return null;
}

function validateLifecycleObservePayload(payload: unknown): string | null {
  const identityError = validateLifecycleIdentityPayload(payload);
  if (identityError) return identityError;
  const p = payload as Record<string, unknown>;
  if (typeof p.eventId !== "string" || !p.eventId.trim()) return "eventId must be a non-empty string";
  if (typeof p.kind !== "string" || !p.kind.trim()) return "kind must be a non-empty string";
  return null;
}

function validateUserIdOnlyPayload(payload: unknown): string | null {
  return payloadRequiredString(payload as Record<string, unknown>, "userId");
}

function validateAssembleSessionContextPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  if (payloadRequiredString(p, "userId")) return payloadRequiredString(p, "userId");
  if (p["modelContextTokens"] !== undefined) {
    const v = p["modelContextTokens"];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 1) {
      return "modelContextTokens must be a positive finite number";
    }
  }
  if (p["wakeUpMaxChars"] !== undefined) {
    const v = p["wakeUpMaxChars"];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return "wakeUpMaxChars must be a finite number";
    }
  }
  if (p["includeHistory"] !== undefined && typeof p["includeHistory"] !== "boolean") {
    return "includeHistory must be a boolean";
  }
  return null;
}

function validateFindSealedSecretsPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  if (payloadRequiredString(p, "userId")) return payloadRequiredString(p, "userId");
  if (payloadRequiredString(p, "query")) return "query must be a non-empty string";
  if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || (p.limit as number) < 1 || (p.limit as number) > 25)) {
    return "limit must be an integer between 1 and 25";
  }
  return null;
}

function validateResolveSealedSecretPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  if (payloadRequiredString(p, "userId")) return payloadRequiredString(p, "userId");
  if (!Number.isSafeInteger(p.memoryId) || (p.memoryId as number) < 1) return "memoryId must be a positive integer";
  if (!Number.isSafeInteger(p.expectedRevision) || (p.expectedRevision as number) < 1) return "expectedRevision must be a positive integer";
  return null;
}

function validateRecordFeedbackPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  if (payloadRequiredString(p, "userId")) return payloadRequiredString(p, "userId");
  if (!Number.isSafeInteger(p.memoryId) || (p.memoryId as number) < 1) return "memoryId must be a positive integer";
  return p.feedbackType === "cite" || p.feedbackType === "reject" ? null : "feedbackType must be cite or reject";
}

function validateProjectConversationContextPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  const userIdError = payloadRequiredString(p, "userId");
  if (userIdError) return userIdError;
  if ((p.userId as string).length > PRINCIPAL_ID_MAX) return `userId exceeds ${PRINCIPAL_ID_MAX} characters`;
  const sessionIdError = payloadRequiredString(p, "sessionId");
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

function validatePrepareConversationCompactionPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  const userIdError = payloadRequiredString(p, "userId");
  if (userIdError) return userIdError;
  if ((p.userId as string).length > PRINCIPAL_ID_MAX) return `userId exceeds ${PRINCIPAL_ID_MAX} characters`;
  const sessionIdError = payloadRequiredString(p, "sessionId");
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

function validateCommitConversationCompactionPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  const userIdError = payloadRequiredString(p, "userId");
  if (userIdError) return userIdError;
  if ((p.userId as string).length > PRINCIPAL_ID_MAX) return `userId exceeds ${PRINCIPAL_ID_MAX} characters`;
  const sessionIdError = payloadRequiredString(p, "sessionId");
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

function validateDreamUserPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  const userIdError = payloadRequiredString(p, "userId");
  if (userIdError) return userIdError;
  if ((p.userId as string).length > PRINCIPAL_ID_MAX) return `userId exceeds ${PRINCIPAL_ID_MAX} characters`;
  return null;
}

function validateDreamNextPendingPayload(payload: unknown): string | null {
  return validateDreamUserPayload(payload);
}

function validateDreamListPayload(payload: unknown): string | null {
  const userError = validateDreamUserPayload(payload);
  if (userError) return userError;
  const p = payload as { limit?: unknown; status?: unknown };
  if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || (p.limit as number) < 1 || (p.limit as number) > 50)) {
    return "limit must be a safe integer within 1-50";
  }
  if (p.status !== undefined
    && !["pending", "asked", "resolved", "expired", "dismissed"].includes(p.status as string)) {
    return "status must be a valid lifecycle status";
  }
  return null;
}

function validateDreamMarkAskedPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  const userIdError = payloadRequiredString(p, "userId");
  if (userIdError) return userIdError;
  if ((p.userId as string).length > PRINCIPAL_ID_MAX) return `userId exceeds ${PRINCIPAL_ID_MAX} characters`;
  if (payloadRequiredString(p, "questionId")) return payloadRequiredString(p, "questionId");
  if ((p.questionId as string).length > QUESTION_ID_MAX) return `questionId exceeds ${QUESTION_ID_MAX} characters`;
  if (payloadRequiredString(p, "deliveryKey")) return payloadRequiredString(p, "deliveryKey");
  if ((p.deliveryKey as string).length > DELIVERY_KEY_MAX) return `deliveryKey exceeds ${DELIVERY_KEY_MAX} characters`;
  return null;
}

function validateDreamDismissPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  const userIdError = payloadRequiredString(p, "userId");
  if (userIdError) return userIdError;
  if ((p.userId as string).length > PRINCIPAL_ID_MAX) return `userId exceeds ${PRINCIPAL_ID_MAX} characters`;
  if (payloadRequiredString(p, "questionId")) return payloadRequiredString(p, "questionId");
  if ((p.questionId as string).length > QUESTION_ID_MAX) return `questionId exceeds ${QUESTION_ID_MAX} characters`;
  return null;
}

function validateEmbedPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.texts) || p.texts.length < 1 || p.texts.length > 100 || p.texts.some((v) => typeof v !== "string" || v.length > 8192)) {
    return "texts must contain 1-100 strings of at most 8192 characters";
  }
  return null;
}

function validateRepairPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  const validActions = ["rebuild_fts", "checkpoint_wal", "backfill_embeddings", "clear_corrupt_embeddings"];
  return validActions.includes(p.action as string) ? null : `unknown repair action: ${p.action}`;
}

// #1885: the validator map replaces the old per-method switch. It is
// exhaustive over AbmindMethod: adding or removing a registry method fails
// compilation until its entry is added or removed here.
const METHOD_VALIDATORS: { [K in AbmindMethod]: PayloadValidator } = {
  "system.negotiate": acceptAnyPayload,
  "system.health": acceptAnyPayload,
  "system.status": acceptAnyPayload,
  "system.capabilities": acceptAnyPayload,
  "private.recall": validateRecallPayload,
  "private.checkWorthRetrieving": validateWorthRetrievingPayload,
  "private.instantStore": validateInstantStorePayload,
  "private.edit": validateEditPayload,
  "private.reclassify": validateReclassifyPayload,
  "private.adjustRelevance": validateAdjustRelevancePayload,
  "private.merge": validateMergePayload,
  "private.cascadeDelete": validateCascadeDeletePayload,
  "private.rebuildFts": acceptAnyPayload,
  "private.embed": validateEmbedPayload,
  "private.findSealedSecrets": validateFindSealedSecretsPayload,
  "private.resolveSealedSecret": validateResolveSealedSecretPayload,
  "operational.submitDraft": acceptAnyPayload,
  "operational.listDrafts": acceptAnyPayload,
  "operational.getMemory": acceptAnyPayload,
  "operational.getHistory": acceptAnyPayload,
  "operational.promoteDraft": acceptAnyPayload,
  "operational.rejectDraft": acceptAnyPayload,
  "operational.revise": acceptAnyPayload,
  "operational.retire": acceptAnyPayload,
  "operational.recall": acceptAnyPayload,
  "private.recordMessage": validateUserIdOnlyPayload,
  "private.getRecentConversation": acceptAnyPayload,
  "private.assembleSessionContext": validateAssembleSessionContextPayload,
  "private.getRuntimeStatus": acceptAnyPayload,
  "private.getCoreKnowledge": validateUserIdOnlyPayload,
  "private.recordFeedback": validateRecordFeedbackPayload,
  "private.lifecycleStartSession": validateLifecycleStartSessionPayload,
  "private.lifecyclePrepareTurn": validateLifecyclePrepareTurnPayload,
  "private.lifecycleCompleteTurn": validateLifecycleIdentityPayload,
  "private.lifecycleRecall": validateLifecycleRecallPayload,
  "private.lifecycleStore": validateLifecycleStorePayload,
  "private.lifecycleCheckpoint": validateLifecycleCheckpointPayload,
  "private.lifecycleObserve": validateLifecycleObservePayload,
  "private.projectConversationContext": validateProjectConversationContextPayload,
  "private.prepareConversationCompaction": validatePrepareConversationCompactionPayload,
  "private.commitConversationCompaction": validateCommitConversationCompactionPayload,
  "private.dreamQuestions.nextPending": validateDreamNextPendingPayload,
  "private.dreamQuestions.list": validateDreamListPayload,
  "private.dreamQuestions.markAsked": validateDreamMarkAskedPayload,
  "private.dreamQuestions.dismiss": validateDreamDismissPayload,
  "sleep.start": acceptAnyPayload,
  "sleep.status": acceptAnyPayload,
  "sleep.resume": acceptAnyPayload,
  "sleep.cancel": acceptAnyPayload,
  "sleep.events": acceptAnyPayload,
  "sleep.runtime.open": acceptAnyPayload,
  "sleep.runtime.next": acceptAnyPayload,
  "sleep.runtime.complete": acceptAnyPayload,
  "sleep.runtime.fail": acceptAnyPayload,
  "sleep.runtime.close": acceptAnyPayload,
  "operator.diagnose": acceptAnyPayload,
  "operator.repair": validateRepairPayload,
};

export function validatePayload(method: AbmindMethod, payload: unknown): string | null {
  if (method.startsWith("private.") || method.startsWith("operational.")) {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return "Payload must be an object";
    }
  }

  return METHOD_VALIDATORS[method](payload);
}
