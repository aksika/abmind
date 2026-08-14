/**
 * wake-up-builder.ts — Build session-start memory context.
 * Lean injection: current time + flashback (random emotional memory).
 * Everything else surfaces through active recall (#203) on demand.
 */

import type Database from "better-sqlite3";
import { renderMemory } from "./memory-renderer.js";
import { localDateTime } from "./local-time.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Build wake-up context: current time + one flashback.
 * Enforces an optional character budget — prefers complete sections,
 * drops the flashback if needed, then truncates the time line as a last resort.
 * Returns empty string if DB unavailable or no emotional memories exist.
 */
export function buildWakeUp(db: Database.Database | null, userId: string, maxChars?: number): string {
  if (!db) return "";

  // Invalid budget — zero, negative, or non-finite — returns empty
  if (maxChars !== undefined && (maxChars <= 0 || !Number.isFinite(maxChars))) {
    return "";
  }

  // 1. Current time
  const now = new Date();
  const timeSection = `[Current time: ${localDateTime(now)} (${DAYS[now.getDay()]})]`;

  // 2. Flashback — random emotional memory weighted by intensity × recency
  let flashbackSection: string | undefined;
  try {
    const row = db.prepare(
      `SELECT content_en, emotion_tags, importance_flags, topic, memory_type, confidence, created_at
       FROM extracted_memories
       WHERE ABS(emotion_score) >= 3
         AND user_id = ?
         AND classification < 3
         AND valid_to IS NULL
         AND content_en IS NOT NULL
       ORDER BY RANDOM() * ABS(emotion_score) / sqrt(1.0 + (julianday('now') - julianday(created_at / 1000, 'unixepoch')) / 180.0) DESC
       LIMIT 1`,
    ).get(userId) as { content_en: string; emotion_tags: string | null; importance_flags: string | null; topic: string | null; memory_type: string | null; confidence: number | null; created_at: number } | undefined;

    if (row) {
      const rendered = renderMemory({
        content_en: row.content_en,
        topic: row.topic ?? undefined,
        emotion_tags: row.emotion_tags ?? undefined,
        importance_flags: row.importance_flags ?? undefined,
        memory_type: row.memory_type ?? undefined,
        confidence: row.confidence ?? undefined,
        createdAt: row.created_at,
      });
      flashbackSection = `[Flashback] ${rendered}`;
    }
  } catch { /* no emotional memories or DB error */ }

  // No budget → full output (preserve existing behavior)
  if (maxChars === undefined) {
    const parts: string[] = [timeSection];
    if (flashbackSection) parts.push(flashbackSection);
    return parts.join("\n\n");
  }

  // Assemble within budget, preferring complete sections.
  // Start with current time, add flashback only if it fits.
  const combined = flashbackSection
    ? `${timeSection}\n\n${flashbackSection}`
    : timeSection;

  if (combined.length <= maxChars) return combined;

  // Flashback doesn't fit — drop it
  if (timeSection.length <= maxChars) return timeSection;

  // Even the time section is too long — truncate it
  return timeSection.slice(0, maxChars);
}
