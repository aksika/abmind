import type { MemoryManager } from "../memory-manager.js";
import { validateIdentity, canAutoWrite, buildProvenance } from "./identity.js";
import { renderWakeUp } from "./render.js";
import type {
  ExecutionIdentity,
  HostLifecycleOptions,
  StartSessionInput,
  StartSessionResult,
  PrepareTurnInput,
  PrepareTurnResult,
  CompleteTurnInput,
  CompleteTurnResult,
  ExplicitStoreInput,
  CheckpointInput,
  CheckpointResult,
  HostDiagnostic,
  TurnAuthor,
} from "./types.js";
import { NON_PRIMARY_ORIGINS } from "./types.js";
import { OWNED_RECALL_CONTRACT } from "../owned-recall-contract.js";

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

  /**
   * #1383 — checkpoint evidence session for an identity. Execution-scoped so
   * equal text in two distinct turns never conflates, durable across restart,
   * and separable from real conversation sessions.
   */
  private checkpointSessionFor(identity: ExecutionIdentity): string {
    return `${identity.conversationId}:precompress:${identity.executionId}:g${identity.generation ?? 0}`;
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
        return {
          packet: {
            contract: OWNED_RECALL_CONTRACT,
            profile: "recall_fast",
            packetId: "invalid-identity",
            principal: identity.principalId,
            status: "unavailable",
            items: [],
            text: "",
            effective: {
              maxItems: 0,
              maxOutputBytes: 0,
              deadlineMs: 0,
              policyVersion: OWNED_RECALL_CONTRACT,
            },
            stageOutcomes: {},
            omissionReasons: idDiag.map((d) => `invalid identity: ${d.message}`),
          },
          diagnostics: allDiags,
        };
      }

      // #1928 M4 — the common fast core owns planning, search, selection
      // and rendering. The host supplies the verbatim turn, trusted
      // context and capacity; it applies no score/age floors, reranking,
      // clipping or local rendering. Fast never auto-escalates.
      const packet = await this.memory.recall({
        contract: OWNED_RECALL_CONTRACT,
        profile: "recall_fast",
        identity: {
          principal: identity.principalId,
          ...(identity.host ? { host: identity.host } : {}),
          ...(identity.conversationId ? { conversation: identity.conversationId } : {}),
          ...(identity.executionId ? { execution: identity.executionId } : {}),
          ...(identity.generation !== undefined ? { generation: identity.generation } : {}),
        },
        rawTurn: input.prompt,
        ...(input.context !== undefined && input.context.length > 0
          ? {
              context: input.context.slice(0, 4).map((s) => ({
                text: s.text,
                principal: s.principal,
                host: s.host,
                conversation: s.conversation,
                ...(s.generation !== undefined ? { generation: s.generation } : {}),
                ...(s.executionId !== undefined ? { execution: s.executionId } : {}),
                complete: s.complete,
              })),
            }
          : {}),
        ...(input.capacity !== undefined ? { capacity: { ...input.capacity } } : {}),
      });

      return { packet, diagnostics: allDiags };
    } catch (err) {
      return this.fail<PrepareTurnResult>("prepareTurn", err, {
        packet: {
          contract: OWNED_RECALL_CONTRACT,
          profile: "recall_fast",
          packetId: "lifecycle-error",
          principal: "unknown",
          status: "unavailable",
          items: [],
          text: "",
          effective: {
            maxItems: 0,
            maxOutputBytes: 0,
            deadlineMs: 0,
            policyVersion: OWNED_RECALL_CONTRACT,
          },
          stageOutcomes: {},
          omissionReasons: [err instanceof Error ? err.message : String(err)],
        },
        diagnostics: [],
      });
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
        if (input.messages.length === 0) return { status: "skipped", reason: "empty" };
        return {
          status: "skipped",
          reason: captured.reconciled > 0 ? "already_captured" : "all_rejected",
        };
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
