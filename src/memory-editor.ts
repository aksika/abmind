import type Database from "better-sqlite3";
import type { InstantStoreParams, InstantStoreResult, EditMemoryParams, EditMemoryResult, EditPrivateMemoryInputV1 } from "./mem-types.js";
import { clampEmotionScore, scoreFromTags } from "./emotion-utils.js";
import { logError, logInfo, logWarn } from "./mem-logger.js";
import { PrivateMemoryMutationStore } from "./private-memory-mutation-store.js";
import { parseSourceMessageIds, SourceMessageIdsError } from "./source-message-ids.js";

const TAG = "memory-editor";

const SECRET_SCAN_WINDOW = 10;

export class MemoryEditor {
  private readonly mutationStore: PrivateMemoryMutationStore;
  constructor(private readonly db: Database.Database) {
    this.mutationStore = new PrivateMemoryMutationStore(db);
  }

  getMutationStore(): PrivateMemoryMutationStore {
    return this.mutationStore;
  }

  editMemory(params: EditMemoryParams): EditMemoryResult {
    try {
      let targetIds: number[];
      if (params.memoryId != null) {
        targetIds = [params.memoryId];
      } else if (params.messageId != null && params.userId != null) {
        const msg = this.db.prepare(
          "SELECT id FROM messages WHERE user_id = ? AND platform_message_id = ?",
        ).get(params.userId, String(params.messageId)) as { id: number } | undefined;
        if (!msg) return { ok: false, error: "message not found" };
        const rows = this.db.prepare(
          "SELECT id, source_message_ids FROM extracted_memories WHERE user_id = ? AND source_message_ids IS NOT NULL",
        ).all(params.userId) as Array<{ id: number; source_message_ids: string }>;
        const linked: number[] = [];
        for (const row of rows) {
          let parsed: number[];
          try {
            parsed = parseSourceMessageIds(row.source_message_ids);
          } catch (err) {
            if (err instanceof SourceMessageIdsError) {
              logWarn(TAG, `editMemory: skipping memory ${row.id} with malformed source_message_ids`);
              continue;
            }
            throw err;
          }
          if (parsed.includes(msg.id)) linked.push(row.id);
        }
        if (linked.length === 0) return { ok: false, error: "no memories linked to this message" };
        targetIds = linked;
      } else {
        return { ok: false, error: "--memory-id or --message-id + --chat-id required" };
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      const fieldsUpdated: string[] = [];

      if (params.contentEn != null) { sets.push("content_en = ?"); values.push(params.contentEn.trim()); fieldsUpdated.push("content_en"); }
      if (params.contentOriginal != null) { sets.push("content_original = ?"); values.push(params.contentOriginal.trim()); fieldsUpdated.push("content_original"); }
      if (params.keyword !== undefined) { sets.push("preserved_keyword = ?"); values.push(params.keyword?.trim() || null); fieldsUpdated.push("keyword"); }
      if (params.memoryType != null) {
        const valid = new Set(["fact", "decision", "preference", "event", "lesson", "feedback", "story", "secret"]);
        if (!valid.has(params.memoryType)) return { ok: false, error: "invalid memory_type" };
        sets.push("memory_type = ?"); values.push(params.memoryType); fieldsUpdated.push("memory_type");
      }
      if (params.emotionTags != null) {
        sets.push("emotion_tags = ?"); values.push(params.emotionTags); fieldsUpdated.push("emotion_tags");
        sets.push("emotion_score = ?"); values.push(scoreFromTags(params.emotionTags)); fieldsUpdated.push("emotion_score");
      } else if (params.emotionScore != null) {
        sets.push("emotion_score = ?"); values.push(clampEmotionScore(params.emotionScore)); fieldsUpdated.push("emotion_score");
      }
      if (params.emotionContext != null) { sets.push("emotion_context = ?"); values.push(params.emotionContext); fieldsUpdated.push("emotion_context"); }
      if (params.confidence != null) { sets.push("confidence = ?"); values.push(params.confidence); fieldsUpdated.push("confidence"); }
      if (params.trust != null) {
        if (params.trust < 0 || params.trust > 3) return { ok: false, error: "trust must be 0-3" };
        sets.push("trust = ?"); values.push(params.trust); fieldsUpdated.push("trust");
      }
      if (params.integrity != null) {
        if (params.integrity < 0 || params.integrity > 3) return { ok: false, error: "integrity must be 0-3" };
        sets.push("integrity = ?"); values.push(params.integrity); fieldsUpdated.push("integrity");
      }
      if (params.credibility != null) {
        if (params.credibility < 1 || params.credibility > 6) return { ok: false, error: "credibility must be 1-6" };
        sets.push("credibility = ?"); values.push(params.credibility); fieldsUpdated.push("credibility");
      }
      if (params.classification != null) {
        if (params.classification < 0 || params.classification > 3) return { ok: false, error: "classification must be 0-3" };
        fieldsUpdated.push("classification");
      }
      if (params.relevanceScore != null) {
        const raw = params.relevanceScore;
        if (typeof raw === "string" && /^[+-]\d+$/.test(raw)) {
          sets.push("relevance_score = relevance_score + ?"); values.push(parseInt(raw, 10));
        } else {
          sets.push("relevance_score = ?"); values.push(typeof raw === "string" ? parseInt(raw, 10) : raw);
        }
        fieldsUpdated.push("relevance_score");
      }
      if (params.topic != null) { sets.push("topic = ?"); values.push(params.topic); fieldsUpdated.push("topic"); }
      if (params.tier != null) {
        if (params.tier !== "core" && params.tier !== "general") return { ok: false, error: "tier must be 'core' or 'general'" };
        sets.push("tier = ?"); values.push(params.tier); fieldsUpdated.push("tier");
      }
      if (params.validTo != null) { sets.push("valid_to = ?"); values.push(params.validTo || null); fieldsUpdated.push("valid_to"); }

      if (sets.length === 0 && params.classification == null) return { ok: false, error: "no fields to update" };
      if (params.dryRun) return { ok: true, memoriesUpdated: targetIds.length, ids: targetIds, fieldsUpdated };

      if (params.expectedRevision !== undefined && targetIds.length !== 1) {
        return { ok: false, error: "expectedRevision can only be used with one memory" };
      }

      let updated = 0;
      let lastRevision: number | undefined;
      for (const id of targetIds) {
        const row = this.db.prepare(
          "SELECT semantic_revision, user_id FROM extracted_memories WHERE id = ?",
        ).get(id) as { semantic_revision: number; user_id: string } | undefined;
        if (!row) {
          // Preserve the historical in-process façade result for callers that
          // do not provide a revision. The CAS/public path still returns a
          // typed not_found outcome and never treats this as a write.
          if (params.expectedRevision === undefined) {
            return { ok: true, memoriesUpdated: 1, ids: targetIds, fieldsUpdated };
          }
          return { ok: false, error: "memory not found" };
        }
        if (params.userId !== undefined && params.userId !== row.user_id) {
          return { ok: false, error: "memory is not owned by the requested user" };
        }

        const relevance = params.relevanceScore;
        const edit: EditPrivateMemoryInputV1 = {
          userId: row.user_id,
          memoryId: id,
          expectedRevision: params.expectedRevision ?? row.semantic_revision,
          contentEn: params.contentEn,
          contentOriginal: params.contentOriginal,
          keyword: params.keyword,
          memoryType: params.memoryType,
          emotionScore: params.emotionScore,
          emotionTags: params.emotionTags,
          emotionContext: params.emotionContext,
          confidence: params.confidence,
          trust: params.trust,
          integrity: params.integrity,
          credibility: params.credibility,
          classification: params.classification,
          relevanceDelta: typeof relevance === "string" && /^[+-]\d+$/.test(relevance)
            ? parseInt(relevance, 10)
            : undefined,
          relevanceScore: typeof relevance === "number"
            ? relevance
            : typeof relevance === "string" && !/^[+-]\d+$/.test(relevance)
              ? Number(relevance)
              : undefined,
          topic: params.topic,
          tier: params.tier,
          validTo: params.validTo,
        };
        const result = this.mutationStore.edit(
          {
            userId: row.user_id,
            actorId: params.caller?.trim() || "legacy-editor",
            operationKey: `legacy-edit-${id}-${edit.expectedRevision}`,
            canDeclassifySecret: params.userOverride === true,
            origin: "cli",
          },
          edit,
        );
        if (!result.ok) {
          if (result.code === "validation_error") return { ok: false, error: result.message };
          if (result.code === "conflict") return { ok: false, error: `semantic revision conflict (current=${result.current.semanticRevision})` };
          return { ok: false, error: result.code === "not_found" ? "memory not found" : "memory mutation unauthorized" };
        }
        updated++;
        lastRevision = result.ref.semanticRevision;
      }

      logInfo(TAG, `editMemory: updated ${updated} memories [${fieldsUpdated.join(",")}]`);
      return { ok: true, memoriesUpdated: updated, ids: targetIds, fieldsUpdated, semanticRevision: lastRevision };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(TAG, "editMemory failed", err);
      return { ok: false, error: message };
    }
  }

  async instantStore(params: InstantStoreParams): Promise<InstantStoreResult> {
    try {
      const validTypes = new Set(["fact", "decision", "preference", "event", "lesson", "feedback", "story", "secret"]);
      if (!validTypes.has(params.memoryType)) return { stored: false, memoriesCount: 0, code: "validation_error", message: "invalid memory_type" };
      const result = await this.mutationStore.appendInstant(
        { userId: params.userId, actorId: params.createdBy ?? "memory-editor", operationKey: `editor-store-${Date.now()}`, canDeclassifySecret: false, origin: "internal" },
        params,
      );
      if (result.stored) logInfo(TAG, `Instant store: persisted memory for chat ${params.userId}`);
      return result;
    } catch (err) {
      logError(TAG, `Instant store failed for chat ${params.userId}`, err);
      return { stored: false, memoriesCount: 0, code: "unavailable", message: err instanceof Error ? err.message : String(err) };
    }
  }

  adjustRelevance(id: number, delta: number): void {
    const row = this.db.prepare("SELECT user_id, semantic_revision FROM extracted_memories WHERE id = ?").get(id) as { user_id: string; semantic_revision: number } | undefined;
    if (!row) return;
    this.mutationStore.adjustRelevance(
      { userId: row.user_id, actorId: "legacy-editor", operationKey: `legacy-relevance-${id}-${row.semantic_revision}`, canDeclassifySecret: false, origin: "internal" },
      { userId: row.user_id, memoryId: id, expectedRevision: row.semantic_revision, delta },
    );
  }

  reclassifyMemory(id: number, level: number, userOverride = false): { ok: boolean; error?: string } {
    const result = this.editMemory({ memoryId: id, classification: level, userOverride });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  mergeMemories(idA: number, idB: number): { merged: true; keptId: number; deletedId: number } | { merged: false; error: string } {
    const rows = this.db.prepare(
      "SELECT id, user_id, created_at, semantic_revision FROM extracted_memories WHERE id IN (?, ?)",
    ).all(idA, idB) as Array<{ id: number; user_id: string; created_at: number; semantic_revision: number }>;
    if (rows.length !== 2) return { merged: false, error: "one or both IDs not found" };
    if (rows[0]!.user_id !== rows[1]!.user_id) return { merged: false, error: "memories must belong to the same user" };
    const [first, second] = rows as [typeof rows[0], typeof rows[0]];
    const result = this.mutationStore.merge(
      { userId: first.user_id, actorId: "legacy-editor", operationKey: `legacy-merge-${idA}-${idB}`, canDeclassifySecret: false, origin: "internal" },
      { userId: first.user_id, first: { memoryId: first.id, semanticRevision: first.semantic_revision }, second: { memoryId: second.id, semanticRevision: second.semantic_revision } },
    );
    if (!result.ok) return { merged: false, error: result.code === "conflict" ? "merge failed: revision conflict" : result.code };
    return { merged: true, keptId: result.ref.memoryId, deletedId: result.deletedId ?? 0 };
  }
}
