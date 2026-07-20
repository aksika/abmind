#!/usr/bin/env node
/**
 * abmind hook PreCompact — extract memories before context compaction.
 * Reads transcript from stdin, runs extraction so memories aren't lost.
 */

import { runCliRaw } from "../src/cli-runner-raw.js";
import { getMemoryClient, closeClient } from "../src/backend-factory.js";
import { MemoryManager } from "../src/memory-manager.js";
import { SleepDataAccess } from "../src/sleep-data-access.js";
import { hooksDisabled, logHookError, readStdinJson, ensureHooksDir } from "../src/hook-helpers.js";

interface PreCompactPayload {
  hook_event_name?: string;
  transcript?: string;
}

await runCliRaw(import.meta.url, {
  name: "abmind-hook-precompact",
  help: "PreCompact hook — extract memories from transcript before context is lost.",
  flags: [],
  handler: async () => {
    ensureHooksDir();
    if (hooksDisabled()) { process.exit(0); }

    try {
      const payload = await readStdinJson<PreCompactPayload>();
      const transcript = payload?.transcript?.trim();
      if (!transcript || transcript.length < 100) { process.exit(0); }

      const client = await getMemoryClient(false);
      const memory = client as MemoryManager;
      try {
        const db = memory.getDatabase();
        if (!db) { process.exit(0); }
        const sleepData = new SleepDataAccess(db);
        let userId: string;
        try { userId = sleepData.getPrimaryUserId(); } catch { process.exit(0); }

        // Record transcript messages so Dreamy can extract them later
        const lines = transcript.split("\n").filter(l => l.trim());
        const now = Date.now();
        for (let i = 0; i < Math.min(lines.length, 50); i++) {
          const line = lines[i]!;
          const role = line.startsWith("Human:") || line.startsWith("User:") ? "user" : "assistant";
          const content = line.replace(/^(Human|User|Assistant|Claude):\s*/i, "").trim();
          if (content.length > 10) {
            memory.recordMessage({ userId, sessionId: "_A_compact", role, content, timestamp: now - (lines.length - i) * 1000 });
          }
        }
      } finally { closeClient(client); }
    } catch (err) { logHookError("precompact", err); }
    process.exit(0);
  },
});
