#!/usr/bin/env node
/**
 * abmind sleep-report — generate a dream report (markdown to stdout).
 * Read-only; raw DB access, no MemoryBackend needed.
 */
import { join } from "node:path";
import { runCliRaw } from "../src/cli-runner-raw.js";
import { loadMemoryConfig } from "../src/memory-config.js";
import { initializeDatabase } from "../src/memory-db.js";
import { localDate } from "../src/local-time.js";

await runCliRaw(import.meta.url, {
  name: "abmind-sleep-report",
  help: `Usage:
  abmind sleep-report

Prints a markdown dream report: total memories, positive-relevance count,
and the 20 most recent memories with relevance + recall counts.`,
  flags: [],
  handler: () => {
    const config = loadMemoryConfig();
    const db = initializeDatabase(join(config.memoryDir, "memory.db"));
    try {
      const today = localDate();
      const recentMemories = db.prepare(
        "SELECT id, content_en, memory_type, relevance_score, recall_count, created_at FROM extracted_memories ORDER BY created_at DESC LIMIT 20",
      ).all() as Array<{ id: number; content_en: string; memory_type: string; relevance_score: number; recall_count: number; created_at: string }>;

      const stats = db.prepare(
        "SELECT COUNT(*) as total, SUM(CASE WHEN relevance_score > 0 THEN 1 ELSE 0 END) as boosted FROM extracted_memories",
      ).get() as { total: number; boosted: number };

      console.log(`# Dream Report — ${today}\n`);
      console.log(`## Stats`);
      console.log(`- Total memories: ${stats.total}`);
      console.log(`- With positive relevance: ${stats.boosted}\n`);
      console.log(`## Recent Memories`);
      for (const m of recentMemories) {
        console.log(`- [#${m.id}] (${m.memory_type}, rel=${m.relevance_score} recall=${m.recall_count}) ${m.content_en.slice(0, 100)}`);
      }
    } finally {
      db.close();
    }
  },
});
