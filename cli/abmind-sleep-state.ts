#!/usr/bin/env node
/**
 * abmind sleep-state — show sleep candidates (JSON).
 *
 * Read-only: opens its own DB handle so it's cheap to run against a live
 * bridge (WAL concurrent read). No MemoryBackend needed → runCliRaw.
 */
import { join } from "node:path";
import { runCliRaw } from "../src/cli-runner-raw.js";
import { loadMemoryConfig } from "../src/memory-config.js";
import { initializeDatabase } from "../src/memory-db.js";
import { SleepDataAccess } from "../src/sleep-data-access.js";
import { recallProjectionStatus } from "../src/recall-projection-build.js";
import { requirePrimaryUserId } from "../src/user-utils.js";

await runCliRaw(import.meta.url, {
  name: "abmind-sleep-state",
  help: `Usage:
  abmind sleep-state

Prints the sleep candidates + memory stats as JSON. Read-only.`,
  flags: [],
  handler: () => {
    const config = loadMemoryConfig();
    const db = initializeDatabase(join(config.memoryDir, "memory.db"));
    try {
      // #1658: strict-owner state — missing identity is a configuration
      // error, not empty JSON. #1937: reports eligible durables and the
      // recall projection status instead of legacy curation lists.
      const primaryUserId = requirePrimaryUserId();
      const sleepData = new SleepDataAccess(db);
      const state = {
        durableCount: sleepData.getDurableCount(primaryUserId),
        remSample: sleepData.getRemSample(primaryUserId, 5).map((r) => ({ id: r.id, memory_type: r.memory_type })),
        recallProjection: recallProjectionStatus(db),
      };
      console.log(JSON.stringify(state, null, 2));
    } finally {
      db.close();
    }
  },
});
