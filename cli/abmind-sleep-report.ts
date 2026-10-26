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

Prints a markdown dream report: total current durables and the 20 most
recent ones with revision. Relevance/recall counters retired with the
legacy extracted_memories table (#1939 stage 3).`,
  flags: [],
  handler: () => {
    const config = loadMemoryConfig();
    const db = initializeDatabase(join(config.memoryDir, "memory.db"));
    try {
      const today = localDate();
      const recentMemories = db.prepare(
        "SELECT id, content, memory_type, revision, created_at FROM long_term_memories WHERE superseded_by_id IS NULL ORDER BY created_at DESC LIMIT 20",
      ).all() as Array<{ id: number; content: string; memory_type: string; revision: number; created_at: number }>;

      const stats = db.prepare(
        "SELECT COUNT(*) as total FROM long_term_memories WHERE superseded_by_id IS NULL",
      ).get() as { total: number };

      console.log(`# Dream Report — ${today}\n`);
      console.log(`## Stats`);
      console.log(`- Total durables: ${stats.total}\n`);
      console.log(`## Recent Memories`);
      for (const m of recentMemories) {
        console.log(`- [#${m.id}] (${m.memory_type}, rev=${m.revision}) ${m.content.slice(0, 100)}`);
      }
    } finally {
      db.close();
    }
  },
});
