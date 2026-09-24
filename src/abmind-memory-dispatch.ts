import type Database from "better-sqlite3";
import type {
  AbmindMethodMap, AbmindErrorBodyV1, ServiceCallContext,
  ProjectConversationContextInputV1, ProjectConversationContextOutputV1,
  PrepareConversationCompactionInputV1, PrepareConversationCompactionOutputV1,
  CommitConversationCompactionInputV1, CommitConversationCompactionOutputV1,
  DreamQuestionsNextPendingInput, DreamQuestionsListInput,
  DreamQuestionsMarkAskedInput, DreamQuestionsDismissInput,
} from "./abmind-protocol.js";
import { errorBodyV1 } from "./abmind-protocol.js";
import type {
  EffectivePrivateMutationContext, PrivateMutationStatusV1,
  EditPrivateMemoryInputV1, ReclassifyPrivateMemoryInputV1,
  AdjustPrivateRelevanceInputV1, CascadeDeletePrivateMessagesInputV1,
  MergePrivateMemoriesInputV1, InstantStoreParams,
} from "./mem-types.js";
import type { AttributionInputV1 } from "./recall-attribution.js";
import type { MemoryManager } from "./memory-manager.js";
import { getMemoryDb } from "./memory-manager.js";
import type {
  FindSealedSecretsInput, ResolveSealedSecretInput,
  SealedSecretRefV1, ResolveSealedSecretResult,
} from "./sealed-secret-service.js";
import { DreamQuestionStore } from "./dream-question-store.js";
import type {
  NextPendingResult, ListResult,
  MarkAskedResult, DismissResult,
} from "./dream-question-store.js";
import { ContextProjector, ContextProjectionError } from "./context-projector.js";
import type { ContextCompactionService } from "./context-compaction.js";
import { logDebug, logInfo } from "./mem-logger.js";
import { redactSecrets } from "./redact-secrets.js";
import { buildSessionStartContext } from "./session-context.js";

// ── Private-memory domain handlers (#1695) ─────────────────────────────────
// Domain logic for private.* methods, extracted from AbmindService. Each
// handler takes the manager (or a narrow dependency) plus a method-accurate
// input; the service holds the single routing cast per method. Handlers never
// touch the ledger, never decide idempotency, and never build top-level
// protocol responses — they throw PrivateMutationError for typed failures.

/** Custom error that can carry a typed conflict response. */
export class PrivateMutationError extends Error {
  constructor(readonly errorBody: AbmindErrorBodyV1) {
    super(errorBody.message);
    this.name = "PrivateMutationError";
  }
}

function buildPrivateMutationContext(context: ServiceCallContext, payload: { userId?: string }): EffectivePrivateMutationContext {
  return {
    userId: payload.userId ?? context.principalId,
    actorId: context.principalId,
    operationKey: `srv-${context.principalId}-${Date.now()}`,
    canDeclassifySecret: context.capabilities?.has("private_declassify") === true,
    origin: context.authenticatedBy === "embedded" ? "local" : "remote",
  };
}

function storeOkOrThrow(storeResult: PrivateMutationStatusV1): void {
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
  throw new PrivateMutationError(error);
}

export async function dispatchPrivateRecall(
  manager: MemoryManager,
  params: Parameters<MemoryManager["recallSearch"]>[0],
): Promise<Awaited<ReturnType<MemoryManager["recallSearch"]>>> {
  // #1837 — recall entry: bounded params in, bounded outcome out.
  logDebug("recall", `entry: query="${redactSecrets(params.translated.join(" ")).slice(0, 60)}" limit=${params.limit ?? "?"} stages=[${params.stages?.join(",") ?? "all"}] fastPath=${params.fastPath ? "yes" : "no"}`);
  const result = await manager.recallSearch(params);
  logDebug("recall", `exit: ${result.results.length} results stages: ${Object.entries(result.stages).map(([k, v]) => `${k}:${v.hits.length}`).join(" ")} decision=${result.decision?.outcome ?? "none"}`);
  return result;
}

export function dispatchPrivateAttribution(
  manager: MemoryManager,
  input: AttributionInputV1,
): Promise<AbmindMethodMap["private.attribution"]["output"]> {
  return manager.attribution(input);
}

export async function dispatchPrivateInstantStore(
  manager: MemoryManager,
  context: ServiceCallContext | undefined,
  input: InstantStoreParams,
): Promise<AbmindMethodMap["private.instantStore"]["output"]> {
  if (!context) throw new Error("Context required for private mutation");
  const ctx = buildPrivateMutationContext(context, input);
  const result = await manager.editor.instantStore({
    ...input,
    userId: ctx.userId,
    createdBy: ctx.actorId,
  });
  if (!result.stored) {
    // A typed instant-store rejection is a definitive pre-dispatch
    // failure: it never began a mutation.
    throw new PrivateMutationError(errorBodyV1(result.code, result.message, "pre_dispatch"));
  }
  return result;
}

export function dispatchPrivateEdit(
  manager: MemoryManager,
  context: ServiceCallContext | undefined,
  input: EditPrivateMemoryInputV1,
): AbmindMethodMap["private.edit"]["output"] {
  if (!context) throw new Error("Context required for private mutation");
  const ctx = buildPrivateMutationContext(context, input);
  const result = manager.editor.getMutationStore().edit(ctx, input);
  storeOkOrThrow(result);
  return {
    ...result,
    memoriesUpdated: 1,
    ids: [input.memoryId],
    semanticRevision: result.ok ? result.ref.semanticRevision : undefined,
  } as unknown as AbmindMethodMap["private.edit"]["output"];
}

export function dispatchPrivateReclassify(
  manager: MemoryManager,
  context: ServiceCallContext | undefined,
  input: ReclassifyPrivateMemoryInputV1,
): AbmindMethodMap["private.reclassify"]["output"] {
  if (!context) throw new Error("Context required for private mutation");
  const result = manager.editor.getMutationStore().reclassify(
    buildPrivateMutationContext(context, input), input,
  );
  storeOkOrThrow(result);
  return result;
}

export function dispatchPrivateAdjustRelevance(
  manager: MemoryManager,
  context: ServiceCallContext | undefined,
  input: AdjustPrivateRelevanceInputV1,
): AbmindMethodMap["private.adjustRelevance"]["output"] {
  if (!context) throw new Error("Context required for private mutation");
  const result = manager.editor.getMutationStore().adjustRelevance(
    buildPrivateMutationContext(context, input), input,
  );
  storeOkOrThrow(result);
  return result;
}

export function dispatchPrivateMerge(
  manager: MemoryManager,
  context: ServiceCallContext | undefined,
  input: MergePrivateMemoriesInputV1,
): AbmindMethodMap["private.merge"]["output"] {
  if (!context) throw new Error("Context required for private mutation");
  if (!input.first || !input.second) throw new Error("merge requires first and second refs");
  const ctx = buildPrivateMutationContext(context, input);
  const result = manager.editor.getMutationStore().merge(ctx, {
    userId: ctx.userId,
    first: { memoryId: input.first.memoryId, semanticRevision: input.first.semanticRevision },
    second: { memoryId: input.second.memoryId, semanticRevision: input.second.semanticRevision },
  });
  storeOkOrThrow(result);
  return result;
}

export function dispatchPrivateCascadeDelete(
  manager: MemoryManager,
  context: ServiceCallContext | undefined,
  input: CascadeDeletePrivateMessagesInputV1,
): AbmindMethodMap["private.cascadeDelete"]["output"] {
  if (!context) throw new Error("Context required for private mutation");
  const ctx = buildPrivateMutationContext(context, input);
  return manager.editor.getMutationStore().cascadeDelete(ctx, input);
}

export function dispatchPrivateRebuildFts(
  manager: MemoryManager,
): AbmindMethodMap["private.rebuildFts"]["output"] {
  return manager.rebuildFtsIndexes();
}

export async function dispatchPrivateEmbed(
  manager: MemoryManager,
  input: AbmindMethodMap["private.embed"]["input"],
): Promise<AbmindMethodMap["private.embed"]["output"]> {
  const provider = manager.getEmbeddingProvider();
  if (!provider) throw new Error("Embeddings are not configured");
  const vectors = await provider.batchEmbed(input.texts);
  return { vectors: vectors.map(v => v ? Array.from(v) : null), model: provider.name };
}

export async function dispatchFindSealedSecrets(
  manager: MemoryManager,
  context: ServiceCallContext | undefined,
  input: FindSealedSecretsInput,
): Promise<SealedSecretRefV1[]> {
  const auth = context?.authenticatedBy;
  if (auth !== "embedded" && auth !== "local_peer") {
    throw new PrivateMutationError(errorBodyV1("unauthorized", "Sealed search requires a local trusted context", "pre_dispatch"));
  }
  const db = getMemoryDb(manager);
  if (!db) throw new PrivateMutationError(errorBodyV1("unavailable", "Memory is not initialized", "pre_dispatch"));
  const { findSealedSecrets } = await import("./sealed-secret-service.js");
  return findSealedSecrets(db, input);
}

export async function dispatchResolveSealedSecret(
  manager: MemoryManager,
  context: ServiceCallContext | undefined,
  input: ResolveSealedSecretInput,
): Promise<ResolveSealedSecretResult> {
  // #1660: plaintext resolution is not model-callable and is unavailable
  // to signed peers, Dreamy, scheduled/swarm workers, peer-originated
  // sessions and missing-session contexts. Rejected again here even if a
  // forged frame bypasses capability negotiation.
  const auth = context?.authenticatedBy;
  if (auth !== "embedded" && auth !== "local_peer") {
    throw new PrivateMutationError(errorBodyV1("unauthorized", "Sealed resolution requires a local trusted context", "pre_dispatch"));
  }
  const db = getMemoryDb(manager);
  if (!db) throw new PrivateMutationError(errorBodyV1("unavailable", "Memory is not initialized", "pre_dispatch"));
  const { resolveSealedSecret } = await import("./sealed-secret-service.js");
  return resolveSealedSecret(db, input);
}

export function dispatchRecordMessage(
  manager: MemoryManager,
  input: Parameters<MemoryManager["recordMessage"]>[0],
): AbmindMethodMap["private.recordMessage"]["output"] {
  const id = manager.recordMessage(input);
  return { id };
}

export function dispatchGetRecentConversation(
  manager: MemoryManager,
  input: AbmindMethodMap["private.getRecentConversation"]["input"],
): AbmindMethodMap["private.getRecentConversation"]["output"] {
  return manager.getRecentConversation(input.userId, input.since, input.limit);
}

export function dispatchAssembleSessionContext(
  manager: MemoryManager,
  input: AbmindMethodMap["private.assembleSessionContext"]["input"],
): AbmindMethodMap["private.assembleSessionContext"]["output"] {
  const includeHistory = input.includeHistory ?? true;
  const modelContextTokens = input.modelContextTokens == null ? undefined : Math.floor(input.modelContextTokens);
  const session = includeHistory
    ? buildSessionStartContext(manager, input.userId, modelContextTokens)
    : { text: null as string | null, stats: { messages: 0, dailies: 0, weeklies: 0, quarterlies: 0, usedBytes: 0, budget: 0 } };
  if (includeHistory) {
    logInfo("session-context",
      `modelContextTokens=${modelContextTokens ?? 128000} historyBudgetChars=${session.stats.budget} usedChars=${session.stats.usedBytes} ` +
      `pairs=${session.stats.messages} dailies=${session.stats.dailies} weeklies=${session.stats.weeklies} quarterlies=${session.stats.quarterlies}`);
  }
  return {
    wakeUp: manager.buildWakeUp(input.userId, input.wakeUpMaxChars),
    recall: session.text ?? "",
    coreKnowledge: manager.readCoreKnowledge(),
    soulBundle: manager.getSessionBundle(),
  };
}

export function dispatchGetRuntimeStatus(
  manager: MemoryManager,
  input: AbmindMethodMap["private.getRuntimeStatus"]["input"],
): AbmindMethodMap["private.getRuntimeStatus"]["output"] {
  return manager.getStats(input.userId);
}

export function dispatchGetCoreKnowledge(
  manager: MemoryManager,
): AbmindMethodMap["private.getCoreKnowledge"]["output"] {
  return manager.readCoreKnowledge();
}

export function dispatchRecordFeedback(
  manager: MemoryManager,
  input: AbmindMethodMap["private.recordFeedback"]["input"],
): void {
  if (!manager.hasExtractedMemoryForUser(input.memoryId, input.userId)) {
    throw new Error("Memory no longer belongs to the authenticated user");
  }
  if (input.feedbackType === "cite") manager.bumpCitedCount([input.memoryId], input.userId);
  else manager.bumpRejectedCount([input.memoryId], input.userId);
  return undefined;
}

/**
 * #1527: daemon-owned durable context projection. Authorization is enforced
 * by the projector against the cursor row (user + session) and the
 * mixed-owner invariant. Rejections are bounded and content-free.
 */
export function dispatchContextProjection(
  manager: MemoryManager,
  input: ProjectConversationContextInputV1,
): ProjectConversationContextOutputV1 {
  const db = getMemoryDb(manager);
  if (!db) {
    throw new PrivateMutationError(errorBodyV1("unavailable", "Memory is not initialized", "pre_dispatch"));
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
      throw new PrivateMutationError(errorBodyV1(code, message, "pre_dispatch"));
    }
    throw err;
  }
}

/**
 * #1406: bounded, owner-scoped compaction prepare. The candidate is derived
 * inside the daemon from append-only durable rows; the caller summarizes it
 * provider-side and returns a proposed summary for server-side commit.
 */
export function dispatchPrepareCompaction(
  manager: MemoryManager,
  getCompactionService: (db: Database.Database) => ContextCompactionService,
  input: PrepareConversationCompactionInputV1,
): PrepareConversationCompactionOutputV1 {
  const db = getMemoryDb(manager);
  if (!db) {
    throw new PrivateMutationError(errorBodyV1("unavailable", "Memory is not initialized", "pre_dispatch"));
  }
  return getCompactionService(db).prepare(input);
}

/**
 * #1406: transactional checkpoint commit with generation CAS. Outcome is
 * data (committed/stale/rejected), never a fake success.
 */
export function dispatchCommitCompaction(
  manager: MemoryManager,
  getCompactionService: (db: Database.Database) => ContextCompactionService,
  input: CommitConversationCompactionInputV1,
): CommitConversationCompactionOutputV1 {
  const db = getMemoryDb(manager);
  if (!db) {
    throw new PrivateMutationError(errorBodyV1("unavailable", "Memory is not initialized", "pre_dispatch"));
  }
  return getCompactionService(db).commit(input);
}

function requireDreamStore(manager: MemoryManager): DreamQuestionStore {
  const db = getMemoryDb(manager);
  if (!db) {
    throw new PrivateMutationError(errorBodyV1("unavailable", "Memory is not initialized", "pre_dispatch"));
  }
  return new DreamQuestionStore(db);
}

/**
 * #1515: owner-scoped dream-question methods. Every mutation is a single-row
 * CAS whose outcome is data (asked/conflict/not_found, dismissed/
 * already_terminal/not_found); owner mismatch never reveals row existence.
 */
export function dispatchDreamNextPending(
  manager: MemoryManager,
  input: DreamQuestionsNextPendingInput,
): NextPendingResult {
  return requireDreamStore(manager).nextPending(input.userId);
}

export function dispatchDreamList(
  manager: MemoryManager,
  input: DreamQuestionsListInput,
): ListResult {
  return requireDreamStore(manager).list(input.userId, input.status, input.limit);
}

export function dispatchDreamMarkAsked(
  manager: MemoryManager,
  input: DreamQuestionsMarkAskedInput,
): MarkAskedResult {
  return requireDreamStore(manager).markAsked(input.userId, input.questionId, input.deliveryKey);
}

export function dispatchDreamDismiss(
  manager: MemoryManager,
  input: DreamQuestionsDismissInput,
): DismissResult {
  return requireDreamStore(manager).dismiss(input.userId, input.questionId);
}
