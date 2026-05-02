import { localDate } from "./local-time.js";
import type Database from "better-sqlite3";
import type { InstantStoreParams, InstantStoreResult, EditMemoryParams, EditMemoryResult, ForgetResult } from "./mem-types.js";
import { clampEmotionScore, scoreFromTags } from "./emotion-utils.js";
import { loadEmbedConfig, embedText } from "./ollama-embed.js";
import { logError, logInfo } from "./mem-logger.js";
import { detectEmotions } from "./emotion-tagger.js";
import { detectFlags } from "./importance-flagger.js";
import { generateSignature } from "./signature-generator.js";
import { encrypt, loadKey } from "./crypto.js";
import { redactSecrets } from "./redact-secrets.js";

const TAG = "memory-editor";

/** #354: scan window for recent-message credential redaction on class=3 stores. */
const SECRET_SCAN_WINDOW = 10;

/** Handles all mutations on extracted memories: edit, store, merge, delete. */
export class MemoryEditor {
  constructor(private readonly db: Database.Database) {}

  /** Edit an existing extracted memory. Unified mutation path for all field updates. */
  editMemory(params: EditMemoryParams): EditMemoryResult {
    try {
      let targetIds: number[];
      if (params.memoryId != null) {
        targetIds = [params.memoryId];
      } else if (params.messageId != null && params.userId != null) {
        const msg = this.db.prepare(
          "SELECT id FROM messages WHERE user_id = ? AND platform_message_id = ?",
        ).get(params.userId, params.messageId) as { id: number } | undefined;
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
        const valid = new Set(["fact", "decision", "preference", "event", "lesson", "feedback", "story"]);
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

      const now = Date.now();
      const editedBy = params.caller ?? null;
      const contentChanged = params.contentEn != null;

      for (const id of targetIds) {
        const row = this.db.prepare("SELECT classification, content_en, content_original FROM extracted_memories WHERE id = ?").get(id) as { classification: number; content_en: string; content_original: string } | undefined;
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

        // Encrypt on promote to SECRET
        const promotingToSecret = params.classification === 3 && row.classification < 3;
        if (promotingToSecret) {
          try { loadKey(); } catch { return { ok: false, error: "no encryption key — cannot promote to SECRET" }; }
          finalSets.push("content_en = ?", "content_original = ?", "encrypted = ?", "embedding = NULL");
          finalValues.push(encrypt(row.content_en), encrypt(row.content_original), 1);
        }

        finalSets.push("edited_at = ?", "edited_by = ?");
        finalValues.push(now, editedBy);
        if (contentChanged && !promotingToSecret) finalSets.push("embedding = NULL");

        finalValues.push(id);
        this.db.prepare(`UPDATE extracted_memories SET ${finalSets.join(", ")} WHERE id = ?`).run(...finalValues);

        if (promotingToSecret) {
          // Remove from all FTS indexes
          this.db.prepare("INSERT INTO extracted_memories_fts(extracted_memories_fts, rowid, content_en) VALUES('delete', ?, ?)").run(id, "");
          this.db.prepare("DELETE FROM content_en_trigram WHERE rowid = ?").run(id);
          this.db.prepare("DELETE FROM content_original_trigram WHERE rowid = ?").run(id);
        } else if (contentChanged && params.contentEn) {
          this.embedNewMemory(params.contentEn.trim());
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

  /** Immediately persist a memory from the agent's instant_store tool. */
  async instantStore(params: InstantStoreParams): Promise<InstantStoreResult> {
    try {
      if (!params.contentEn?.trim()) return { stored: false, memoriesCount: 0, error: "content-en is required" };
      if (!params.contentOriginal?.trim()) return { stored: false, memoriesCount: 0, error: "content-original is required" };
      const validTypes = new Set(["fact", "decision", "preference", "event", "lesson", "feedback", "story"]);
      if (!validTypes.has(params.memoryType)) return { stored: false, memoriesCount: 0, error: "invalid memory_type" };

      const now = Date.now();
      const contentEn = params.contentEn.trim();

      // Dedup: skip if identical content stored within last 60s
      const recent = this.db.prepare(
        "SELECT id FROM extracted_memories WHERE content_en = ? AND created_at > ? LIMIT 1",
      ).get(contentEn, now - 60_000) as { id: number } | undefined;
      if (recent) return { stored: true, memoriesCount: 0, error: "duplicate (skipped)" };

      // ABM v2: store-time enrichment (~1-5ms total)
      const emotionTags = params.emotionTags ?? detectEmotions(contentEn).join(",");
      const emotionScore = scoreFromTags(emotionTags) || clampEmotionScore(params.emotionScore);
      const importanceFlags = detectFlags(contentEn).join(",");
      const topicVal = params.topic ?? "general";
      const signature = Buffer.from(generateSignature(contentEn));

      const isSecret = (params.classification ?? 1) === 3;
      if (isSecret) {
        try { loadKey(); } catch { return { stored: false, memoriesCount: 0, error: "no encryption key — cannot store SECRET" }; }
      }

      const storeEn = isSecret ? encrypt(contentEn) : contentEn;
      const storeOriginal = isSecret ? encrypt(params.contentOriginal.trim()) : params.contentOriginal.trim();

      this.db.prepare(
        `INSERT INTO extracted_memories
           (user_id, content_original, content_en, memory_type, source_timestamp,
            preserve_original, preserved_keyword, emotion_score, created_at,
            confidence, source_message_ids, classification, trust, integrity, credibility,
            topic, tier, valid_from, emotion_tags, importance_flags, signature, emotion_context, encrypted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        params.userId, storeOriginal, storeEn,
        params.memoryType, now, 1, params.keyword?.trim() || null, emotionScore, now,
        params.confidence ?? 3, params.sourceMessageIds?.trim() || null,
        params.classification ?? 1, params.trust ?? 0, params.integrity ?? 2, params.credibility ?? 6,
        topicVal, Math.abs(emotionScore) >= 4 ? "core" : "general", localDate(new Date(now)),
        emotionTags || null, importanceFlags || null, signature, params.emotionContext?.trim() || null,
        isSecret ? 1 : 0,
      );

      // Remove from FTS if encrypted (content is ciphertext, not searchable)
      if (isSecret) {
        const row = this.db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
        this.db.prepare("INSERT INTO extracted_memories_fts(extracted_memories_fts, rowid, content_en) VALUES('delete', ?, ?)").run(row.id, storeEn);
        this.db.prepare("DELETE FROM content_en_trigram WHERE rowid = ?").run(row.id);
        this.db.prepare("DELETE FROM content_original_trigram WHERE rowid = ?").run(row.id);
      }

      if (!isSecret) this.embedNewMemory(params.contentEn.trim());

      // #354: when a credential is stored as class=3, scan the last N messages for this user
      // and redact any pattern matches. The triggering message is almost always in the window.
      if (isSecret) {
        try {
          const recent = this.db.prepare(
            `SELECT id, content FROM messages
              WHERE user_id = ?
              ORDER BY timestamp DESC
              LIMIT ?`,
          ).all(params.userId, SECRET_SCAN_WINDOW) as Array<{ id: number; content: string }>;

          let redactedCount = 0;
          for (const msg of recent) {
            const redacted = redactSecrets(msg.content);
            if (redacted !== msg.content) {
              this.db.prepare("UPDATE messages SET content = ? WHERE id = ?").run(redacted, msg.id);
              redactedCount++;
            }
          }
          if (redactedCount > 0) {
            logInfo(TAG, `[redact-source] redacted credentials from ${redactedCount} recent message(s) for chat ${params.userId}`);
          }
        } catch (err) {
          // Scan failure must not block the store — the memory is already persisted.
          logError(TAG, `[redact-source] scan failed for chat ${params.userId}`, err);
        }
      }

      logInfo(TAG, `Instant store: persisted memory for chat ${params.userId} (type=${params.memoryType}, emotion=${emotionScore})`);
      return { stored: true, memoriesCount: 1 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(TAG, `Instant store failed for chat ${params.userId}`, err);
      return { stored: false, memoriesCount: 0, error: message };
    }
  }

  /** Adjust relevance_score on an existing extracted memory. */
  adjustRelevance(id: number, delta: number): void {
    this.editMemory({ memoryId: id, relevanceScore: `${delta >= 0 ? "+" : ""}${delta}` });
  }

  /** Reclassify a memory's confidentiality level. */
  reclassifyMemory(id: number, level: number, userOverride = false): { ok: boolean; error?: string } {
    return this.editMemory({ memoryId: id, classification: level, userOverride });
  }

  /** Merge two extracted memories: keep newer, combine Darwinism scores, delete older. */
  mergeMemories(idA: number, idB: number): { merged: boolean; keptId: number; deletedId: number } | { merged: false; error: string } {
    const rows = this.db.prepare(
      "SELECT id, recall_count, relevance_score, confidence, created_at FROM extracted_memories WHERE id IN (?, ?)",
    ).all(idA, idB) as Array<{ id: number; recall_count: number; relevance_score: number; confidence: number; created_at: number }>;

    if (rows.length !== 2) return { merged: false, error: "one or both IDs not found" };
    const [older, newer] = rows.sort((a, b) => a.created_at - b.created_at) as [typeof rows[0], typeof rows[0]];

    this.db.prepare(`
      UPDATE extracted_memories SET
        recall_count = recall_count + ?, relevance_score = MAX(relevance_score, ?),
        confidence = MAX(confidence, ?), integrity = 3
      WHERE id = ?
    `).run(older!.recall_count ?? 0, older!.relevance_score ?? 0, older!.confidence ?? 3, newer!.id);

    this.db.prepare("DELETE FROM extracted_memories WHERE id = ?").run(older!.id);

    const kept = this.db.prepare("SELECT content_en FROM extracted_memories WHERE id = ?").get(newer!.id) as { content_en: string } | undefined;
    if (kept) this.embedNewMemory(kept.content_en);

    return { merged: true, keptId: newer!.id, deletedId: older!.id };
  }

  /** Cascade deletion through all storage layers for the given message IDs. */
  cascadeDelete(messageIds: number[], userId: string): ForgetResult {
    const result: ForgetResult = { messagesRemoved: 0, embeddingsRemoved: 0, transcriptEntriesRemoved: 0 };
    if (messageIds.length === 0) return result;
    try {
      const ph = messageIds.map(() => "?").join(",");
      result.messagesRemoved = this.db.prepare(`DELETE FROM messages WHERE id IN (${ph})`).run(...messageIds).changes;
      logInfo(TAG, `Cascade delete for chat ${userId}: ${result.messagesRemoved} messages`);
    } catch (err) {
      logError(TAG, `Cascade delete failed for chat ${userId}`, err);
    }
    return result;
  }

  /** Embed a newly inserted memory (fire-and-forget). */
  private embedNewMemory(contentEn: string): void {
    const cfg = loadEmbedConfig();
    if (!cfg.enabled) return;
    embedText(cfg, contentEn).then(vec => {
      if (!vec) return;
      this.db.prepare(
        "UPDATE extracted_memories SET embedding = ? WHERE content_en = ? AND embedding IS NULL"
      ).run(Buffer.from(vec.buffer), contentEn);
    }).catch(() => {});
  }
}
