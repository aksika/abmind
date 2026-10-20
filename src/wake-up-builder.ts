/**
 * wake-up-builder.ts — Build session-start memory context.
 * Lean injection: current time + flashback (random emotional memory).
 * Everything else surfaces through active recall (#203) on demand.
 */

import type Database from "better-sqlite3";
import { renderMemory } from "./memory-renderer.js";
import { localDateTime } from "./local-time.js";
import { isPersonalReady } from "./personal-schema.js";
import { isSuppressedByForget } from "./personal-forget.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Build wake-up context: current time + one flashback.
 * Enforces an optional character budget — prefers complete sections,
 * drops the flashback if needed, then truncates the time line as a last resort.
 * Returns empty string if DB unavailable or no emotional memories exist.
 *
 * `opts.suppressFlashback` (#1869) drops the flashback unconditionally and
 * keeps the computed time line: the flashback is a real memory, the time is
 * not recalled. Model-bound assemblers pass it under `MEMORY_TEST=ON`;
 * the default path is unchanged.
 */
export function buildWakeUp(db: Database.Database | null, userId: string, maxChars?: number, opts?: { suppressFlashback?: boolean }): string {
  if (!db) return "";

  // Invalid budget — zero, negative, or non-finite — returns empty
  if (maxChars !== undefined && (maxChars <= 0 || !Number.isFinite(maxChars))) {
    return "";
  }

  // 1. Current time
  const now = new Date();
  const timeSection = `[Current time: ${localDateTime(now)} (${DAYS[now.getDay()]})]`;

  // 2. Flashback — a durable memory, if the dataset serves one.
  // #1869: suppressed unconditionally under MEMORY_TEST=ON (a real memory);
  // the computed time line above always stays.
  let flashbackSection: string | undefined;
  if (!opts?.suppressFlashback) {
  try {
    // #1939 2b: the flashback serves durable knowledge only. Unconverted
    // datasets carry no servable flashback (hydration refuses them before
    // this renderer runs); the legacy emotional-memory query is deleted.
    if (isPersonalReady(db)) {
      const candidates = db.prepare(
        `SELECT id, content, memory_type FROM long_term_memories
         WHERE user_id = ? AND classification < 3 AND superseded_by_id IS NULL
           AND (valid_to IS NULL OR valid_to > date('now','localtime'))
         ORDER BY RANDOM() LIMIT 3`,
      ).all(userId) as Array<{ id: number; content: string; memory_type: string | null }>;
      const hit = candidates.find((c) => !isSuppressedByForget(db, userId, { durableId: c.id }));
      if (hit) {
        flashbackSection = `[Flashback] ${renderMemory({
          content_en: hit.content,
          memory_type: hit.memory_type ?? undefined,
          createdAt: Date.now(),
        })}`;
      }
    }
  } catch { /* no durable memories or DB error */ }
  }

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
