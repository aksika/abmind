/**
 * Session memory — builds memory context block for post-compaction injection.
 * Reads recent extracted memories, daily summary, and active todos.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localDate } from "./mem-env.js";
import type { MemoryManager } from "./memory-manager.js";

/** Build memory context block from memory manager + filesystem. */
export function buildMemoryContext(memory: MemoryManager | null, memoryDir: string): string {
  const parts: string[] = ["[MEMORY CONTEXT]"];

  if (memory) {
    const memories = memory.store.getRecentExtractedMemories(5);
    if (memories.length > 0) {
      parts.push("\n## Key Memories");
      for (const m of memories) parts.push(`- ${m}`);
    }
  }

  // Today's daily summary
  const dailyDir = join(memoryDir, "daily");
  const today = localDate();
  const dailyPath = join(dailyDir, `daily_${today}.md`);
  if (existsSync(dailyPath)) {
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
