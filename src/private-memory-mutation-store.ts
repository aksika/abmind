import type Database from "better-sqlite3";
import type {
  PrivateMemoryRefV1,
  PrivateMutationStatusV1,
  InstantStoreParams,
  InstantStoreResult,
  EffectivePrivateMutationContext,
  EditPrivateMemoryInputV1,
  ReclassifyPrivateMemoryInputV1,
  AdjustPrivateRelevanceInputV1,
  MergePrivateMemoriesInputV1,
  CascadeDeletePrivateMessagesInputV1,
  CascadeDeleteResultV1,
} from "./mem-types.js";
import { logWarn } from "./mem-logger.js";
import { encrypt, decrypt, loadKey } from "./crypto.js";
import { createSealedProjection, SEALED_FORMAT_VERSION } from "./sealed-memory.js";
import { scoreFromTags, clampEmotionScore } from "./emotion-utils.js";
import { embedText, loadEmbedConfig } from "./ollama-embed.js";
import { generateSignature } from "./signature-generator.js";
import { parseSourceMessageIds, canonicalizeSourceMessageIds } from "./source-message-ids.js";
import { localDate } from "./local-time.js";
import { detectFlags } from "./importance-flagger.js";
import { redactSecrets } from "./redact-secrets.js";
import { checkContradiction } from "./contradiction-checker.js";
import { assertPrimaryMemoryOwner, PrimaryIdentityError } from "./user-utils.js";

const TAG = "private-mutation-store";
const SECRET_SCAN_WINDOW = 10;

interface SemanticRow {
  id: number;
  user_id: string;
  semantic_revision: number;
  classification: number;
  content_en: string;
  content_original: string;
  preserved_keyword: string | null;
  encrypted: number;
  sealed_format_version: number;
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
        "SELECT id, user_id, semantic_revision, classification, content_en, content_original, preserved_keyword, encrypted, sealed_format_version FROM extracted_memories WHERE id = ? AND user_id = ?",
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
      if (row.classification >= 3 && input.classification === 3
        && (row.sealed_format_version !== SEALED_FORMAT_VERSION || row.encrypted !== 1)) {
        throw new MutationError("legacy class-3 row requires the reviewed migration");
      }
      if (row.classification >= 3 && input.classification < 3 && !ctx.canDeclassifySecret) {
        throw new MutationError("cannot declassify SECRET without declassification capability");
      }
      if (row.classification === 2 && input.classification < row.classification && input.classification !== 1) {
        throw new MutationError("CONFIDENTIAL can only be declassified to RESTRICTED (1)");
      }

      const sets: string[] = [];
      const values: unknown[] = [];

      const promotingToSecret = input.classification === 3 && row.classification < 3;
      const declassifyingSecret = input.classification < 3 && row.classification >= 3;
      if (promotingToSecret) {
        // #1660: promotion requires the exact value and a descriptive label in
        // the same owner/revision CAS; the result is a version-1 sealed row.
        if (!input.sealedLabel) {
          throw new MutationError("promoting to SECRET requires a sealedLabel");
        }
        const projection = createSealedProjection({
          exactValue: row.encrypted ? decrypt(row.content_original) : row.content_original,
          label: input.sealedLabel,
          keyword: input.sealedKeyword,
        });
        sets.push(
          "classification = ?",
          "content_original = ?",
          "content_en = ?",
          "preserved_keyword = ?",
          "encrypted = ?",
          "sealed_format_version = ?",
          "embedding = ?",
        );
        values.push(
          input.classification,
          projection.contentOriginal,
          projection.contentEn,
          projection.preservedKeyword,
          projection.encrypted,
          projection.sealedFormatVersion,
          projection.embedding,
        );
      } else if (declassifyingSecret) {
        // #1660: declassification requires an explicit non-sealed projection
        // and clears the sealed-format marker.
        const declassifiedEn = input.declassifiedContentEn?.trim();
        const declassifiedOriginal = input.declassifiedContentOriginal?.trim();
        if (!declassifiedEn || !declassifiedOriginal) {
          throw new MutationError("declassifying SECRET requires declassifiedContentEn and declassifiedContentOriginal");
        }
        sets.push(
          "classification = ?",
          "content_en = ?",
          "content_original = ?",
          "encrypted = ?",
          "sealed_format_version = ?",
          "signature = ?",
          "embedding = ?",
        );
        values.push(
          input.classification,
          declassifiedEn,
          declassifiedOriginal,
          0,
          0,
          Buffer.from(generateSignature(declassifiedEn)),
          null,
        );
      } else {
        sets.push("classification = ?");
        values.push(input.classification);
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
      let contentEnHandled = false;
      let contentOriginalHandled = false;
      let keywordHandled = false;

      const isSealed = row.classification >= 3;
      const promotingToSecret = input.classification === 3 && row.classification < 3;
      const declassifyingSecret = input.classification != null && input.classification < 3 && row.classification >= 3;

      if (input.clearContentOriginal) {
        // #1660: TTL aging ages through this single edit path; a sealed row's
        // encrypted exact value must never be stripped.
        if (isSealed || row.sealed_format_version >= 1) {
          throw new MutationError("cannot clear content_original of a sealed row");
        }
        sets.push("content_original = NULL");
      } else if (isSealed && !declassifyingSecret
        && (input.contentOriginal != null || input.contentEn != null || input.keyword !== undefined)) {
        // A sealed edit must rebuild the complete projection. Directly
        // assigning contentEn/keyword here would let a caller copy the exact
        // credential into an index column, while editing only contentOriginal
        // would leave a stale projection behind.
        let exactValue: string;
        try {
          exactValue = input.contentOriginal ?? (row.encrypted ? decrypt(row.content_original) : row.content_original);
        } catch {
          throw new MutationError("sealed row cannot be edited");
        }
        const projection = createSealedProjection({
          exactValue,
          label: input.contentEn ?? row.content_en,
          keyword: input.keyword !== undefined ? input.keyword : row.preserved_keyword ?? undefined,
        });
        sets.push("content_original = ?", "content_en = ?", "preserved_keyword = ?", "encrypted = ?", "sealed_format_version = ?", "embedding = ?", "signature = ?");
        values.push(
          projection.contentOriginal,
          projection.contentEn,
          projection.preservedKeyword,
          projection.encrypted,
          projection.sealedFormatVersion,
          projection.embedding,
          Buffer.from(generateSignature(projection.contentEn)),
        );
        contentEnHandled = true;
        contentOriginalHandled = true;
        keywordHandled = true;
      } else if (input.contentOriginal != null && !contentOriginalHandled && !promotingToSecret && !declassifyingSecret) {
        const original = input.contentOriginal.trim();
        if (row.encrypted) {
          try { loadKey(); } catch { throw new MutationError("no encryption key — cannot edit SECRET"); }
          sets.push("content_original = ?"); values.push(encrypt(original));
        } else {
          sets.push("content_original = ?"); values.push(original);
        }
        contentOriginalHandled = true;
      }
      if (input.keyword !== undefined && !keywordHandled) { sets.push("preserved_keyword = ?"); values.push(input.keyword?.trim() || null); }
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
        if (row.classification >= 3 && input.classification === 3
          && (row.sealed_format_version !== SEALED_FORMAT_VERSION || row.encrypted !== 1)
          && input.contentEn == null && input.contentOriginal == null && input.keyword === undefined) {
          throw new MutationError("legacy class-3 row requires the reviewed migration");
        }
        if (row.classification >= 3 && input.classification < 3 && !ctx.canDeclassifySecret) {
          throw new MutationError("cannot declassify SECRET without declassification capability");
        }
        if (row.classification === 2 && input.classification < 2 && input.classification !== 1) {
          throw new MutationError("CONFIDENTIAL can only be declassified to RESTRICTED (1)");
        }
        if (input.classification === 3 && row.classification < 3) {
          // #1660: promotion requires exact value and descriptive label in the
          // same owner/revision CAS; the result is a version-1 sealed row.
          if (!input.sealedLabel) {
            throw new MutationError("promoting to SECRET requires sealedLabel");
          }
          const projection = createSealedProjection({
            exactValue: row.encrypted ? decrypt(row.content_original) : row.content_original,
            label: input.sealedLabel,
            keyword: input.sealedKeyword,
          });
          sets.push("classification = ?", "content_original = ?", "content_en = ?", "preserved_keyword = ?", "encrypted = ?", "sealed_format_version = ?", "embedding = ?");
          values.push(input.classification, projection.contentOriginal, projection.contentEn, projection.preservedKeyword, projection.encrypted, projection.sealedFormatVersion, projection.embedding);
          contentEnHandled = true;
        } else if (input.classification < 3 && row.classification >= 3) {
          // #1660: declassification requires an explicit non-sealed projection.
          const declassifiedEn = input.contentEn?.trim();
          const declassifiedOriginal = input.contentOriginal != null ? input.contentOriginal.trim() : undefined;
          if (!declassifiedEn || !declassifiedOriginal) {
            throw new MutationError("declassifying SECRET requires explicit contentEn and contentOriginal");
          }
          sets.push("classification = ?", "content_en = ?", "content_original = ?", "encrypted = ?", "sealed_format_version = ?", "signature = ?", "embedding = ?");
          values.push(input.classification, declassifiedEn, declassifiedOriginal, 0, 0, Buffer.from(generateSignature(declassifiedEn)), null);
          contentEnHandled = true;
        } else {
          sets.push("classification = ?"); values.push(input.classification);
        }
      }
      if (input.relevanceDelta != null) {
        if (!Number.isFinite(input.relevanceDelta)) throw new MutationError("relevanceDelta must be finite");
        sets.push("relevance_score = relevance_score + ?"); values.push(input.relevanceDelta);
      }
      if (input.relevanceScore != null) {
        if (!Number.isFinite(input.relevanceScore)) throw new MutationError("relevanceScore must be finite");
        sets.push("relevance_score = ?"); values.push(input.relevanceScore);
      }
      if (input.topic != null) { sets.push("topic = ?"); values.push(input.topic); }
      if (input.tier != null) {
        if (input.tier !== "core" && input.tier !== "general") throw new MutationError("tier must be 'core' or 'general'");
        sets.push("tier = ?"); values.push(input.tier);
      }
      if (input.validTo !== undefined) { sets.push("valid_to = ?"); values.push(input.validTo || null); }
      if (input.emotionArc !== undefined) { sets.push("emotion_arc = ?"); values.push(input.emotionArc); }

      const contentChanged = input.contentEn != null && !contentEnHandled;
      if (contentChanged) {
        const content = input.contentEn?.trim() ?? "";
        if (!content) throw new MutationError("contentEn must be non-empty");
        sets.push("content_en = ?", "embedding = NULL", "signature = ?");
        values.push(content, Buffer.from(generateSignature(content)));
      }

      if (sets.length === 0) throw new MutationError("no fields to update");
      // #1660: a sealed row never re-derives an embedding; derivedContent is
      // only scheduled for plaintext (non-encrypted) rows.
      const finalClassification = input.classification ?? row.classification;
      const derivedContent = finalClassification >= 3 || row.encrypted || isSealed
        ? undefined
        : input.contentEn?.trim();
      return {
        sets,
        values,
        derivedContent,
      };
    });
  }

  merge(ctx: EffectivePrivateMutationContext, input: MergePrivateMemoriesInputV1): PrivateMutationStatusV1 {
    if (input.first.memoryId === input.second.memoryId) {
      return { ok: false, code: "validation_error", message: "cannot merge a memory with itself" };
    }

    let keptContent: string | undefined;
    let keptRevision: number | undefined;
    const txn = this.db.transaction((): PrivateMutationStatusV1 => {
      type MergeRow = { id: number; user_id: string; semantic_revision: number; classification: number; created_at: number; recall_count: number; relevance_score: number; confidence: number; content_en: string };

      const first = this.db.prepare(
        "SELECT id, user_id, semantic_revision, classification, created_at, recall_count, relevance_score, confidence, content_en FROM extracted_memories WHERE id = ? AND user_id = ?",
      ).get(input.first.memoryId, ctx.userId) as MergeRow | undefined;

      const second = this.db.prepare(
        "SELECT id, user_id, semantic_revision, classification, created_at, recall_count, relevance_score, confidence, content_en FROM extracted_memories WHERE id = ? AND user_id = ?",
      ).get(input.second.memoryId, ctx.userId) as MergeRow | undefined;

      if (!first || !second) return { ok: false, code: "not_found" };

      if (first.classification >= 3 || second.classification >= 3) {
        return { ok: false, code: "validation_error", message: "cannot merge sealed memories" };
      }

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

      keptContent = newerRow.content_en;
      keptRevision = keptExpectedRevision + 1;
      return { ok: true, ref: { memoryId: keptId, semanticRevision: keptRevision }, deletedId };
    });

    try {
      const result = txn();
      if (result.ok && keptContent && keptRevision !== undefined) {
        this.scheduleEmbedding(keptContent, result.ref.memoryId, ctx.userId, keptRevision);
      }
      return result;
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

  cascadeDelete(
    ctx: EffectivePrivateMutationContext,
    input: CascadeDeletePrivateMessagesInputV1,
  ): CascadeDeleteResultV1 {
    if (input.userId !== ctx.userId) throw new CascadeValidationError("cascade delete principal mismatch");
    const ids = input.messageIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 512) {
      throw new CascadeValidationError("cascade delete requires 1-512 message ids");
    }
    const unique = new Set<number>();
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || id < 1) throw new CascadeValidationError("cascade delete requires positive safe integer message ids");
      unique.add(id);
    }
    if (unique.size !== ids.length) throw new CascadeValidationError("cascade delete requires unique message ids");

    const txn = this.db.transaction((): CascadeDeleteResultV1 => {
      const ph = ids.map(() => "?").join(",");
      const ownerMessages = this.db.prepare(
        `SELECT id FROM messages WHERE id IN (${ph}) AND user_id = ?`,
      ).all(...ids, ctx.userId) as Array<{ id: number }>;
      const selectedIds = new Set(ownerMessages.map((r) => r.id));
      if (selectedIds.size === 0) {
        return { messagesRemoved: 0, linkedMemoriesRemoved: 0, embeddingsRemoved: 0 };
      }

      const linkedRows = this.db.prepare(
        "SELECT id, source_message_ids, embedding IS NOT NULL AS has_embedding FROM extracted_memories WHERE user_id = ? AND source_message_ids IS NOT NULL",
      ).all(ctx.userId) as Array<{ id: number; source_message_ids: string; has_embedding: number }>;

      const linkedIds: number[] = [];
      let embeddingsRemoved = 0;
      for (const row of linkedRows) {
        const parsed = parseSourceMessageIds(row.source_message_ids);
        if (parsed.some((sourceId) => selectedIds.has(sourceId))) {
          linkedIds.push(row.id);
          if (row.has_embedding === 1) embeddingsRemoved++;
        }
      }

      if (linkedIds.length > 0) {
        const mPh = linkedIds.map(() => "?").join(",");
        const memoryDelete = this.db.prepare(
          `DELETE FROM extracted_memories WHERE id IN (${mPh}) AND user_id = ?`,
        ).run(...linkedIds, ctx.userId);
        if (memoryDelete.changes !== linkedIds.length) throw new CascadeConflictError();
      }

      const messageDelete = this.db.prepare(
        `DELETE FROM messages WHERE id IN (${ph}) AND user_id = ?`,
      ).run(...ids, ctx.userId);
      if (messageDelete.changes !== selectedIds.size) throw new CascadeConflictError();

      return {
        messagesRemoved: selectedIds.size,
        linkedMemoriesRemoved: linkedIds.length,
        embeddingsRemoved,
      };
    });

    return txn();
  }

  async appendInstant(
    ctx: EffectivePrivateMutationContext,
    input: InstantStoreParams,
  ): Promise<InstantStoreResult> {
    try {
      assertPrimaryMemoryOwner(ctx.userId);
    } catch (err) {
      if (err instanceof PrimaryIdentityError) {
        return {
          stored: false,
          memoriesCount: 0,
          code: err.code === "non_primary_memory_owner" ? "unauthorized" : "unavailable",
          message: `[${err.code}] ${err.message}`,
        };
      }
      throw err;
    }
    const blockedUsers = new Set(["system", "agent", "unknown"]);
    if (blockedUsers.has(ctx.userId)) {
      return { stored: false, memoriesCount: 0, code: "unauthorized", message: "blocked: system userId cannot store memories" };
    }
    const classification = input.classification ?? 1;
    if (!Number.isSafeInteger(classification) || classification < 0 || classification > 3) {
      return { stored: false, memoriesCount: 0, code: "validation_error", message: "classification must be 0-3" };
    }
    if (!input.contentEn?.trim() && classification < 3) return { stored: false, memoriesCount: 0, code: "validation_error", message: "content-en is required" };
    if (!input.contentOriginal?.trim()) return { stored: false, memoriesCount: 0, code: "validation_error", message: "content-original is required" };

    const isSecret = classification >= 3;
    if (isSecret) {
      // #1660: class-3 instant store requires a descriptive label; content_en
      // is never the value-bearing field for secrets.
      if (!input.sealedLabel?.trim()) {
        return { stored: false, memoriesCount: 0, code: "validation_error", message: "class-3 storage requires sealedLabel" };
      }
      try { loadKey(); } catch { return { stored: false, memoriesCount: 0, code: "unavailable", message: "no encryption key — cannot store SECRET" }; }
    }

    let contentEn: string;
    let storeOriginal: string;
    let preservedKeyword: string | null;
    let sealedFormat: number;
    let signature: Buffer;
    let precomputedEmbedding: Float32Array | null = null;

    if (isSecret) {
      const projection = createSealedProjection({
        exactValue: input.contentOriginal,
        label: input.sealedLabel!.trim(),
        keyword: input.sealedKeyword,
      });
      contentEn = projection.contentEn;
      storeOriginal = projection.contentOriginal;
      preservedKeyword = projection.preservedKeyword;
      sealedFormat = projection.sealedFormatVersion;
      signature = Buffer.from(generateSignature(contentEn));
    } else {
      contentEn = input.contentEn.trim();
      const embedCfg = loadEmbedConfig();
      if (embedCfg.enabled) {
        try {
          const vector = await embedText(embedCfg, contentEn);
          if (vector) precomputedEmbedding = vector;
        } catch { /* optional enrichment */ }
      }
      storeOriginal = input.contentOriginal.trim();
      preservedKeyword = input.keyword?.trim() || null;
      sealedFormat = 0;
      signature = Buffer.from(generateSignature(contentEn));
    }
    const emotionTags = input.emotionTags || null;
    const emotionScore = emotionTags ? scoreFromTags(emotionTags) : clampEmotionScore(input.emotionScore);
    const importanceFlags = detectFlags(contentEn).join(",");
    const topicVal = input.topic ?? "general";

    const txn = this.db.transaction((): Extract<InstantStoreResult, { stored: true }> => {
      const now = Date.now();
      // #1660: a label is not identity. Class-3 storage bypasses content-label
      // deduplication and contradiction logic so same-label secrets stay
      // distinct rows; credential rotation is an explicit CAS edit.
      let duplicate: { id: number; semantic_revision: number } | undefined;
      if (!isSecret) {
        duplicate = this.db.prepare(
          "SELECT id, semantic_revision FROM extracted_memories WHERE content_en = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1",
        ).get(contentEn, ctx.userId) as { id: number; semantic_revision: number } | undefined;
      }
      if (duplicate) return { stored: true, memoriesCount: 1, memoryId: duplicate.id, semanticRevision: duplicate.semantic_revision };

      const existing = isSecret ? undefined : this.db.prepare(
        "SELECT MAX(classification) as maxClass FROM extracted_memories WHERE content_en = ? AND user_id = ?",
      ).get(contentEn, ctx.userId) as { maxClass: number | null } | undefined;
      const storedClassification = existing ? Math.max(classification, existing?.maxClass ?? 0) : classification;

      const memType = isSecret ? "secret" : (input.memoryType || "fact");

      const insertResult = this.db.prepare(
      `INSERT INTO extracted_memories
         (user_id, content_original, content_en, memory_type, source_timestamp,
          preserve_original, preserved_keyword, emotion_score, created_at,
          confidence, source_message_ids, classification, trust, integrity, credibility,
          topic, tier, valid_from, emotion_tags, importance_flags, signature, emotion_context,
          encrypted, created_by, semantic_revision, sealed_format_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      ).run(
      ctx.userId, storeOriginal, contentEn,
      memType, now, 1, preservedKeyword, emotionScore, now,
      input.confidence ?? 1, canonicalizeSourceMessageIds(input.sourceMessageIds),
      storedClassification, input.trust ?? 0, input.integrity ?? 2, input.credibility ?? 6,
      topicVal, Math.abs(emotionScore) >= 4 ? "core" : "general",
      localDate(new Date(now)),
      emotionTags || null, importanceFlags || null, signature,
      input.emotionContext?.trim() || null,
      isSecret ? 1 : 0, ctx.actorId,
      sealedFormat,
      );

      const memoryId = insertResult.lastInsertRowid as number;

      if (!isSecret && precomputedEmbedding) {
        this.db.prepare(
          "UPDATE extracted_memories SET embedding = ? WHERE id = ? AND user_id = ? AND semantic_revision = 1",
        ).run(Buffer.from(precomputedEmbedding.buffer), memoryId, ctx.userId);
      }

      let contradicted: Extract<InstantStoreResult, { stored: true }>["contradicted"];
      if (topicVal !== "general" && !isSecret) {
        const existingRows = this.db.prepare(
          "SELECT id, content_en, topic, semantic_revision FROM extracted_memories WHERE user_id = ? AND topic = ? AND valid_to IS NULL AND content_en != ? ORDER BY created_at DESC LIMIT 20",
        ).all(ctx.userId, topicVal, contentEn) as Array<{ id: number; content_en: string; topic: string; semantic_revision: number }>;
        const hit = checkContradiction(contentEn, topicVal, existingRows);
        if (hit) {
          const existing = existingRows.find(row => row.id === hit.existingId);
          if (existing) {
            const invalidated = this.db.prepare(
              "UPDATE extracted_memories SET valid_to = ?, semantic_revision = semantic_revision + 1, edited_at = ?, edited_by = ? WHERE id = ? AND user_id = ? AND semantic_revision = ?",
            ).run(localDate(new Date(now)), now, "contradiction-check", hit.existingId, ctx.userId, existing.semantic_revision);
            if (invalidated.changes === 1) {
              contradicted = { id: hit.existingId, content: hit.existingContent, reason: hit.reason };
            }
          }
        }
      }

      if (isSecret) {
        const recentMessages = this.db.prepare(
          "SELECT id, content FROM messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?",
        ).all(ctx.userId, SECRET_SCAN_WINDOW) as Array<{ id: number; content: string }>;
        for (const msg of recentMessages) {
          const redacted = redactSecrets(msg.content);
          if (redacted !== msg.content) {
            this.db.prepare("UPDATE messages SET content = ? WHERE id = ? AND user_id = ?").run(redacted, msg.id, ctx.userId);
          }
        }
      }

      const success: Extract<InstantStoreResult, { stored: true }> = { stored: true, memoriesCount: 1, memoryId, semanticRevision: 1, contradicted };
      return success;
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

class CascadeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CascadeValidationError";
  }
}

class CascadeConflictError extends Error {
  constructor() {
    super("Cascade delete required-effect mismatch");
    this.name = "CascadeConflictError";
  }
}
