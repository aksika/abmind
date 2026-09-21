/**
 * Session memory — builds memory context block for post-compaction injection.
 * Reads recent extracted memories, daily summary, and active todos.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localDate } from "./mem-env.js";
import { parseDailyHeading, parseDailyWrittenAt, parseLegacyDailyWriteTs, utcDayLabel } from "./sleep/sleep-daily-summary.js";
import type { MemoryManager } from "./memory-manager.js";

/** Build memory context block from memory manager + filesystem. */
export function buildMemoryContext(memory: MemoryManager | null, memoryDir: string, userId: string): string {
  const parts: string[] = ["[MEMORY CONTEXT]"];

  if (memory) {
    const memories = memory.store.getRecentExtractedMemories(userId, 5);
    if (memories.length > 0) {
      parts.push("\n## Key Memories");
      for (const m of memories) parts.push(`- ${m}`);
    }
  }

  // Today's daily summary. Writers no longer name files by covered day
  // (#1821): resolve through the parsed heading period, keeping the legacy
  // exact-name lookup. Heading periods are UTC days, so match the UTC day for
  // stamped files; legacy names used local days, so that lookup stays local.
  // Among overlapping files (kept only in anomaly cases), the newest write
  // wins.
  const dailyDir = join(memoryDir, "daily");
  const today = localDate();
  let dailyPath: string | null = null;
  const legacyPath = join(dailyDir, `daily_${today}.md`);
  if (existsSync(legacyPath)) dailyPath = legacyPath;
  if (dailyPath === null) {
    const utcToday = utcDayLabel(Date.now());
    try {
      let bestStamp = -1;
      let bestName = "";
      for (const f of readdirSync(dailyDir)) {
        if (!f.startsWith("daily_") || !f.endsWith(".md")) continue;
        const raw = readFileSync(join(dailyDir, f), "utf-8");
        const newline = raw.indexOf("\n");
        const period = parseDailyHeading(newline === -1 ? raw : raw.slice(0, newline));
        if (!period || utcToday < period.startDay || utcToday > period.endDay) continue;
        // Newest write wins; legacy names carry no stamp, so filename order
        // breaks that tie deterministically.
        const stamp = parseDailyWrittenAt(f) ?? parseLegacyDailyWriteTs(f) ?? -1;
        if (stamp > bestStamp || (stamp === bestStamp && f > bestName)) {
          bestStamp = stamp;
          bestName = f;
          dailyPath = join(dailyDir, f);
        }
      }
    } catch { /* missing daily dir → no summary, as before */ }
  }
  if (dailyPath) {
    try {
      const content = readFileSync(dailyPath, "utf-8").trim();
      if (content) parts.push(`\n## Today's Summary\n${content}`);
    } catch { /* */ }
  }

  // Active todos
  const todoPath = join(memoryDir, "..", "todo.md");
  if (existsSync(todoPath)) {
    try {
      const lines = readFileSync(todoPath, "utf-8").split("\n").filter(l => l.startsWith("- [ ]")).slice(0, 10);
      if (lines.length > 0) {
        parts.push("\n## Active Tasks");
        parts.push(...lines);
      }
    } catch { /* */ }
  }

  return parts.length > 1 ? parts.join("\n") : "";
}
