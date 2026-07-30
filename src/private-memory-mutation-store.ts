import type Database from "better-sqlite3";
import type {
  PrivateMemoryRefV1,
  PrivateMutationStatusV1,
  EffectivePrivateMutationContext,
  EditPrivateMemoryInputV1,
  ReclassifyPrivateMemoryInputV1,
  AdjustPrivateRelevanceInputV1,
  MergePrivateMemoriesInputV1,
} from "./mem-types.js";
import { logWarn } from "./mem-logger.js";
import { encrypt, loadKey } from "./crypto.js";
import { scoreFromTags, clampEmotionScore } from "./emotion-utils.js";
import { embedText, loadEmbedConfig } from "./ollama-embed.js";
import { generateSignature } from "./signature-generator.js";

const TAG = "private-mutation-store";

interface SemanticRow {
  id: number;
  user_id: string;
  semantic_revision: number;
  classification: number;
  content_en: string;
  content_original: string;
  encrypted: number;
}

interface MutationPatch {
  sets: string[];
  values: unknown[];
  derivedContent?: string;
}

export class PrivateMemoryMutationStore {
  constructor(private readonly db: Database.Database) {}

  mutateOne(
    ctx: EffectivePrivateMutationContext,
    memoryId: number,
    expectedRevision: number,
    buildPatch: (row: SemanticRow) => MutationPatch,
  ): PrivateMutationStatusV1 {
    let derivedContent: string | undefined;
    let derivedRevision: number | undefined;
    const txn = this.db.transaction((): PrivateMutationStatusV1 => {
      const row = this.db.prepare(
        "SELECT id, user_id, semantic_revision, classification, content_en, content_original, encrypted FROM extracted_memories WHERE id = ? AND user_id = ?",
      ).get(memoryId, ctx.userId) as SemanticRow | undefined;

      if (!row) return { ok: false, code: "not_found" };

      if (row.semantic_revision !== expectedRevision) {
        return { ok: false, code: "conflict", current: { memoryId: row.id, semanticRevision: row.semantic_revision } };
      }

      const patch = buildPatch(row);
      derivedContent = patch.derivedContent;

      if (patch.sets.length === 0) return { ok: true, ref: { memoryId: row.id, semanticRevision: row.semantic_revision } };

      const now = Date.now();
      patch.sets.push("edited_at = ?", "edited_by = ?", "semantic_revision = semantic_revision + 1");
      patch.values.push(now, ctx.actorId);
      patch.values.push(memoryId);

      const result = this.db.prepare(
        `UPDATE extracted_memories SET ${patch.sets.join(", ")} WHERE id = ? AND user_id = ? AND semantic_revision = ?`,
      ).run(...patch.values, ctx.userId, expectedRevision);

      if (result.changes !== 1) {
        const fresh = this.db.prepare(
          "SELECT id, semantic_revision FROM extracted_memories WHERE id = ? AND user_id = ?",
        ).get(memoryId, ctx.userId) as { id: number; semantic_revision: number } | undefined;
        if (!fresh) return { ok: false, code: "not_found" };
        return { ok: false, code: "conflict", current: { memoryId: fresh.id, semanticRevision: fresh.semantic_revision } };
      }

      const newRevision = expectedRevision + 1;
      derivedRevision = newRevision;
      return { ok: true, ref: { memoryId: row.id, semanticRevision: newRevision } };
    });

    try {
      const result = txn();
      if (result.ok && derivedContent && derivedRevision !== undefined) {
        this.scheduleEmbedding(derivedContent, memoryId, ctx.userId, derivedRevision);
      }
      return result;
    } catch (err) {
      if (err instanceof MutationError) return { ok: false, code: "validation_error", message: err.message };
      throw err;
    }
  }

  reclassify(
    ctx: EffectivePrivateMutationContext,
    input: ReclassifyPrivateMemoryInputV1,
  ): PrivateMutationStatusV1 {
    const validLevels = new Set([0, 1, 2, 3]);
    if (!validLevels.has(input.classification) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return { ok: false, code: "validation_error", message: "classification must be 0-3" };
    }

    return this.mutateOne(ctx, input.memoryId, input.expectedRevision, (row) => {
      if (row.classification === 3 && input.classification < 3 && !ctx.canDeclassifySecret) {
        throw new MutationError("cannot declassify SECRET without declassification capability");
      }
      if (row.classification === 2 && input.classification < row.classification && input.classification !== 1) {
        throw new MutationError("CONFIDENTIAL can only be declassified to RESTRICTED (1)");
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      sets.push("classification = ?");
      values.push(input.classification);

      const promotingToSecret = input.classification === 3 && row.classification < 3;
      if (promotingToSecret) {
        try { loadKey(); } catch { throw new MutationError("no encryption key — cannot promote to SECRET"); }
        sets.push("content_original = ?", "encrypted = ?");
        values.push(encrypt(row.content_original), 1);
        sets.push("embedding = NULL");
      }

      return { sets, values };
    });
  }

  adjustRelevance(
    ctx: EffectivePrivateMutationContext,
    input: AdjustPrivateRelevanceInputV1,
  ): PrivateMutationStatusV1 {
    if (!Number.isFinite(input.delta) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return { ok: false, code: "validation_error", message: "delta and expectedRevision must be valid numbers" };
    }
    return this.mutateOne(ctx, input.memoryId, input.expectedRevision, () => {
      return {
        sets: ["relevance_score = relevance_score + ?"],
        values: [input.delta],
      };
    });
  }

  edit(ctx: EffectivePrivateMutationContext, input: EditPrivateMemoryInputV1): PrivateMutationStatusV1 {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return { ok: false, code: "validation_error", message: "expectedRevision must be a positive integer" };
    }
    return this.mutateOne(ctx, input.memoryId, input.expectedRevision, (row) => {
      const sets: string[] = [];
      const values: unknown[] = [];

      if (input.contentOriginal != null) {
        const original = input.contentOriginal.trim();
        if (row.encrypted) {
          try { loadKey(); } catch { throw new MutationError("no encryption key — cannot edit SECRET"); }
          sets.push("content_original = ?"); values.push(encrypt(original));
        } else {
          sets.push("content_original = ?"); values.push(original);
        }
      }
      if (input.keyword !== undefined) { sets.push("preserved_keyword = ?"); values.push(input.keyword?.trim() || null); }
      if (input.memoryType != null) {
        const valid = new Set(["fact", "decision", "preference", "event", "lesson", "feedback", "story", "secret"]);
        if (!valid.has(input.memoryType)) throw new MutationError("invalid memory_type");
        sets.push("memory_type = ?"); values.push(input.memoryType);
      }
      if (input.emotionTags != null) {
        sets.push("emotion_tags = ?"); values.push(input.emotionTags);
        sets.push("emotion_score = ?"); values.push(scoreFromTags(input.emotionTags));
      } else if (input.emotionScore != null) {
        sets.push("emotion_score = ?"); values.push(clampEmotionScore(input.emotionScore));
      }
      if (input.emotionContext != null) { sets.push("emotion_context = ?"); values.push(input.emotionContext); }
      if (input.confidence != null) { sets.push("confidence = ?"); values.push(input.confidence); }
      if (input.trust != null) {
        if (input.trust < 0 || input.trust > 3) throw new MutationError("trust must be 0-3");
        sets.push("trust = ?"); values.push(input.trust);
      }
      if (input.integrity != null) {
        if (input.integrity < 0 || input.integrity > 3) throw new MutationError("integrity must be 0-3");
        sets.push("integrity = ?"); values.push(input.integrity);
      }
      if (input.credibility != null) {
        if (input.credibility < 1 || input.credibility > 6) throw new MutationError("credibility must be 1-6");
        sets.push("credibility = ?"); values.push(input.credibility);
      }
      if (input.classification != null) {
        if (!Number.isInteger(input.classification) || input.classification < 0 || input.classification > 3) {
          throw new MutationError("classification must be 0-3");
        }
        if (row.classification === 3 && input.classification < 3 && !ctx.canDeclassifySecret) {
          throw new MutationError("cannot declassify SECRET without declassification capability");
        }
        if (row.classification === 2 && input.classification < 2 && input.classification !== 1) {
          throw new MutationError("CONFIDENTIAL can only be declassified to RESTRICTED (1)");
        }
        sets.push("classification = ?"); values.push(input.classification);
        if (input.classification === 3 && row.classification < 3) {
          try { loadKey(); } catch { throw new MutationError("no encryption key — cannot promote to SECRET"); }
          sets.push("content_original = ?", "encrypted = ?", "embedding = NULL");
          values.push(encrypt(row.content_original), 1);
        }
      }
      if (input.relevanceDelta != null) {
        sets.push("relevance_score = relevance_score + ?"); values.push(input.relevanceDelta);
      }
      if (input.topic != null) { sets.push("topic = ?"); values.push(input.topic); }
      if (input.tier != null) {
        if (input.tier !== "core" && input.tier !== "general") throw new MutationError("tier must be 'core' or 'general'");
        sets.push("tier = ?"); values.push(input.tier);
      }
      if (input.validTo !== undefined) { sets.push("valid_to = ?"); values.push(input.validTo || null); }
      if (input.emotionArc !== undefined) { sets.push("emotion_arc = ?"); values.push(input.emotionArc); }

      const contentChanged = input.contentEn != null;
      if (contentChanged) {
        const content = input.contentEn?.trim() ?? "";
        if (!content) throw new MutationError("contentEn must be non-empty");
        sets.push("content_en = ?", "embedding = NULL", "signature = ?");
        values.push(content, Buffer.from(generateSignature(content)));
      }

      if (sets.length === 0) throw new MutationError("no fields to update");
      return {
        sets,
        values,
        derivedContent: row.encrypted ? undefined : input.contentEn?.trim(),
      };
    });
  }

  merge(ctx: EffectivePrivateMutationContext, input: MergePrivateMemoriesInputV1): PrivateMutationStatusV1 {
    if (input.first.memoryId === input.second.memoryId) {
      return { ok: false, code: "validation_error", message: "cannot merge a memory with itself" };
    }

    const txn = this.db.transaction((): PrivateMutationStatusV1 => {
      type MergeRow = { id: number; user_id: string; semantic_revision: number; created_at: number; recall_count: number; relevance_score: number; confidence: number };

      const first = this.db.prepare(
        "SELECT id, user_id, semantic_revision, created_at, recall_count, relevance_score, confidence FROM extracted_memories WHERE id = ? AND user_id = ?",
      ).get(input.first.memoryId, ctx.userId) as MergeRow | undefined;

      const second = this.db.prepare(
        "SELECT id, user_id, semantic_revision, created_at, recall_count, relevance_score, confidence FROM extracted_memories WHERE id = ? AND user_id = ?",
      ).get(input.second.memoryId, ctx.userId) as MergeRow | undefined;

      if (!first || !second) return { ok: false, code: "not_found" };

      if (first.semantic_revision !== input.first.semanticRevision) {
        return { ok: false, code: "conflict", current: { memoryId: first.id, semanticRevision: first.semantic_revision } };
      }
      if (second.semantic_revision !== input.second.semanticRevision) {
        return { ok: false, code: "conflict", current: { memoryId: second.id, semanticRevision: second.semantic_revision } };
      }

      const now = Date.now();

      const olderIsFirst = first.created_at < second.created_at;
      const olderRow = olderIsFirst ? first : second;
      const newerRow = olderIsFirst ? second : first;
      const keptId = newerRow.id;
      const deletedId = olderRow.id;
      const keptExpectedRevision = olderIsFirst ? input.second.semanticRevision : input.first.semanticRevision;
      const deletedExpectedRevision = olderIsFirst ? input.first.semanticRevision : input.second.semanticRevision;

      const keptUpdate = this.db.prepare(`
        UPDATE extracted_memories SET
          recall_count = recall_count + ?, relevance_score = MAX(relevance_score, ?),
          confidence = MAX(confidence, ?), integrity = 3,
          edited_at = ?, edited_by = ?,
          semantic_revision = semantic_revision + 1
        WHERE id = ? AND user_id = ? AND semantic_revision = ?
      `).run(
        olderRow.recall_count,
        olderRow.relevance_score,
        olderRow.confidence,
        now, ctx.actorId,
        keptId, ctx.userId, keptExpectedRevision,
      );

      if (keptUpdate.changes !== 1) {
        throw new InternalConflictError();
      }

      const deleteResult = this.db.prepare(
        "DELETE FROM extracted_memories WHERE id = ? AND user_id = ? AND semantic_revision = ?",
      ).run(deletedId, ctx.userId, deletedExpectedRevision);

      if (deleteResult.changes !== 1) {
        throw new InternalConflictError();
      }

      return { ok: true, ref: { memoryId: keptId, semanticRevision: keptExpectedRevision + 1 }, deletedId };
    });

    try {
      return txn();
    } catch (err) {
      if (err instanceof InternalConflictError) {
        const current = this.db.prepare(
          "SELECT id, semantic_revision FROM extracted_memories WHERE id IN (?, ?) AND user_id = ? ORDER BY id LIMIT 1",
        ).get(input.first.memoryId, input.second.memoryId, ctx.userId) as { id: number; semantic_revision: number } | undefined;
        return current
          ? { ok: false, code: "conflict", current: { memoryId: current.id, semanticRevision: current.semantic_revision } }
          : { ok: false, code: "not_found" };
      }
      throw err;
    }
  }

  cascadeDelete(ctx: EffectivePrivateMutationContext, messageIds: number[]): {
    messagesRemoved: number;
    embeddingsRemoved: number;
    transcriptEntriesRemoved: number;
  } {
    if (messageIds.length === 0) {
      return { messagesRemoved: 0, embeddingsRemoved: 0, transcriptEntriesRemoved: 0 };
    }

    const ph = messageIds.map(() => "?").join(",");
    const txn = this.db.transaction(() => {
      const messagesRemoved = this.db.prepare(
        `DELETE FROM messages WHERE id IN (${ph}) AND user_id = ?`,
      ).run(...messageIds, ctx.userId).changes;
      return { messagesRemoved, embeddingsRemoved: 0, transcriptEntriesRemoved: 0 };
    });
    return txn();
  }

  appendInstant(
    ctx: EffectivePrivateMutationContext,
    input: {
      contentEn: string;
      contentOriginal: string;
      memoryType: string;
      emotionScore: number;
      emotionTags?: string;
      emotionContext?: string;
      keyword?: string;
      confidence?: number;
      sourceMessageIds?: string;
      classification?: number;
      trust?: number;
      integrity?: number;
      credibility?: number;
      topic?: string;
      createdBy?: string;
      precomputedEmbedding?: Float32Array | null;
      precomputedSignature?: Buffer | null;
    },
  ): { stored: boolean; memoryId?: number; semanticRevision?: number; error?: string } {
    const blockedUsers = new Set(["system", "agent", "unknown"]);
    if (blockedUsers.has(ctx.userId)) {
      return { stored: false, error: "blocked: system userId cannot store memories" };
    }
    if (!input.contentEn?.trim()) return { stored: false, error: "content-en is required" };
    if (!input.contentOriginal?.trim()) return { stored: false, error: "content-original is required" };

    const isSecret = (input.classification ?? 1) === 3;
    if (isSecret) {
      try { loadKey(); } catch { return { stored: false, error: "no encryption key — cannot store SECRET" }; }
    }

    const contentEn = input.contentEn.trim();
    const storeOriginal = isSecret ? encrypt(input.contentOriginal.trim()) : input.contentOriginal.trim();

    const txn = this.db.transaction(() => {
      const now = Date.now();
      const duplicate = this.db.prepare(
        "SELECT id, semantic_revision FROM extracted_memories WHERE content_en = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1",
      ).get(contentEn, ctx.userId) as { id: number; semantic_revision: number } | undefined;
      if (duplicate) return { stored: true, memoryId: duplicate.id, semanticRevision: duplicate.semantic_revision };

      const existing = this.db.prepare(
        "SELECT MAX(classification) as maxClass FROM extracted_memories WHERE content_en = ? AND user_id = ?",
      ).get(contentEn, ctx.userId) as { maxClass: number | null } | undefined;
      const classification = Math.max(input.classification ?? 1, existing?.maxClass ?? 0);

      const emotionTags = input.emotionTags || null;
      const emotionScore = input.emotionTags ? scoreFromTags(input.emotionTags) : clampEmotionScore(input.emotionScore);
      const topicVal = input.topic ?? "general";

      const memType = isSecret ? "secret" : (input.memoryType || "fact");

      const insertResult = this.db.prepare(
      `INSERT INTO extracted_memories
         (user_id, content_original, content_en, memory_type, source_timestamp,
          preserve_original, preserved_keyword, emotion_score, created_at,
          confidence, source_message_ids, classification, trust, integrity, credibility,
          topic, tier, valid_from, emotion_tags, importance_flags, signature, emotion_context,
          encrypted, created_by, semantic_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
      ctx.userId, storeOriginal, contentEn,
      memType, now, 1, input.keyword?.trim() || null, emotionScore, now,
      input.confidence ?? 1, input.sourceMessageIds?.trim() || null,
      classification, input.trust ?? 0, input.integrity ?? 2, input.credibility ?? 6,
      topicVal, Math.abs(emotionScore) >= 4 ? "core" : "general",
      new Date(now).toISOString().split("T")[0]!,
      emotionTags || null, null, input.precomputedSignature || null,
      input.emotionContext?.trim() || null,
      isSecret ? 1 : 0, input.createdBy ?? ctx.actorId,
      );

      const memoryId = insertResult.lastInsertRowid as number;

      if (input.precomputedEmbedding) {
        this.db.prepare(
          "UPDATE extracted_memories SET embedding = ? WHERE id = ? AND user_id = ? AND semantic_revision = 1",
        ).run(Buffer.from(input.precomputedEmbedding.buffer), memoryId, ctx.userId);
      }

      return { stored: true, memoryId, semanticRevision: 1 };
    });

    return txn();
  }

  private scheduleEmbedding(contentEn: string, memoryId: number, userId: string, sourceRevision: number): void {
    const config = loadEmbedConfig();
    if (!config.enabled) return;
    embedText(config, contentEn).then((vector) => {
      if (!vector) return;
      if (!this.db.open) return;
      this.db.prepare(
        "UPDATE extracted_memories SET embedding = ? WHERE id = ? AND user_id = ? AND semantic_revision = ?",
      ).run(Buffer.from(vector.buffer), memoryId, userId, sourceRevision);
    }).catch((err: unknown) => {
      logWarn(TAG, `derived embedding discarded: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

class MutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationError";
  }
}

class InternalConflictError extends Error {
  constructor() {
    super("Internal transaction conflict");
    this.name = "InternalConflictError";
  }
}
