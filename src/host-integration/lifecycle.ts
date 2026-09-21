import type { MemoryManager } from "../memory-manager.js";
import { validateIdentity, canAutoWrite, buildProvenance } from "./identity.js";
import { renderWakeUp, renderRecallContextCounted } from "./render.js";
import type { FastPathIntent } from "../recall-engine.js";
import type {
  ExecutionIdentity,
  HostLifecycleOptions,
  AutomaticRecallPolicy,
  StartSessionInput,
  StartSessionResult,
  PrepareTurnInput,
  PrepareTurnResult,
  CompleteTurnInput,
  CompleteTurnResult,
  ExplicitRecallInput,
  RecallOperationResult,
  ExplicitStoreInput,
  CheckpointInput,
  CheckpointResult,
  HostDiagnostic,
  TurnAuthor,
  RecallHit,
} from "./types.js";
import { NON_PRIMARY_ORIGINS } from "./types.js";

function clampPolicy(policy: AutomaticRecallPolicy): Required<AutomaticRecallPolicy> {
  return {
    limit: Math.max(1, Math.min(50, Math.floor(policy.limit))),
    maxChars: Math.max(1, Math.floor(policy.maxChars)),
    minScore: policy.minScore !== undefined ? Math.max(0, Math.min(1, policy.minScore)) : 0,
    maxClassification: policy.maxClassification !== undefined
      ? (Math.min(2, Math.max(0, Math.floor(policy.maxClassification))) as 0 | 1 | 2)
      : 2,
  };
}

function makeDiagnostic(operation: string, code: string, message: string): HostDiagnostic {
  return { operation, code, message };
}

/**
 * #1813 — build the recall fast-path intent from lifecycle input. Turn
 * identity comes from the validated ExecutionIdentity, never from free-form
 * caller fields; only the question, language, and delivered refs are
 * caller-supplied (and re-verified owner-side).
 */
function buildFastPath(
  identity: ExecutionIdentity,
  fastPath: PrepareTurnInput["fastPath"],
): FastPathIntent | undefined {
  if (!fastPath) return undefined;
  return {
    question: fastPath.question,
    answerLanguage: fastPath.answerLanguage ?? "en",
    principal: identity.principalId,
    session: identity.conversationId,
    turn: identity.executionId,
    delivered: fastPath.delivered ?? [],
    ...(fastPath.releaseScope === true ? { releaseScope: true as const } : {}),
  };
}

export class HostMemoryLifecycle {
  private memory: MemoryManager;
  private options: HostLifecycleOptions;

  constructor(memory: MemoryManager, options: HostLifecycleOptions) {
    this.memory = memory;
    this.options = {
      writerId: options.writerId,
      failOpen: options.failOpen !== false,
    };
  }

  /**
   * #1383 — checkpoint evidence session for an identity. Execution-scoped so
   * equal text in two distinct turns never conflates, durable across restart,
   * and separable from real conversation sessions.
   */
  private checkpointSessionFor(identity: ExecutionIdentity): string {
    return `${identity.conversationId}:precompress:${identity.executionId}:g${identity.generation ?? 0}`;
  }

  /**
   * #1383 — keep a source ref only when it is an eligible extracted memory:
   * both id and revision present and owned by the principal. Raw-message
   * hits never acquire invented IDs. Pass the engine signal through as kind.
   */
  private gateRefs(
    hits: ReadonlyArray<{ id?: number; semanticRevision?: number; source?: string }>,
    userId: string,
  ): Array<{ id?: number; revision?: number; kind?: string }> {
    return hits.map(h => {
      const eligible = h.id !== undefined
        && h.semanticRevision !== undefined
        && this.memory.hasExtractedMemoryForUser(h.id, userId);
      return {
        ...(eligible ? { id: h.id as number, revision: h.semanticRevision as number } : {}),
        ...(typeof h.source === "string" && h.source ? { kind: h.source } : {}),
      };
    });
  }

  /**
   * #1383 — one owner capture path shared by completed turns and checkpoints.
   * Evidence identity is (session, role, content) within the execution-scoped
   * checkpoint lineage: checkpoint retries converge, and completion skips
   * content already checkpointed for the same execution instead of inserting
   * it twice. Exact-match only; partial prose overlap is reported, not merged.
   */
  private captureIntoSession(opts: {
    userId: string;
    targetSession: string;
    dedupSession: string;
    executionLabel: string;
    messages: ReadonlyArray<{ role: "user" | "assistant"; content: string; timestamp?: number }>;
  }): { ids: number[]; reconciled: number; rejected: number } {
    const ids: number[] = [];
    let reconciled = 0;
    let rejected = 0;
    const now = Date.now();
    let known: Set<string> | null = null;
    const knownSet = (): Set<string> => {
      if (known === null) {
        known = new Set();
        try {
          const rows = this.memory.loadRecentMessages(opts.userId, opts.dedupSession, 200);
          for (const r of rows) known.add(`${r.role}\n${r.content}`);
        } catch {
          known = new Set();
        }
      }
      return known;
    };
    for (const msg of opts.messages.slice(0, 50)) {
      const content = msg.content?.trim() ?? "";
      if ((msg.role !== "user" && msg.role !== "assistant") || !content) {
        rejected++;
        continue;
      }
      if (knownSet().has(`${msg.role}\n${content}`)) {
        reconciled++;
        continue;
      }
      const id = this.memory.recordMessage({
        userId: opts.userId,
        sessionId: opts.targetSession,
        role: msg.role,
        content,
        timestamp: msg.timestamp ?? now,
      });
      if (id !== null) {
        ids.push(id);
        knownSet().add(`${msg.role}\n${content}`);
      } else {
        rejected++;
      }
    }
    return { ids, reconciled, rejected };
  }

  async startSession(input: StartSessionInput): Promise<StartSessionResult> {
    try {
      const { identity, diagnostics: idDiag } = validateIdentity(input.identity);
      const allDiags: HostDiagnostic[] = [...idDiag];

      if (idDiag.length > 0) {
        return { ok: false, context: "", diagnostics: allDiags };
      }

      const maxChars = Math.max(1, Math.floor(input.maxChars));
      const context = renderWakeUp(this.memory, maxChars, identity.principalId);
      return { ok: true, context, diagnostics: allDiags };
    } catch (err) {
      return this.fail<StartSessionResult>("startSession", err);
    }
  }

  async prepareTurn(input: PrepareTurnInput): Promise<PrepareTurnResult> {
    try {
      const { identity, diagnostics: idDiag } = validateIdentity(input.identity);
      const allDiags: HostDiagnostic[] = [...idDiag];

      if (idDiag.length > 0) {
        return { context: "", hits: [], rendered: 0, diagnostics: allDiags };
      }

      const policy = clampPolicy(input.policy);

      const result = await this.memory.recallSearch({
        translated: [...input.query.translated],
        original: input.query.original,
        userId: identity.principalId,
        limit: policy.limit,
        maxClassification: policy.maxClassification,
        fastPath: buildFastPath(identity, input.fastPath),
      });

      const gated = this.gateRefs(result.results, identity.principalId);
      const hits: RecallHit[] = result.results
        .map((h, i) => ({
          content: h.content,
          date: h.date,
          score: h.score,
          classification: h.classification,
          ...gated[i],
        }))
        .filter(h => h.score >= policy.minScore);

      const rendered = renderRecallContextCounted(hits, policy.maxChars);

      return { context: rendered.text, hits, rendered: rendered.rendered, diagnostics: allDiags, ...(result.decision ? { decision: result.decision } : {}) };
    } catch (err) {
      return this.fail<PrepareTurnResult>("prepareTurn", err, { context: "", hits: [], rendered: 0, diagnostics: [] });
    }
  }

  completeTurn(input: CompleteTurnInput): CompleteTurnResult {
    try {
      const { identity, diagnostics: idDiag } = validateIdentity(input.identity);
      if (idDiag.length > 0) {
        return { status: "failed", diagnostic: idDiag[0]! };
      }

      if (!canAutoWrite(identity, this.options.writerId)) {
        return { status: "skipped", reason: "not_owner" };
      }

      if (NON_PRIMARY_ORIGINS.has(identity.origin)) {
        return { status: "skipped", reason: "not_owner" };
      }

      // Late arrivals keep their own execution: resolve from the call, never
      // rebind to whatever turn is latest. Author is echoed, never inferred.
      const executionId = input.executionId?.trim() || identity.executionId;
      const author: TurnAuthor | undefined =
        input.author !== undefined
          ? {
              ...(typeof input.author.id === "string" && input.author.id ? { id: input.author.id } : {}),
              ...(typeof input.author.name === "string" && input.author.name ? { name: input.author.name } : {}),
            }
          : undefined;

      const now = Date.now();
      const messages: Array<{ role: "user" | "assistant"; content: string; timestamp?: number }> = [];
      if (input.user?.content?.trim()) {
        messages.push({ role: "user", content: input.user.content, timestamp: input.user.timestamp ?? now - 1 });
      }
      if (input.assistant?.content?.trim()) {
        messages.push({ role: "assistant", content: input.assistant.content, timestamp: input.assistant.timestamp ?? now });
      }
      if (messages.length === 0) {
        return { status: "skipped", reason: "empty" };
      }

      const captured = this.captureIntoSession({
        userId: identity.principalId,
        targetSession: identity.conversationId,
        dedupSession: this.checkpointSessionFor({ ...identity, executionId }),
        executionLabel: executionId,
        messages,
      });

      if (captured.ids.length === 0) {
        return { status: "skipped", reason: "rejected" };
      }

      return {
        status: "recorded",
        messageIds: captured.ids,
        reconciled: captured.reconciled,
        executionId,
        ...(author !== undefined ? { author } : {}),
      };
    } catch (err) {
      return this.fail<CompleteTurnResult>("completeTurn", err);
    }
  }

  async recall(input: ExplicitRecallInput): Promise<RecallOperationResult> {
    try {
      const { identity, diagnostics: idDiag } = validateIdentity(input.identity);
      const allDiags: HostDiagnostic[] = [...idDiag];

      if (idDiag.length > 0) {
        return { context: "", hits: [], rendered: 0, diagnostics: allDiags };
      }

      const limit = input.limit !== undefined ? Math.max(1, Math.min(50, Math.floor(input.limit))) : 5;
      const maxClassification = input.maxClassification !== undefined
        ? Math.max(0, Math.min(3, Math.floor(input.maxClassification)))
        : undefined;

      const result = await this.memory.recallSearch({
        translated: [...input.query.translated],
        original: input.query.original,
        userId: identity.principalId,
        limit,
        maxClassification,
        fastPath: buildFastPath(identity, input.fastPath),
      });

      const gated = this.gateRefs(result.results, identity.principalId);
      const hits: RecallHit[] = result.results
        .map((h, i) => ({
          content: h.content,
          date: h.date,
          score: h.score,
          classification: h.classification,
          ...gated[i],
        }))
        .filter(h => input.minScore === undefined || h.score >= input.minScore);

      const rendered = renderRecallContextCounted(hits, 10000);

      return { context: rendered.text, hits, rendered: rendered.rendered, diagnostics: allDiags, ...(result.decision ? { decision: result.decision } : {}) };
    } catch (err) {
      return this.fail<RecallOperationResult>("recall", err, { context: "", hits: [], rendered: 0, diagnostics: [] });
    }
  }

  async store(input: ExplicitStoreInput): Promise<import("../mem-types.js").InstantStoreResult> {
    try {
      const { identity } = validateIdentity(input.identity);

      return await this.memory.editor.instantStore({
        userId: identity.principalId,
        contentEn: input.contentEn,
        contentOriginal: input.contentOriginal,
        memoryType: input.memoryType,
        emotionScore: input.emotionScore,
        emotionTags: input.emotionTags,
        emotionContext: input.emotionContext,
        keyword: input.keyword,
        confidence: input.confidence,
        sourceMessageIds: input.sourceMessageIds,
        classification: input.classification,
        trust: input.trust,
        integrity: input.integrity,
        credibility: input.credibility,
        topic: input.topic,
        createdBy: buildProvenance(identity, this.options.writerId, "store"),
      });
    } catch (err) {
      return this.fail<import("../mem-types.js").InstantStoreResult>("store", err, {
        stored: false, memoriesCount: 0, code: "unavailable", message: String(err),
      });
    }
  }

  /**
   * #1383 — durably checkpoint uncommitted host evidence (pre-compress).
   * Messages are recorded under a checkpoint-marked session derived from the
   * conversation, so later extraction can find them without mistaking them
   * for completed conversational turns. Returns the message IDs as the
   * durable acknowledgment; strict-mode callers treat anything else as a
   * failed checkpoint and retain their transcript. Bounded: at most 50
   * messages; empty or fully rejected input reports skipped, never success.
   */
  checkpoint(input: CheckpointInput): CheckpointResult {
    try {
      const { identity, diagnostics: idDiag } = validateIdentity(input.identity);
      if (idDiag.length > 0) {
        return { status: "failed", diagnostic: idDiag[0]! };
      }

      if (!canAutoWrite(identity, this.options.writerId)) {
        return { status: "skipped", reason: "not_owner" };
      }

      if (NON_PRIMARY_ORIGINS.has(identity.origin)) {
        return { status: "skipped", reason: "not_owner" };
      }

      // Evidence rows carry role/content/timestamp only: historical rows are
      // never attributed to the current author. Checkpoint and completion
      // share captureIntoSession, so retries converge instead of duplicating.
      const captured = this.captureIntoSession({
        userId: identity.principalId,
        targetSession: this.checkpointSessionFor(identity),
        dedupSession: this.checkpointSessionFor(identity),
        executionLabel: identity.executionId,
        messages: input.messages,
      });

      if (captured.ids.length === 0) {
        return { status: "skipped", reason: input.messages.length === 0 ? "empty" : "all_rejected" };
      }
      return {
        status: "checkpointed",
        messageIds: captured.ids,
        rejected: captured.rejected,
        executionId: identity.executionId,
      };
    } catch (err) {
      return this.fail<CheckpointResult>("checkpoint", err);
    }
  }

  private fail<T>(operation: string, err: unknown, fallback?: T): T {
    const diagnostic = makeDiagnostic(
      operation,
      err instanceof Error ? err.name : "UNKNOWN",
      err instanceof Error ? err.message : String(err),
    );

    if (!this.options.failOpen) throw err;

    if (fallback !== undefined) return fallback;

    if (operation === "startSession") {
      return { ok: false, context: "", diagnostics: [diagnostic] } as unknown as T;
    }
    if (operation === "completeTurn" || operation === "checkpoint") {
      return { status: "failed", diagnostic } as unknown as T;
    }
    return { context: "", hits: [], diagnostics: [diagnostic] } as unknown as T;
  }
}
