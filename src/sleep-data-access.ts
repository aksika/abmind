/**
 * sleep-data-access.ts — Database queries used by the sleep cycle.
 * Lives in the memory package so it can use raw DB internally.
 * Sleep imports this via IMemorySystem.getSleepData().
 */

import type Database from "better-sqlite3";
import { buildArc } from "./emotion-arc.js";
import { checkContradiction } from "./contradiction-checker.js";
import { hammingSimilarity } from "./signature-generator.js";
import { logWarn } from "./mem-logger.js";
import { PrivateMemoryMutationStore } from "./private-memory-mutation-store.js";
import type { PrivateMutationStatusV1 } from "./mem-types.js";
import { requirePrimaryUserId } from "./user-utils.js";

const TAG = "sleep-data";

export type SleepCandidateLists = {
  untaggedMemories: string;
  promotionCandidates: string;
  contradictions: string;
  mergeCandidates: string;
  translationIssues: string;
  emotionContextGaps: string;
  recallFeedback: string;
};

export type EmotionalProfileEntry = {
  topic: string;
  positive: number;
  negative: number;
  topTags: Array<{ tag: string; count: number }>;
  topContexts: string[];
};

export class SleepDataAccess {
  private readonly mutationStore: PrivateMemoryMutationStore;

  constructor(private readonly db: Database.Database) {
    this.mutationStore = new PrivateMemoryMutationStore(db);
  }

  /** Transitional: expose raw DB for callers not yet migrated (buildDailySummary). */
  getDb(): Database.Database { return this.db; }

  /**
   * #1608: the ONLY canonical primary-user identity is ABMIND_USER_ID.
   * The old `SELECT DISTINCT user_id FROM messages LIMIT 1` fallback is gone:
   * it silently picked the first-inserted user row (e.g. "adrika") while the
   * real user's messages went unread. Callers must resolve the identity via
   * ensurePrimaryUserId() (env wins, else the saved manifest.json
   * encryptionUser) before the sleep cycle starts — missing identity fails
   * clearly here.
   */
  getPrimaryUserId(): string {
    return requirePrimaryUserId();
  }

  getExtractionWatermark(userId: string): number {
    const row = this.db.prepare("SELECT last_processed_timestamp FROM extraction_watermarks WHERE user_id = ?").get(userId) as { last_processed_timestamp: number } | undefined;
    return row?.last_processed_timestamp ?? 0;
  }

  getFirstMessageAfter(userId: string, afterTs: number): number | null {
    const row = this.db.prepare("SELECT MIN(timestamp) as ts FROM messages WHERE user_id = ? AND timestamp > ?").get(userId, afterTs) as { ts: number | null } | undefined;
    return row?.ts ?? null;
  }

  /**
   * Advance every message author's extraction watermark to `throughTs`.
   * Monotonic: a lower value never regresses an existing watermark (#1603).
   */
  advanceExtractionWatermarks(throughTs: number): number {
    const userIds = this.db.prepare("SELECT DISTINCT user_id FROM messages").all() as { user_id: string }[];
    for (const { user_id } of userIds) {
      this.db.prepare(
        `INSERT INTO extraction_watermarks (user_id, last_processed_timestamp) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET last_processed_timestamp =
           MAX(extraction_watermarks.last_processed_timestamp, excluded.last_processed_timestamp)`,
      ).run(user_id, throughTs);
    }
    return userIds.length;
  }

  getMessagesAfter(afterTs: number, userId?: string): Array<{ id: number; role: string; content: string; emotion_score: number | null }> {
    const userFilter = userId ? " AND user_id = ?" : "";
    const params: unknown[] = userId ? [afterTs, userId] : [afterTs];
    return this.db.prepare(
      `SELECT id, role, content, emotion_score FROM messages WHERE timestamp > ?${userFilter} AND (session_id LIKE '%\\_A\\_%' ESCAPE '\\' OR session_id LIKE '%\\_C\\_%' ESCAPE '\\' OR session_id = '' OR session_id NOT LIKE '%\\_%\\_%' ESCAPE '\\') ORDER BY timestamp`,
    ).all(...params) as Array<{ id: number; role: string; content: string; emotion_score: number | null }>;
  }

  getShortMessageCount(): number {
    return (this.db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE role='user' AND length(content) < 20").get() as { cnt: number }).cnt;
  }

  deleteMessagesByIds(ids: number[]): void {
    if (ids.length === 0) return;
    this.db.prepare(`DELETE FROM messages WHERE id IN (${ids.join(",")})`).run();
  }

  /**
   * Age alone never authorizes deletion (#1603): only messages at or below
   * their user's extraction watermark may be removed. An unextracted message
   * survives both the age sweep and the count cap.
   */
  flushOldMessages(opts: { maxAgeDays: number; maxCount: number }): { agedOut: number; capped: number } {
    const ageCutoff = Date.now() - opts.maxAgeDays * 86400000;
    const watermarkGuard = `timestamp <= COALESCE(
      (SELECT w.last_processed_timestamp FROM extraction_watermarks w WHERE w.user_id = messages.user_id), 0)`;
    const agedOut = this.db.prepare(`DELETE FROM messages WHERE timestamp < ? AND ${watermarkGuard}`).run(ageCutoff).changes;
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c;
    let capped = 0;
    if (total > opts.maxCount) {
      capped = this.db.prepare(
        `DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY timestamp ASC LIMIT ?) AND ${watermarkGuard}`,
      ).run(total - opts.maxCount).changes;
    }
    return { agedOut, capped };
  }

  buildEmotionArcs(): number {
    const topics = this.db.prepare(
      "SELECT DISTINCT user_id, topic FROM extracted_memories WHERE topic IS NOT NULL AND emotion_tags IS NOT NULL AND emotion_tags != ''",
    ).all() as Array<{ user_id: string; topic: string }>;
    let updated = 0;
    for (const { user_id: userId, topic } of topics) {
      const memories = this.db.prepare(
        "SELECT emotion_tags, created_at FROM extracted_memories WHERE user_id = ? AND topic = ? AND emotion_tags IS NOT NULL AND emotion_tags != '' ORDER BY created_at ASC",
      ).all(userId, topic) as Array<{ emotion_tags: string; created_at: number }>;
      if (memories.length < 2) continue;
      const arc = buildArc(memories);
      const target = this.db.prepare(
        "SELECT id, semantic_revision FROM extracted_memories WHERE user_id = ? AND topic = ? AND valid_to IS NULL ORDER BY created_at DESC LIMIT 1",
      ).get(userId, topic) as { id: number; semantic_revision: number } | undefined;
      if (target) {
        const result = this.mutationStore.edit(
          { userId, actorId: "sleep:emotion-arc", operationKey: `sleep-emotion-arc-${target.id}-${target.semantic_revision}`, canDeclassifySecret: false, origin: "dreamy" },
          { userId, memoryId: target.id, expectedRevision: target.semantic_revision, emotionArc: arc.symbol },
        );
        if (result.ok) updated++;
      }
    }
    return updated;
  }

  invalidateMemory(userId: string, memoryId: number, expectedRevision: number, validTo: string, actorId: string): PrivateMutationStatusV1 {
    return this.mutationStore.edit(
      { userId, actorId, operationKey: `${actorId}-${memoryId}-${expectedRevision}`, canDeclassifySecret: false, origin: "dreamy" },
      { userId, memoryId, expectedRevision, validTo },
    );
  }

  getEmotionalProfileData(userId: string): EmotionalProfileEntry[] {
    const rows = this.db.prepare(
      "SELECT topic, emotion_tags, emotion_context, created_at FROM extracted_memories WHERE user_id = ? AND emotion_tags IS NOT NULL AND emotion_tags != '' ORDER BY created_at DESC LIMIT 200",
    ).all(userId) as Array<{ topic: string; emotion_tags: string; emotion_context: string | null; created_at: number }>;
    if (rows.length < 10) return [];

    const positiveTags = new Set(["joy", "pride", "excitement", "relief", "gratitude", "love", "hope", "humor"]);
    const topicMap = new Map<string, { positive: number; negative: number; tags: Map<string, number>; contexts: string[] }>();

    for (const r of rows) {
      let entry = topicMap.get(r.topic);
      if (!entry) { entry = { positive: 0, negative: 0, tags: new Map(), contexts: [] }; topicMap.set(r.topic, entry); }
      for (const tag of r.emotion_tags.split(",").map(t => t.trim()).filter(Boolean)) {
        entry.tags.set(tag, (entry.tags.get(tag) ?? 0) + 1);
        if (positiveTags.has(tag)) entry.positive++; else entry.negative++;
      }
      if (r.emotion_context) entry.contexts.push(r.emotion_context);
    }

    return [...topicMap.entries()]
      .sort((a, b) => (b[1].positive + b[1].negative) - (a[1].positive + a[1].negative))
      .slice(0, 5)
      .map(([topic, data]) => ({
        topic,
        positive: data.positive,
        negative: data.negative,
        topTags: [...data.tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tag, count]) => ({ tag, count })),
        topContexts: [...new Set(data.contexts)].slice(0, 3),
      }));
  }

  buildSleepCandidates(currentModel: string, userId: string): SleepCandidateLists {
    const lists: SleepCandidateLists = { untaggedMemories: "", promotionCandidates: "", contradictions: "", mergeCandidates: "", translationIssues: "", emotionContextGaps: "", recallFeedback: "" };
    const skip = (editedBy: string | null): boolean => {
      if (!editedBy?.includes(":attempt:")) return false;
      const [model, attempts] = editedBy.split(":attempt:");
      return (parseInt(attempts!) || 0) >= 3 && model === currentModel;
    };
    try {
      const untagged = this.db.prepare(
        "SELECT id, substr(content_en,1,100) as preview, edited_by FROM extracted_memories WHERE user_id = ? AND (topic IS NULL OR topic = 'general') AND content_en IS NOT NULL LIMIT 30",
      ).all(userId) as Array<{ id: number; preview: string; edited_by: string | null }>;
      const filteredUntagged = untagged.filter(r => !skip(r.edited_by));
      if (filteredUntagged.length > 0) lists.untaggedMemories = filteredUntagged.slice(0, 20).map(r => `#${r.id}: ${r.preview}`).join("\n");

      const promote = this.db.prepare(
        "SELECT id, topic, substr(content_en,1,300) as preview, recall_count, confidence FROM extracted_memories WHERE user_id = ? AND tier = 'general' AND recall_count >= 2 AND confidence >= 3 AND valid_to IS NULL ORDER BY recall_count DESC LIMIT 15",
      ).all(userId) as Array<{ id: number; topic: string; preview: string; recall_count: number; confidence: number }>;
      if (promote.length > 0) lists.promotionCandidates = promote.map(r => `#${r.id} [${r.topic}] (recall:${r.recall_count}, conf:${r.confidence}): ${r.preview}`).join("\n");

      // Contradiction check on promotion candidates
      if (promote.length > 0) {
        try {
          
          const core = this.db.prepare(
            "SELECT id, content_en, topic FROM extracted_memories WHERE user_id = ? AND tier = 'core' AND valid_to IS NULL AND content_en IS NOT NULL",
          ).all(userId) as Array<{ id: number; content_en: string; topic: string }>;
          const hits: string[] = [];
          for (const c of promote) {
            const hit = checkContradiction(c.preview, c.topic, core);
            if (hit) hits.push(`#${c.id} contradicts #${hit.existingId}: ${hit.reason}`);
          }
          if (hits.length > 0) {
            lists.contradictions = hits.join("\n");
            logWarn(TAG, `${hits.length} contradiction(s) flagged in promotion candidates`);
          }
        } catch { /* contradiction checker not available */ }
      }

      try {
        
        const sigs = this.db.prepare(
          "SELECT id, topic, signature, substr(content_en,1,80) as preview, edited_by FROM extracted_memories WHERE user_id = ? AND signature IS NOT NULL AND valid_to IS NULL ORDER BY topic",
        ).all(userId) as Array<{ id: number; topic: string; signature: Buffer; preview: string; edited_by: string | null }>;
        const pairs: string[] = [];
        for (let i = 0; i < sigs.length && pairs.length < 10; i++) {
          if (skip(sigs[i]!.edited_by)) continue;
          for (let j = i + 1; j < sigs.length && pairs.length < 10; j++) {
            if (skip(sigs[j]!.edited_by)) continue;
            if (sigs[i]!.topic !== sigs[j]!.topic) continue;
            const sim = hammingSimilarity(new Uint8Array(sigs[i]!.signature), new Uint8Array(sigs[j]!.signature));
            if (sim > 0.8) pairs.push(`#${sigs[i]!.id} ↔ #${sigs[j]!.id} (${(sim * 100).toFixed(0)}%): "${sigs[i]!.preview}" vs "${sigs[j]!.preview}"`);
          }
        }
        if (pairs.length > 0) lists.mergeCandidates = pairs.join("\n");
      } catch { /* signature module not available */ }

      const translation = this.db.prepare(
        "SELECT id, substr(content_en,1,80) as en, substr(content_original,1,80) as orig, edited_by FROM extracted_memories WHERE user_id = ? AND content_original IS NOT NULL AND content_en IS NOT NULL AND length(content_en) > 0 AND (length(content_en) < length(content_original) * 0.3 OR length(content_en) > length(content_original) * 3) LIMIT 15",
      ).all(userId) as Array<{ id: number; en: string; orig: string; edited_by: string | null }>;
      const filteredTrans = translation.filter(r => !skip(r.edited_by));
      if (filteredTrans.length > 0) lists.translationIssues = filteredTrans.slice(0, 10).map(r => `#${r.id}: EN="${r.en}" ORIG="${r.orig}"`).join("\n");

      const gaps = this.db.prepare(
        "SELECT id, substr(content_en,1,100) as preview, emotion_tags, edited_by FROM extracted_memories WHERE user_id = ? AND emotion_tags IS NOT NULL AND emotion_tags != '' AND emotion_context IS NULL LIMIT 20",
      ).all(userId) as Array<{ id: number; preview: string; emotion_tags: string; edited_by: string | null }>;
      const filteredGaps = gaps.filter(r => !skip(r.edited_by));
      if (filteredGaps.length > 0) lists.emotionContextGaps = filteredGaps.slice(0, 15).map(r => `#${r.id} [${r.emotion_tags}]: ${r.preview}`).join("\n");

      const today = new Date(); today.setHours(0, 0, 0, 0);
      const recalls = this.db.prepare(
        "SELECT id, substr(content_en,1,80) as preview, recall_count, last_recalled_at FROM extracted_memories WHERE user_id = ? AND last_recalled_at > ? ORDER BY last_recalled_at DESC LIMIT 15",
      ).all(userId, today.getTime()) as Array<{ id: number; preview: string; recall_count: number; last_recalled_at: number }>;
      if (recalls.length > 0) lists.recallFeedback = recalls.map(r => `#${r.id} (recalled ${r.recall_count}x): ${r.preview}`).join("\n");
    } catch (err) { logWarn(TAG, `buildSleepCandidates failed: ${err instanceof Error ? err.message : String(err)}`); }
    return lists;
  }

  markCurationAttempt(ids: number[], model: string, userId?: string): void {
    if (!userId?.trim()) return;
    const stmt = this.db.prepare("SELECT id, edited_by FROM extracted_memories WHERE id = ? AND user_id = ?");
    const update = this.db.prepare("UPDATE extracted_memories SET edited_by = ?, edited_at = ? WHERE id = ? AND user_id = ?");
    const now = Date.now();
    for (const id of ids) {
      const row = stmt.get(id, userId) as { id: number; edited_by: string | null } | undefined;
      if (!row) continue;
      let count = 1;
      if (row.edited_by?.includes(":attempt:")) {
        count = (parseInt(row.edited_by.split(":attempt:")[1]!) || 0) + 1;
      }
      update.run(`${model}:attempt:${count}`, now, id, userId);
    }
  }

  markCurationSuccess(ids: number[], model: string, userId?: string): void {
    if (!userId?.trim()) return;
    const update = this.db.prepare("UPDATE extracted_memories SET edited_by = ?, edited_at = ? WHERE id = ? AND user_id = ?");
    const now = Date.now();
    for (const id of ids) update.run(model, now, id, userId);
  }

  // ── #1658 strict-owner Dreamy seam ─────────────────────────────────────────
  // Every read below is scoped to the caller's primaryUserId. The orchestrator
  // must not keep parallel raw unscoped SQL for the same content.

  /** New non-observation extractions for the owner since `sinceTs` (evidence). */
  getContradictionEvidence(
    userId: string,
    sinceTs: number,
  ): Array<{ id: number; content_en: string; memory_type: string; topic: string | null; trust: number; semantic_revision: number }> {
    return this.db.prepare(
      `SELECT id, content_en, memory_type, topic, trust, semantic_revision
       FROM extracted_memories WHERE user_id = ? AND created_at >= ? AND memory_type != 'observation'
       ORDER BY created_at DESC LIMIT 30`,
    ).all(userId, sinceTs) as Array<{ id: number; content_en: string; memory_type: string; topic: string | null; trust: number; semantic_revision: number }>;
  }

  /** FTS contradiction candidates for the owner, excluding one evidence row. */
  getContradictionCandidates(
    userId: string,
    keywords: string,
    excludeId: number,
    minTrust: number,
    limit = 5,
  ): Array<{ id: number; content_en: string; memory_type: string; trust: number; credibility: number; semantic_revision: number }> {
    return this.db.prepare(
      `SELECT em.id, em.content_en, em.memory_type, em.trust, em.credibility, em.semantic_revision
       FROM extracted_memories em JOIN extracted_memories_fts fts ON em.id = fts.rowid
       WHERE extracted_memories_fts MATCH ? AND em.id != ? AND em.user_id = ? AND em.trust >= ?
         AND em.memory_type != 'observation' AND em.valid_to IS NULL LIMIT ${Math.max(1, Math.min(limit, 20))}`,
    ).all(keywords, excludeId, userId, minTrust) as Array<{ id: number; content_en: string; memory_type: string; trust: number; credibility: number; semantic_revision: number }>;
  }

  /** Current-run attribution: the owner's non-observation rows in the run window. */
  getCurrentRunNewIds(userId: string, fromTs: number, toTs: number, ids: readonly number[]): number[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT id FROM extracted_memories WHERE user_id = ? AND created_at >= ? AND created_at <= ?
         AND memory_type != 'observation' AND id IN (${placeholders})`,
    ).all(userId, fromTs, toTs, ...ids) as Array<{ id: number }>;
    return rows.map((row) => row.id);
  }

  /** REM synthesis sample — owner-scoped. */
  getRemSample(userId: string, limit: number): Array<{ id: number; content_en: string; memory_type: string; created_at: number }> {
    return this.db.prepare(
      `SELECT id, content_en, memory_type, created_at FROM extracted_memories
       WHERE user_id = ? AND trust >= 2 AND memory_type != 'observation' AND valid_to IS NULL
       ORDER BY RANDOM() LIMIT ${Math.max(1, Math.min(limit, 50))}`,
    ).all(userId) as Array<{ id: number; content_en: string; memory_type: string; created_at: number }>;
  }

  /**
   * Contradiction target lookup — (id, user_id, valid_to, classification)
   * eligible rows only. Returns the semantic revision; ownership is re-verified
   * atomically by the mutation store's CAS.
   */
  getContradictionTarget(userId: string, memoryId: number): { semantic_revision: number } | undefined {
    return this.db.prepare(
      `SELECT semantic_revision FROM extracted_memories
       WHERE id = ? AND user_id = ? AND valid_to IS NULL AND classification < 3`,
    ).get(memoryId, userId) as { semantic_revision: number } | undefined;
  }

  /** Faded event selection — owner-scoped. */
  getDecayCandidates(userId: string, beforeTs: number): Array<{ id: number; recall_count: number; created_at: number }> {
    return this.db.prepare(
      `SELECT id, recall_count, created_at FROM extracted_memories
       WHERE user_id = ? AND memory_type = 'event' AND valid_to IS NULL AND created_at < ?`,
    ).all(userId, beforeTs) as Array<{ id: number; recall_count: number; created_at: number }>;
  }

  /** Decay target lookup — (id, user_id, valid_to) eligible rows only. */
  getDecayTarget(userId: string, memoryId: number): { semantic_revision: number } | undefined {
    return this.db.prepare(
      "SELECT semantic_revision FROM extracted_memories WHERE id = ? AND user_id = ? AND valid_to IS NULL",
    ).get(memoryId, userId) as { semantic_revision: number } | undefined;
  }

  /** Owner-scoped pair read for ask-candidate evaluation. */
  getEvidencePair(userId: string, ids: readonly number[]): Array<{ id: number; valid_to: string | null; classification: number; semantic_revision: number }> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT id, valid_to, classification, semantic_revision FROM extracted_memories
       WHERE id IN (${placeholders}) AND user_id = ?`,
    ).all(...ids, userId) as Array<{ id: number; valid_to: string | null; classification: number; semantic_revision: number }>;
  }
}
