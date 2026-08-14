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
      // #1658: strict-owner candidates — missing identity is a configuration
      // error, not empty JSON.
      const primaryUserId = requirePrimaryUserId();
      const sleepData = new SleepDataAccess(db);
      const candidates = sleepData.buildSleepCandidates("unknown", primaryUserId);
      console.log(JSON.stringify(candidates, null, 2));
    } finally {
      db.close();
    }
  },
});
