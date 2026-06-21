import type { MemoryManager } from "./memory-manager.js";
import { localTime, localDateTime } from "./local-time.js";
import { getAbmindEnv } from "./env-schema.js";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

export const SESSION_HISTORY_MIN_PAIRS = 8;

type MsgRow = { role: string; content: string; timestamp: number };
type Pair = { user: MsgRow; assistant?: MsgRow };

/**
 * Build session-start context for injection after /new, /reset, or restart.
 * Budget-based interleaved fill: dailies + recent message pairs (#615, #867).
 */
export function buildSessionStartContext(memory: MemoryManager, userId: string, maxContext?: number, opts?: { skipDailies?: boolean; skipMessages?: boolean; maxAgeMs?: number }): { text: string | null; stats: { messages: number; dailies: number; usedBytes: number; budget: number } } {
  const env = getAbmindEnv();
  const ctxWindow = maxContext ?? 128000;
  const pct = parseFloat(process.env["SESSION_HISTORY_PCT"] ?? "5");
  const minPairs = parseInt(process.env["SESSION_HISTORY_MIN_PAIRS"] ?? "8", 10);
  const cap = parseInt(process.env["SESSION_HISTORY_CAP"] ?? "50000", 10);
  const budget = Math.min(Math.floor(ctxWindow * pct / 100), cap);

  // --- Load sources ---
  let pairs = opts?.skipMessages ? [] : loadRecentPairs(memory, minPairs + 50);

  // Age filter
  if (opts?.maxAgeMs) {
    const cutoff = Date.now() - opts.maxAgeMs;
    pairs = pairs.filter(p => p.user.timestamp >= cutoff);
  }

  const memDir = memory.getConfig().memoryDir;
  const dailies = opts?.skipDailies ? [] : loadDailySummaries(memDir, 14);
  const weeklies = opts?.skipDailies ? [] : loadConsolidationFiles(join(memDir, "weekly"));
  const quarterlies = opts?.skipDailies ? [] : loadConsolidationFiles(join(memDir, "quarterly"));

  // --- Floor: minPairs newest pairs + 1 daily (mandatory) ---
  const pairBucket: string[] = [];
  const consolidationBucket: string[] = [];

  const floorStart = Math.max(0, pairs.length - minPairs);
  for (let i = floorStart; i < pairs.length; i++) {
    pairBucket.push(formatPair(pairs[i]!));
  }

  if (dailies.length > 0) {
    consolidationBucket.push(dailies[0]!.content);
  }

  let used = pairBucket.join("\n").length + consolidationBucket.join("\n").length;

  // --- Enrichment (#1107): 1 pair + 1 consolidation per round ---
  // Pattern: daily, daily, weekly, daily, daily, weekly...
  // Every 6th weekly slot → quarterly instead.
  // Fallback cascade: daily→weekly→quarterly when source exhausts.
  let pairCursor = floorStart - 1;
  let dailyCursor = 1;
  let weeklyCursor = 0;
  let quarterlyCursor = 0;
  let round = 0;
  let weeklySlotCount = 0;

  while (used < budget) {
    // 1 pair
    if (pairCursor < 0) break;
    const line = formatPair(pairs[pairCursor]!);
    if (used + line.length > budget) break;
    pairBucket.unshift(line);
    used += line.length;
    pairCursor--;

    // 1 consolidation: 2 daily rounds then 1 weekly round
    const isWeeklySlot = round % 3 === 2;
    const entry = pickConsolidation(isWeeklySlot);
    if (entry === null) break; // all sources exhausted
    if (used + entry.length > budget) break;
    consolidationBucket.push(entry);
    used += entry.length;

    round++;
  }

  /** Pick a consolidation entry with fallback cascade. Returns null if all exhausted. */
  function pickConsolidation(weeklySlot: boolean): string | null {
    if (weeklySlot) {
      weeklySlotCount++;
      // Every 6th weekly slot → quarterly
      if (weeklySlotCount % 6 === 0 && quarterlyCursor < quarterlies.length) {
        return quarterlies[quarterlyCursor++]!.content;
      }
      if (weeklyCursor < weeklies.length) return weeklies[weeklyCursor++]!.content;
      // Weekly exhausted → fall through to daily
    }
    // Daily slot (or weekly-slot fallback)
    if (dailyCursor < dailies.length) return dailies[dailyCursor++]!.content;
    // Daily exhausted → try weekly
    if (weeklyCursor < weeklies.length) return weeklies[weeklyCursor++]!.content;
    // Weekly exhausted → try quarterly
    if (quarterlyCursor < quarterlies.length) return quarterlies[quarterlyCursor++]!.content;
    return null;
  }

  // --- Assemble ---
  if (pairBucket.length === 0 && consolidationBucket.length === 0) return { text: null, stats: { messages: 0, dailies: 0, usedBytes: 0, budget } };

  const now = localDateTime(new Date());
  const lastTs = pairs.length > 0 ? (pairs[pairs.length - 1]!.assistant?.timestamp ?? pairs[pairs.length - 1]!.user.timestamp) : Date.now();
  const endedAt = localDateTime(new Date(lastTs));

  const parts: string[] = [];

  if (consolidationBucket.length > 0) {
    parts.push("[PAST DAYS]\n" + consolidationBucket.join("\n\n"));
  }

  if (pairBucket.length > 0) {
    parts.push(`[RECENT — last session, ended ${endedAt}]\n` + pairBucket.join("\n"));
  }

  const tone = getEmotionalTone(memory, userId);
  if (tone) parts.push(tone);

  parts.push(`[SESSION START — ${now}]`);

  const result = parts.join("\n\n");
  return { text: result, stats: { messages: pairBucket.length, dailies: consolidationBucket.length, usedBytes: used, budget } };
}

function truncateAssistant(content: string): string {
  if (content.length <= 250) return content;
  return content.slice(0, 200) + " ~[cut]~ " + content.slice(-50);
}

function formatPair(pair: Pair): string {
  const time = localTime(new Date(pair.user.timestamp));
  const userLine = `[${time} user] ${pair.user.content}`;
  if (!pair.assistant) return userLine;
  const aTime = localTime(new Date(pair.assistant.timestamp));
  const aContent = truncateAssistant(pair.assistant.content);
  return `${userLine}\n[${aTime} assistant] ${aContent}`;
}

function loadRecentPairs(memory: MemoryManager, limit: number): Pair[] {
  if (!memory.store) return [];
  try {
    const rows = memory.store.getMessagesSince(0, limit * 2) as MsgRow[];
    // getMessagesSince returns newest-first (DESC). Reverse for chronological (oldest-first).
    const chronological = [...rows].reverse().filter(r => r.content.trim());
    // Walk oldest→newest: user followed by assistant = pair
    const pairs: Pair[] = [];
    for (let i = 0; i < chronological.length; i++) {
      const row = chronological[i]!;
      if (row.role === "user") {
        const next = chronological[i + 1];
        if (next && next.role === "assistant") {
          pairs.push({ user: row, assistant: next });
          i++;
        } else {
          pairs.push({ user: row });
        }
      }
      // Skip orphan assistant messages
    }
    return pairs; // oldest-first
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

function loadConsolidationFiles(dir: string): Array<{ content: string }> {
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".md")).sort().reverse(); // newest first
    const results: Array<{ content: string }> = [];
    for (const file of files) {
      const content = readFileSync(join(dir, file), "utf-8").trim();
      if (content) results.push({ content });
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
