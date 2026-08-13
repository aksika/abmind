import type { MemoryManager } from "../memory-manager.js";
import { validateIdentity, canAutoWrite, buildProvenance } from "./identity.js";
import { renderWakeUp, renderRecallContext } from "./render.js";
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
  HostDiagnostic,
} from "./types.js";

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

  async startSession(input: StartSessionInput): Promise<StartSessionResult> {
    try {
      const { identity, diagnostics: idDiag } = validateIdentity(input.identity);
      const allDiags: HostDiagnostic[] = [...idDiag];

      if (idDiag.length > 0) {
        return { ok: false, context: "", diagnostics: allDiags };
      }

      const maxChars = Math.max(1, Math.floor(input.maxChars));
      const context = renderWakeUp(this.memory, maxChars);
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
        return { context: "", hits: [], diagnostics: allDiags };
      }

      const policy = clampPolicy(input.policy);

      const result = await this.memory.recallSearch({
        translated: [...input.query.translated],
        original: input.query.original,
        userId: identity.principalId,
        limit: policy.limit,
        maxClassification: policy.maxClassification,
      });

      const hits = result.results
        .filter(h => h.score >= policy.minScore)
        .map(h => ({
          content: h.content,
          date: h.date,
          score: h.score,
          classification: h.classification,
        }));

      const context = renderRecallContext(hits, policy.maxChars);

      return { context, hits, diagnostics: allDiags };
    } catch (err) {
      return this.fail<PrepareTurnResult>("prepareTurn", err, { context: "", hits: [], diagnostics: [] });
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

      if (!input.user?.content?.trim() && !input.assistant?.content?.trim()) {
        return { status: "skipped", reason: "empty" };
      }

      const messageIds: number[] = [];
      const now = Date.now();

      if (input.user?.content?.trim()) {
        const id = this.memory.recordMessage({
          userId: identity.principalId,
          sessionId: identity.conversationId,
          role: "user",
          content: input.user.content,
          timestamp: input.user.timestamp ?? now - 1,
        });
        if (id !== null) messageIds.push(id);
      }

      if (input.assistant?.content?.trim()) {
        const id = this.memory.recordMessage({
          userId: identity.principalId,
          sessionId: identity.conversationId,
          role: "assistant",
          content: input.assistant.content,
          timestamp: input.assistant.timestamp ?? now,
        });
        if (id !== null) messageIds.push(id);
      }

      if (messageIds.length === 0) {
        return { status: "skipped", reason: "rejected" };
      }

      return { status: "recorded", messageIds };
    } catch (err) {
      return this.fail<CompleteTurnResult>("completeTurn", err);
    }
  }

  async recall(input: ExplicitRecallInput): Promise<RecallOperationResult> {
    try {
      const { identity, diagnostics: idDiag } = validateIdentity(input.identity);
      const allDiags: HostDiagnostic[] = [...idDiag];

      if (idDiag.length > 0) {
        return { context: "", hits: [], diagnostics: allDiags };
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
      });

      const hits = result.results
        .filter(h => input.minScore === undefined || h.score >= input.minScore)
        .map(h => ({
          content: h.content,
          date: h.date,
          score: h.score,
          classification: h.classification,
        }));

      const context = renderRecallContext(hits, 10000);

      return { context, hits, diagnostics: allDiags };
    } catch (err) {
      return this.fail<RecallOperationResult>("recall", err, { context: "", hits: [], diagnostics: [] });
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
    if (operation === "completeTurn") {
      return { status: "failed", diagnostic } as unknown as T;
    }
    return { context: "", hits: [], diagnostics: [diagnostic] } as unknown as T;
  }
}
