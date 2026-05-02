import type { MemoryManager } from "./memory-manager.js";
import { localTime, localDateTime } from "./local-time.js";

export const RECENT_MSG_LIMIT = 8;
export const RECENT_MSG_CAP = 2500;

type MsgRow = { role: string; content: string; timestamp: number };

/**
 * Format recent messages for injection. Keeps newest messages intact —
 * drops oldest messages first if over the soft cap (never truncates mid-message).
 */
function formatRecentMessages(rows: MsgRow[]): string {
  // rows come DESC from DB — reverse to chronological, skip empty
  const chronological = [...rows].reverse().filter(r => r.content.trim());
  const lines = chronological.map(r => {
    const time = localTime(new Date(r.timestamp));
    return `[${time}] ${r.role}: ${r.content}`;
  });

  // Drop oldest lines until under cap
  while (lines.length > 1) {
    const total = lines.join("\n").length;
    if (total <= RECENT_MSG_CAP) break;
    lines.shift();
  }

  return lines.join("\n");
}

/**
 * Build session-start context for injection after /new, /reset, or restart.
 * Returns the latest daily summary, or recent messages if no daily covers the gap.
 * Wrapped in REQ-4 temporal markers.
 */
export function buildSessionStartContext(memory: MemoryManager, userId: string): string | null {
  const daily = memory.getLatestCompaction(userId);
  const dailyTs = daily?.timestamp ?? 0;

  const lastMsgTs = memory.store.getLastMessageTimestamp();

  const now = localDateTime(new Date());
  let body: string;
  let endedAt: string;

  if (lastMsgTs > dailyTs && dailyTs > 0) {
    const rows = memory.store.getMessagesSince(dailyTs, RECENT_MSG_LIMIT);
    body = formatRecentMessages(rows);
    endedAt = localDateTime(new Date(lastMsgTs));
  } else if (daily) {
    body = daily.summary;
    endedAt = localDateTime(new Date(dailyTs));
  } else if (lastMsgTs > 0) {
    const rows = memory.store.getMessagesSince(0, RECENT_MSG_LIMIT);
    body = formatRecentMessages(rows);
    endedAt = localDateTime(new Date(lastMsgTs));
  } else {
    return null;
  }

  if (!body) return null;

  // Emotional tone of last session
  let emotionalTone = "";
  try {
    const db = memory.getDatabase();
    if (db) {
      const rows = db.prepare(
        `SELECT emotion_tags, emotion_context FROM extracted_memories
         WHERE user_id = ? AND emotion_tags IS NOT NULL AND emotion_tags != ''
         ORDER BY created_at DESC LIMIT 5`,
      ).all(userId) as Array<{ emotion_tags: string; emotion_context: string | null }>;
      if (rows.length > 0) {
        const tagCounts = new Map<string, number>();
        for (const r of rows) {
          for (const t of r.emotion_tags.split(",")) {
            const tag = t.trim();
            if (tag) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
          }
        }
        const top = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
        const contexts = rows.map(r => r.emotion_context).filter(Boolean).slice(0, 2);
        if (top.length > 0) {
          emotionalTone = `\n[Last session tone: ${top.join(", ")}${contexts.length > 0 ? ` (${contexts.join("; ")})` : ""}]`;
        }
      }
    }
  } catch { /* */ }

  return `[LAST SESSION SUMMARY — ended ${endedAt}]\n${body}${emotionalTone}\n[SESSION START — ${now}]`;
}
