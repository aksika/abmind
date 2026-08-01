#!/usr/bin/env node
/**
 * abmind hook SubagentStart — log delegation as session breadcrumb.
 */

import { runCliRaw } from "../src/cli-runner-raw.js";
import { getMemoryClient, closeClient } from "../src/backend-factory.js";
import { MemoryManager, getMemoryDb } from "../src/memory-manager.js";
import { SleepDataAccess } from "../src/sleep-data-access.js";
import { hooksDisabled, logHookError, readStdinJson, ensureHooksDir } from "../src/hook-helpers.js";

interface SubagentStartPayload {
  hook_event_name?: string;
  task?: string;
}

await runCliRaw(import.meta.url, {
  name: "abmind-hook-subagentstart",
  help: "SubagentStart hook — log delegation event as session breadcrumb.",
  flags: [],
  handler: async () => {
    ensureHooksDir();
    if (hooksDisabled()) { process.exit(0); }

    try {
      const payload = await readStdinJson<SubagentStartPayload>();
      const task = payload?.task?.trim();
      if (!task) { process.exit(0); }

      const client = await getMemoryClient(false);
      const memory = client as MemoryManager;
      try {
        const db = getMemoryDb(memory);
        if (!db) { process.exit(0); }
        const sleepData = new SleepDataAccess(db);
        let userId: string;
        try { userId = sleepData.getPrimaryUserId(); } catch { process.exit(0); }

        memory.recordMessage({
          userId, sessionId: "_S_breadcrumb", role: "assistant",
          content: `[DELEGATION] Subagent spawned: ${task.slice(0, 200)}`,
          timestamp: Date.now(),
        });
      } finally { closeClient(client); }
    } catch (err) { logHookError("subagentstart", err); }
    process.exit(0);
  },
});
