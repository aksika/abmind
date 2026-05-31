#!/usr/bin/env node
/**
 * abmind hook SubagentStop — capture subagent output as memory.
 */

import { runCliRaw } from "../src/cli-runner-raw.js";
import { loadMemoryConfig } from "../src/memory-config.js";
import { MemoryManager } from "../src/memory-manager.js";
import { SleepDataAccess } from "../src/sleep-data-access.js";
import { hooksDisabled, logHookError, readStdinJson, ensureHooksDir } from "../src/hook-helpers.js";

interface SubagentStopPayload {
  hook_event_name?: string;
  output?: string;
  parent_user_id?: string;
}

await runCliRaw(import.meta.url, {
  name: "abmind-hook-subagentstop",
  help: "SubagentStop hook — capture subagent output as memory.",
  flags: [],
  handler: async () => {
    ensureHooksDir();
    if (hooksDisabled()) { process.exit(0); }

    try {
      const payload = await readStdinJson<SubagentStopPayload>();
      const output = payload?.output?.trim();
      if (!output || output.length < 20) { process.exit(0); }

      const memory = new MemoryManager(loadMemoryConfig());
      await memory.initialize({ skipEmbeddingCheck: true });
      try {
        const db = memory.getDatabase();
        if (!db) { process.exit(0); }
        const sleepData = new SleepDataAccess(db);
        const userId = payload?.parent_user_id ?? (() => { try { return sleepData.getPrimaryUserId(); } catch { return null; } })();
        if (!userId) { process.exit(0); }

        await memory.editor.instantStore({
          userId, contentEn: `Subagent completed: ${output.slice(0, 500)}`,
          contentOriginal: output.slice(0, 500),
          memoryType: "fact", emotionScore: 0,
        });
      } finally { memory.close(); }
    } catch (err) { logHookError("subagentstop", err); }
    process.exit(0);
  },
});
