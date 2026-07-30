import { localDate } from "./local-time.js";
import type Database from "better-sqlite3";
import type { InstantStoreParams, InstantStoreResult, EditMemoryParams, EditMemoryResult, ForgetResult, PrivateMemoryRefV1, EffectivePrivateMutationContext } from "./mem-types.js";
import { clampEmotionScore, scoreFromTags } from "./emotion-utils.js";
import { loadEmbedConfig, embedText } from "./ollama-embed.js";
import { logError, logInfo } from "./mem-logger.js";
import { detectFlags } from "./importance-flagger.js";
import { generateSignature } from "./signature-generator.js";
import { encrypt, loadKey } from "./crypto.js";
import { redactSecrets } from "./redact-secrets.js";
import { checkContradiction } from "./contradiction-checker.js";
import { PrivateMemoryMutationStore } from "./private-memory-mutation-store.js";

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
          "SELECT id FROM extracted_memories WHERE source_message_ids LIKE '%' || ? || '%'",
        ).all(String(msg.id)) as Array<{ id: number }>;
        if (rows.length === 0) return { ok: false, error: "no memories linked to this message" };
        targetIds = rows.map(r => r.id);
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

      const editedBy = params.caller ?? null;
      const contentChanged = params.contentEn != null;

      for (const id of targetIds) {
        const row = this.db.prepare("SELECT classification, content_en, content_original, semantic_revision, user_id FROM extracted_memories WHERE id = ?").get(id) as { classification: number; content_en: string; content_original: string; semantic_revision: number; user_id: string } | undefined;
        if (!row) continue;

        if (params.classification != null) {
          if (row.classification === 3 && params.classification < 3 && !params.userOverride) {
            return { ok: false, error: "cannot declassify SECRET without --user-override" };
          }
          if (row.classification === 2 && params.classification < row.classification && params.classification !== 1) {
            return { ok: false, error: "CONFIDENTIAL can only be declassified to RESTRICTED (1)" };
          }
        }

        const finalSets = [...sets];
        const finalValues = [...values];
        if (params.classification != null) { finalSets.push("classification = ?"); finalValues.push(params.classification); }

        const promotingToSecret = params.classification === 3 && row.classification < 3;
        if (promotingToSecret) {
          try { loadKey(); } catch { return { ok: false, error: "no encryption key — cannot promote to SECRET" }; }
          finalSets.push("content_original = ?", "encrypted = ?");
          finalValues.push(encrypt(row.content_original), 1);
        }

        const now = Date.now();
        finalSets.push("edited_at = ?", "edited_by = ?", "semantic_revision = semantic_revision + 1");
        finalValues.push(now, editedBy);
        if (contentChanged && !promotingToSecret) finalSets.push("embedding = NULL");

        finalValues.push(id, row.user_id);
        this.db.prepare(`UPDATE extracted_memories SET ${finalSets.join(", ")} WHERE id = ? AND user_id = ?`).run(...finalValues);

        if (promotingToSecret) {
          this.db.prepare("DELETE FROM content_original_trigram WHERE rowid = ?").run(id);
        } else if (contentChanged && params.contentEn) {
          this.embedNewMemoryForRevision(params.contentEn.trim(), id, row.user_id, row.semantic_revision + 1);
        }
      }

      logInfo(TAG, `editMemory: updated ${targetIds.length} memories [${fieldsUpdated.join(",")}] caller=${editedBy}`);
      return { ok: true, memoriesUpdated: targetIds.length, ids: targetIds, fieldsUpdated };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(TAG, "editMemory failed", err);
      return { ok: false, error: message };
    }
  }

  private static readonly BLOCKED_USER_IDS = new Set(["system", "agent", "unknown"]);

  async instantStore(params: InstantStoreParams): Promise<InstantStoreResult> {
    try {
      if (MemoryEditor.BLOCKED_USER_IDS.has(params.userId)) return { stored: false, memoriesCount: 0, error: "blocked: system userId cannot store memories" };
      if (!params.contentEn?.trim()) return { stored: false, memoriesCount: 0, error: "content-en is required" };
      if (!params.contentOriginal?.trim()) return { stored: false, memoriesCount: 0, error: "content-original is required" };
      const validTypes = new Set(["fact", "decision", "preference", "event", "lesson", "feedback", "story", "secret"]);
      if (!validTypes.has(params.memoryType)) return { stored: false, memoriesCount: 0, error: "invalid memory_type" };

      if ((params.classification ?? 1) === 3) params = { ...params, memoryType: "secret" };

      const contentEn = params.contentEn.trim();

      // Phase 1: enrichment outside transaction — compute embedding, signature, encryption
      const embedCfg = loadEmbedConfig();
      let precomputedEmbedding: Float32Array | null = null;
      if (embedCfg.enabled) {
        try {
          const vec = await embedText(embedCfg, contentEn);
          if (vec) precomputedEmbedding = vec;
        } catch { }
      }

      const emotionTags = params.emotionTags || null;
      const emotionScore = emotionTags ? scoreFromTags(emotionTags) : clampEmotionScore(params.emotionScore);
      const importanceFlags = detectFlags(contentEn).join(",");
      const topicVal = params.topic ?? "general";
      const signature = Buffer.from(generateSignature(contentEn));

      const isSecret = (params.classification ?? 1) === 3;
      if (isSecret) {
        try { loadKey(); } catch { return { stored: false, memoriesCount: 0, error: "no encryption key — cannot store SECRET" }; }
      }
      const storeOriginal = isSecret ? encrypt(params.contentOriginal.trim()) : params.contentOriginal.trim();

      // Phase 2: bounded transaction — re-check dedup, classification floor, insert atomically
      const txnResult = this.db.transaction((): {
        stored: boolean; memoryId?: number; semanticRevision?: number; contradicted?: InstantStoreResult["contradicted"]
      } => {
        const now = Date.now();

        // Re-check exact dedup against current state
        const recent = this.db.prepare(
          "SELECT id, semantic_revision FROM extracted_memories WHERE content_en = ? AND user_id = ? AND created_at > ? LIMIT 1",
        ).get(contentEn, params.userId, now - 60_000) as { id: number; semantic_revision: number } | undefined;
        if (recent) return { stored: true, memoryId: recent.id, semanticRevision: recent.semantic_revision };

        // Re-check paraphrase dedup using precomputed vector
        if (precomputedEmbedding) {
          const recentRows = this.db.prepare(
            "SELECT id, semantic_revision, embedding FROM extracted_memories WHERE user_id = ? AND created_at > ? AND embedding IS NOT NULL"
          ).all(params.userId, now - 60_000) as Array<{ id: number; semantic_revision: number; embedding: Buffer }>;
          for (const row of recentRows) {
            const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
            let dot = 0, normA = 0, normB = 0;
            for (let i = 0; i < precomputedEmbedding!.length; i++) { dot += precomputedEmbedding![i]! * stored[i]!; normA += precomputedEmbedding![i]! * precomputedEmbedding![i]!; normB += stored[i]! * stored[i]!; }
            const cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
            if (cosine >= 0.85) return { stored: true, memoryId: row.id, semanticRevision: row.semantic_revision };
          }
        }

        // Re-check classification floor from current DB state
        const existing = this.db.prepare(
          "SELECT MAX(classification) as maxClass FROM extracted_memories WHERE content_en = ? AND user_id = ?"
        ).get(contentEn, params.userId) as { maxClass: number | null } | undefined;
        let classification = Math.max(params.classification ?? 1, existing?.maxClass ?? 0);

        // BLP check using precomputed vector
        if (classification < 2 && !isSecret && precomputedEmbedding) {
          const c2Rows = this.db.prepare(
            "SELECT classification, embedding FROM extracted_memories WHERE classification > ? AND user_id = ? AND embedding IS NOT NULL"
          ).all(classification, params.userId) as Array<{ classification: number; embedding: Buffer }>;
          for (const row of c2Rows) {
            const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
            let dot = 0, normA = 0, normB = 0;
            for (let i = 0; i < precomputedEmbedding.length; i++) { dot += precomputedEmbedding[i]! * stored[i]!; normA += precomputedEmbedding[i]! * precomputedEmbedding[i]!; normB += stored[i]! * stored[i]!; }
            const cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
            if (cosine >= 0.85) {
              classification = Math.max(classification, row.classification);
              break;
            }
          }
        }

        const insertResult = this.db.prepare(
          `INSERT INTO extracted_memories
             (user_id, content_original, content_en, memory_type, source_timestamp,
              preserve_original, preserved_keyword, emotion_score, created_at,
              confidence, source_message_ids, classification, trust, integrity, credibility,
              topic, tier, valid_from, emotion_tags, importance_flags, signature, emotion_context,
              encrypted, created_by, semantic_revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(
          params.userId, storeOriginal, contentEn,
          params.memoryType, now, 1, params.keyword?.trim() || null, emotionScore, now,
          params.confidence ?? 1, params.sourceMessageIds?.trim() || null,
          classification, params.trust ?? 0, params.integrity ?? 2, params.credibility ?? 6,
          topicVal, Math.abs(emotionScore) >= 4 ? "core" : "general", localDate(new Date(now)),
          emotionTags || null, importanceFlags || null, signature, params.emotionContext?.trim() || null,
          isSecret ? 1 : 0, params.createdBy ?? "unknown",
        );

        const memoryId = insertResult.lastInsertRowid as number;

        if (!isSecret && precomputedEmbedding) {
          this.db.prepare(
            "UPDATE extracted_memories SET embedding = ? WHERE id = ? AND user_id = ? AND semantic_revision = 1",
          ).run(Buffer.from(precomputedEmbedding.buffer), memoryId, params.userId);
        }

        // Contradiction invalidation inside transaction
        let contradicted: InstantStoreResult["contradicted"];
        if (topicVal !== "general" && !isSecret) {
          const existingRows = this.db.prepare(
            "SELECT id, content_en, topic, semantic_revision FROM extracted_memories WHERE user_id = ? AND topic = ? AND valid_to IS NULL AND content_en != ? ORDER BY created_at DESC LIMIT 20",
          ).all(params.userId, topicVal, contentEn) as Array<{ id: number; content_en: string; topic: string; semantic_revision: number }>;
          const hit = checkContradiction(contentEn, topicVal, existingRows);
          if (hit) {
            const existing = existingRows.find(row => row.id === hit.existingId);
            if (existing) {
              this.db.prepare("UPDATE extracted_memories SET valid_to = ?, semantic_revision = semantic_revision + 1, edited_at = ?, edited_by = ? WHERE id = ? AND user_id = ? AND semantic_revision = ?").run(localDate(new Date(now)), now, "contradiction-check", hit.existingId, params.userId, existing.semantic_revision);
              contradicted = { id: hit.existingId, content: hit.existingContent, reason: hit.reason };
            }
          }
        }

        // Source message redaction inside transaction
        if (isSecret) {
          const recentMessages = this.db.prepare(
            `SELECT id, content FROM messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?`,
          ).all(params.userId, SECRET_SCAN_WINDOW) as Array<{ id: number; content: string }>;
          for (const msg of recentMessages) {
            const redacted = redactSecrets(msg.content);
            if (redacted !== msg.content) {
              this.db.prepare("UPDATE messages SET content = ? WHERE id = ? AND user_id = ?").run(redacted, msg.id, params.userId);
            }
          }
        }

        return { stored: true, memoryId, semanticRevision: 1, contradicted };
      });

      const result = txnResult();
      if (result.stored) {
        logInfo(TAG, `Instant store: persisted memory for chat ${params.userId} (type=${params.memoryType}, emotion=${emotionScore})`);
      }
      return { stored: result.stored, memoriesCount: result.stored ? 1 : 0, memoryId: result.memoryId, semanticRevision: result.semanticRevision, contradicted: result.contradicted };
    } catch (err) {
      logError(TAG, `Instant store failed for chat ${params.userId}`, err);
      return { stored: false, memoriesCount: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  adjustRelevance(id: number, delta: number): void {
    this.editMemory({ memoryId: id, relevanceScore: `${delta >= 0 ? "+" : ""}${delta}` });
  }

  reclassifyMemory(id: number, level: number, userOverride = false): { ok: boolean; error?: string } {
    return this.editMemory({ memoryId: id, classification: level, userOverride });
  }

  mergeMemories(idA: number, idB: number): { merged: true; keptId: number; deletedId: number } | { merged: false; error: string } {
    const rows = this.db.prepare(
      "SELECT id, user_id, recall_count, relevance_score, confidence, created_at, semantic_revision FROM extracted_memories WHERE id IN (?, ?)",
    ).all(idA, idB) as Array<{ id: number; user_id: string; recall_count: number; relevance_score: number; confidence: number; created_at: number; semantic_revision: number }>;

    if (rows.length !== 2) return { merged: false, error: "one or both IDs not found" };
    if (rows[0]!.user_id !== rows[1]!.user_id) return { merged: false, error: "memories must belong to the same user" };
    const userId = rows[0]!.user_id;
    const [older, newer] = rows.sort((a, b) => a.created_at - b.created_at) as [typeof rows[0], typeof rows[0]];

    const txn = this.db.transaction(() => {
      const now = Date.now();
      const updateResult = this.db.prepare(`
        UPDATE extracted_memories SET
          recall_count = recall_count + ?, relevance_score = MAX(relevance_score, ?),
          confidence = MAX(confidence, ?), integrity = 3,
          edited_at = ?, edited_by = ?,
          semantic_revision = semantic_revision + 1
        WHERE id = ? AND user_id = ? AND semantic_revision = ?
      `).run(older!.recall_count ?? 0, older!.relevance_score ?? 0, older!.confidence ?? 3, now, "merge", newer!.id, userId, newer!.semantic_revision);

      if (updateResult.changes !== 1) return false;

      const deleteResult = this.db.prepare("DELETE FROM extracted_memories WHERE id = ? AND user_id = ?").run(older!.id, userId);
      if (deleteResult.changes !== 1) return false;

      return true;
    });

    if (!txn()) return { merged: false, error: "merge failed: revision conflict or not found" };

    const kept = this.db.prepare("SELECT content_en, user_id FROM extracted_memories WHERE id = ?").get(newer!.id) as { content_en: string; user_id: string } | undefined;
    if (kept) this.embedNewMemoryForRevision(kept.content_en, newer!.id, kept.user_id, newer!.semantic_revision + 1);

    return { merged: true, keptId: newer!.id, deletedId: older!.id };
  }

  cascadeDelete(messageIds: number[], userId: string): ForgetResult {
    const result: ForgetResult = { messagesRemoved: 0, embeddingsRemoved: 0, transcriptEntriesRemoved: 0 };
    if (messageIds.length === 0) return result;
    try {
      const ph = messageIds.map(() => "?").join(",");
      result.messagesRemoved = this.db.prepare(`DELETE FROM messages WHERE id IN (${ph}) AND user_id = ?`).run(...messageIds, userId).changes;
      logInfo(TAG, `Cascade delete for chat ${userId}: ${result.messagesRemoved} messages`);
    } catch (err) {
      logError(TAG, `Cascade delete failed for chat ${userId}`, err);
    }
    return result;
  }

  private embedNewMemoryForRevision(contentEn: string, memoryId: number, userId: string, sourceRevision: number): void {
    const cfg = loadEmbedConfig();
    if (!cfg.enabled) return;
    embedText(cfg, contentEn).then(vec => {
      if (!vec) return;
      this.db.prepare(
        "UPDATE extracted_memories SET embedding = ? WHERE id = ? AND user_id = ? AND semantic_revision = ?"
      ).run(Buffer.from(vec.buffer), memoryId, userId, sourceRevision);
    }).catch(() => {});
  }
}
