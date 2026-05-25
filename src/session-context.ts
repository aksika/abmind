import type { MemoryManager } from "./memory-manager.js";
import { localTime, localDateTime } from "./local-time.js";
import { getAbmindEnv } from "./env-schema.js";
import { getLatestConsolidationFile } from "./consolidation-search.js";
import { renderMemory } from "./memory-renderer.js";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

export const SESSION_HISTORY_MIN_MSGS = 8;

type MsgRow = { role: string; content: string; timestamp: number };

/**
 * Build session-start context for injection after /new, /reset, or restart.
 * Budget-based interleaved fill: dailies + recent messages (#615).
 */
export function buildSessionStartContext(memory: MemoryManager, userId: string, maxContext?: number): string | null {
  const env = getAbmindEnv();
  const ctxWindow = maxContext ?? 128000;
  const pct = parseFloat(process.env["SESSION_HISTORY_PCT"] ?? "5");
  const minMsgs = parseInt(process.env["SESSION_HISTORY_MIN_MSGS"] ?? "8", 10);
  const budget = Math.floor(ctxWindow * pct / 100);

  // --- Load sources ---
  const recentRows = loadRecentUserMessages(memory, minMsgs + 50); // fetch extra for enrichment
  const dailies = loadDailySummaries(memory.getConfig().memoryDir, 14);

  // --- Floor: 1 daily + min messages (always included) ---
  const recentBucket: string[] = [];
  const dailyBucket: string[] = [];

  // Floor messages
  for (let i = 0; i < Math.min(minMsgs, recentRows.length); i++) {
    recentBucket.push(formatMessage(recentRows[i]!));
  }

  // Floor daily
  if (dailies.length > 0) {
    dailyBucket.push(dailies[0]!.content);
  }

  let used = recentBucket.join("\n").length + dailyBucket.join("\n").length;

  // --- Enrichment cycle: interleaved fill, budget-checked per add ---
  let msgCursor = minMsgs;
  let dailyCursor = 1;

  while (used < budget) {
    let added = false;

    if (msgCursor < recentRows.length) {
      const line = formatMessage(recentRows[msgCursor]!);
      if (used + line.length <= budget) {
        recentBucket.push(line);
        used += line.length;
        msgCursor++;
        added = true;
      }
    }

    if (dailyCursor < dailies.length) {
      const entry = dailies[dailyCursor]!.content;
      if (used + entry.length <= budget) {
        dailyBucket.push(entry);
        used += entry.length;
        dailyCursor++;
        added = true;
      }
    }

    if (!added) break;
  }

  // --- Assemble: clean separation, temporal order ---
  if (recentBucket.length === 0 && dailyBucket.length === 0) return null;

  const now = localDateTime(new Date());
  const lastMsgTs = recentRows.length > 0 ? recentRows[0]!.timestamp : Date.now();
  const endedAt = localDateTime(new Date(lastMsgTs));

  const parts: string[] = [];

  if (dailyBucket.length > 0) {
    parts.push("[PAST DAYS]\n" + dailyBucket.join("\n\n"));
  }

  if (recentBucket.length > 0) {
    parts.push(`[RECENT — last session, ended ${endedAt}]\n` + recentBucket.join("\n"));
  }

  // Emotional tone
  const tone = getEmotionalTone(memory, userId);
  if (tone) parts.push(tone);

  parts.push(`[SESSION START — ${now}]`);

  return parts.join("\n\n");
}

function formatMessage(row: MsgRow): string {
  const time = localTime(new Date(row.timestamp));
  return `[${time}] ${row.content}`;
}

function loadRecentUserMessages(memory: MemoryManager, limit: number): MsgRow[] {
  if (!memory.store) return [];
  try {
    const rows = memory.store.getMessagesSince(0, limit) as MsgRow[];
    // getMessagesSince returns oldest first — reverse for newest first, filter to user only
    return [...rows].reverse().filter(r => r.role === "user" && r.content.trim());
  } catch { return []; }
}

function loadDailySummaries(memoryDir: string, days: number): Array<{ timestamp: number; content: string }> {
  const dir = join(memoryDir, "daily");
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".md")).sort().reverse(); // newest first
    const cutoff = Date.now() - days * 86_400_000;
    const results: Array<{ timestamp: number; content: string }> = [];
    for (const file of files) {
      const m = file.match(/daily_(\d{4})-(\d{2})-(\d{2})\.md/);
      if (!m) continue;
      const ts = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getTime();
      if (ts < cutoff) break;
      const content = readFileSync(join(dir, file), "utf-8").trim();
      if (content) results.push({ timestamp: ts, content });
    }
    return results;
  } catch { return []; }
}

function getEmotionalTone(memory: MemoryManager, userId: string): string | null {
  try {
    const db = memory.getDatabase();
    if (!db) return null;
    const rows = db.prepare(
      `SELECT emotion_tags, emotion_context FROM extracted_memories
       WHERE user_id = ? AND emotion_tags IS NOT NULL AND emotion_tags != ''
       ORDER BY created_at DESC LIMIT 5`,
    ).all(userId) as Array<{ emotion_tags: string; emotion_context: string | null }>;
    if (rows.length === 0) return null;
    const tagCounts = new Map<string, number>();
    for (const r of rows) {
      for (const t of r.emotion_tags.split(",")) {
        const tag = t.trim();
        if (tag) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
    const top = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
    const contexts = rows.map(r => r.emotion_context).filter(Boolean).slice(0, 2);
    if (top.length === 0) return null;
    return `[Last session tone: ${top.join(", ")}${contexts.length > 0 ? ` (${contexts.join("; ")})` : ""}]`;
  } catch { return null; }
}
