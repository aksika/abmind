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
  constructor(private readonly db: Database.Database) {}

  /** Transitional: expose raw DB for callers not yet migrated (buildDailySummary). */
  getDb(): Database.Database { return this.db; }

  getPrimaryUserId(): string {
    const fromEnv = process.env["ABMIND_USER_ID"];
    if (fromEnv) return fromEnv;
    try {
      const row = this.db.prepare("SELECT DISTINCT user_id FROM messages LIMIT 1").get() as { user_id: string } | undefined;
      if (row?.user_id) return row.user_id;
    } catch { /* */ }
    throw new Error("No user_id found. Set ABMIND_USER_ID env var or ensure messages exist in the DB.");
  }

  getExtractionWatermark(userId: string): number {
    const row = this.db.prepare("SELECT last_processed_timestamp FROM extraction_watermarks WHERE user_id = ?").get(userId) as { last_processed_timestamp: number } | undefined;
    return row?.last_processed_timestamp ?? 0;
  }

  getFirstMessageAfter(userId: string, afterTs: number): number | null {
    const row = this.db.prepare("SELECT MIN(timestamp) as ts FROM messages WHERE user_id = ? AND timestamp > ?").get(userId, afterTs) as { ts: number | null } | undefined;
    return row?.ts ?? null;
  }

  advanceExtractionWatermarks(): number {
    const userIds = this.db.prepare("SELECT DISTINCT user_id FROM messages").all() as { user_id: string }[];
    const now = Date.now();
    for (const { user_id } of userIds) {
      this.db.prepare(
        `INSERT INTO extraction_watermarks (user_id, last_processed_timestamp) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_processed_timestamp = excluded.last_processed_timestamp`,
      ).run(user_id, now);
    }
    return userIds.length;
  }

  getMessagesAfter(afterTs: number): Array<{ id: number; role: string; content: string; emotion_score: number | null }> {
    return this.db.prepare(
      "SELECT id, role, content, emotion_score FROM messages WHERE timestamp > ? AND (session_id LIKE '%\\_A\\_%' ESCAPE '\\' OR session_id LIKE '%\\_C\\_%' ESCAPE '\\' OR session_id = '' OR session_id NOT LIKE '%\\_%\\_%' ESCAPE '\\') ORDER BY timestamp",
    ).all(afterTs) as Array<{ id: number; role: string; content: string; emotion_score: number | null }>;
  }

  getShortMessageCount(): number {
    return (this.db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE role='user' AND length(content) < 20").get() as { cnt: number }).cnt;
  }

  deleteMessagesByIds(ids: number[]): void {
    if (ids.length === 0) return;
    this.db.prepare(`DELETE FROM messages WHERE id IN (${ids.join(",")})`).run();
  }

  flushOldMessages(opts: { maxAgeDays: number; maxCount: number }): { agedOut: number; capped: number } {
    const ageCutoff = Date.now() - opts.maxAgeDays * 86400000;
    const agedOut = this.db.prepare("DELETE FROM messages WHERE timestamp < ?").run(ageCutoff).changes;
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c;
    let capped = 0;
    if (total > opts.maxCount) {
      capped = this.db.prepare("DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY timestamp ASC LIMIT ?)").run(total - opts.maxCount).changes;
    }
    return { agedOut, capped };
  }

  buildEmotionArcs(): number {
    const topics = this.db.prepare(
      "SELECT DISTINCT topic FROM extracted_memories WHERE topic IS NOT NULL AND emotion_tags IS NOT NULL AND emotion_tags != ''",
    ).all() as Array<{ topic: string }>;
    let updated = 0;
    for (const { topic } of topics) {
      const memories = this.db.prepare(
        "SELECT emotion_tags, created_at FROM extracted_memories WHERE topic = ? AND emotion_tags IS NOT NULL AND emotion_tags != '' ORDER BY created_at ASC",
      ).all(topic) as Array<{ emotion_tags: string; created_at: number }>;
      if (memories.length < 2) continue;
      const arc = buildArc(memories);
      const target = this.db.prepare(
        "SELECT id FROM extracted_memories WHERE topic = ? AND valid_to IS NULL ORDER BY created_at DESC LIMIT 1",
      ).get(topic) as { id: number } | undefined;
      if (target) {
        this.db.prepare("UPDATE extracted_memories SET emotion_arc = ? WHERE id = ?").run(arc.symbol, target.id);
        updated++;
      }
    }
    return updated;
  }

  getEmotionalProfileData(): EmotionalProfileEntry[] {
    const rows = this.db.prepare(
      "SELECT topic, emotion_tags, emotion_context, created_at FROM extracted_memories WHERE emotion_tags IS NOT NULL AND emotion_tags != '' ORDER BY created_at DESC LIMIT 200",
    ).all() as Array<{ topic: string; emotion_tags: string; emotion_context: string | null; created_at: number }>;
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

  buildSleepCandidates(currentModel: string): SleepCandidateLists {
    const lists: SleepCandidateLists = { untaggedMemories: "", promotionCandidates: "", contradictions: "", mergeCandidates: "", translationIssues: "", emotionContextGaps: "", recallFeedback: "" };
    const skip = (editedBy: string | null): boolean => {
      if (!editedBy?.includes(":attempt:")) return false;
      const [model, attempts] = editedBy.split(":attempt:");
      return (parseInt(attempts!) || 0) >= 3 && model === currentModel;
    };
    try {
      const untagged = this.db.prepare(
        "SELECT id, substr(content_en,1,100) as preview, edited_by FROM extracted_memories WHERE (topic IS NULL OR topic = 'general') AND content_en IS NOT NULL LIMIT 30",
      ).all() as Array<{ id: number; preview: string; edited_by: string | null }>;
      const filteredUntagged = untagged.filter(r => !skip(r.edited_by));
      if (filteredUntagged.length > 0) lists.untaggedMemories = filteredUntagged.slice(0, 20).map(r => `#${r.id}: ${r.preview}`).join("\n");

      const promote = this.db.prepare(
        "SELECT id, topic, substr(content_en,1,300) as preview, recall_count, confidence FROM extracted_memories WHERE tier = 'general' AND recall_count >= 2 AND confidence >= 3 AND valid_to IS NULL ORDER BY recall_count DESC LIMIT 15",
      ).all() as Array<{ id: number; topic: string; preview: string; recall_count: number; confidence: number }>;
      if (promote.length > 0) lists.promotionCandidates = promote.map(r => `#${r.id} [${r.topic}] (recall:${r.recall_count}, conf:${r.confidence}): ${r.preview}`).join("\n");

      // Contradiction check on promotion candidates
      if (promote.length > 0) {
        try {
          
          const core = this.db.prepare(
            "SELECT id, content_en, topic FROM extracted_memories WHERE tier = 'core' AND valid_to IS NULL AND content_en IS NOT NULL",
          ).all() as Array<{ id: number; content_en: string; topic: string }>;
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
          "SELECT id, topic, signature, substr(content_en,1,80) as preview, edited_by FROM extracted_memories WHERE signature IS NOT NULL AND valid_to IS NULL ORDER BY topic",
        ).all() as Array<{ id: number; topic: string; signature: Buffer; preview: string; edited_by: string | null }>;
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
        "SELECT id, substr(content_en,1,80) as en, substr(content_original,1,80) as orig, edited_by FROM extracted_memories WHERE content_original IS NOT NULL AND content_en IS NOT NULL AND length(content_en) > 0 AND (length(content_en) < length(content_original) * 0.3 OR length(content_en) > length(content_original) * 3) LIMIT 15",
      ).all() as Array<{ id: number; en: string; orig: string; edited_by: string | null }>;
      const filteredTrans = translation.filter(r => !skip(r.edited_by));
      if (filteredTrans.length > 0) lists.translationIssues = filteredTrans.slice(0, 10).map(r => `#${r.id}: EN="${r.en}" ORIG="${r.orig}"`).join("\n");

      const gaps = this.db.prepare(
        "SELECT id, substr(content_en,1,100) as preview, emotion_tags, edited_by FROM extracted_memories WHERE emotion_tags IS NOT NULL AND emotion_tags != '' AND emotion_context IS NULL LIMIT 20",
      ).all() as Array<{ id: number; preview: string; emotion_tags: string; edited_by: string | null }>;
      const filteredGaps = gaps.filter(r => !skip(r.edited_by));
      if (filteredGaps.length > 0) lists.emotionContextGaps = filteredGaps.slice(0, 15).map(r => `#${r.id} [${r.emotion_tags}]: ${r.preview}`).join("\n");

      const today = new Date(); today.setHours(0, 0, 0, 0);
      const recalls = this.db.prepare(
        "SELECT id, substr(content_en,1,80) as preview, recall_count, last_recalled_at FROM extracted_memories WHERE last_recalled_at > ? ORDER BY last_recalled_at DESC LIMIT 15",
      ).all(today.getTime()) as Array<{ id: number; preview: string; recall_count: number; last_recalled_at: number }>;
      if (recalls.length > 0) lists.recallFeedback = recalls.map(r => `#${r.id} (recalled ${r.recall_count}x): ${r.preview}`).join("\n");
    } catch (err) { logWarn(TAG, `buildSleepCandidates failed: ${err instanceof Error ? err.message : String(err)}`); }
    return lists;
  }

  markCurationAttempt(ids: number[], model: string): void {
    const stmt = this.db.prepare("SELECT id, edited_by FROM extracted_memories WHERE id = ?");
    const update = this.db.prepare("UPDATE extracted_memories SET edited_by = ?, edited_at = ? WHERE id = ?");
    const now = Date.now();
    for (const id of ids) {
      const row = stmt.get(id) as { id: number; edited_by: string | null } | undefined;
      if (!row) continue;
      let count = 1;
      if (row.edited_by?.includes(":attempt:")) {
        count = (parseInt(row.edited_by.split(":attempt:")[1]!) || 0) + 1;
      }
      update.run(`${model}:attempt:${count}`, now, id);
    }
  }

  markCurationSuccess(ids: number[], model: string): void {
    const update = this.db.prepare("UPDATE extracted_memories SET edited_by = ?, edited_at = ? WHERE id = ?");
    const now = Date.now();
    for (const id of ids) update.run(model, now, id);
  }
}
