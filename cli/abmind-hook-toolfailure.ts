#!/usr/bin/env node
/**
 * abmind hook PostToolUseFailure — store novel failure patterns as lessons.
 * Dedup: only stores if same tool+error not seen in last 24h.
 */

import { runCliRaw } from "../src/cli-runner-raw.js";
import { getMemoryClient, closeClient, isClient } from "../src/backend-factory.js";
import { MemoryManager } from "../src/memory-manager.js";
import { SleepDataAccess } from "../src/sleep-data-access.js";
import { hooksDisabled, logHookError, readStdinJson, ensureHooksDir } from "../src/hook-helpers.js";

interface ToolFailurePayload {
  hook_event_name?: string;
  tool_name?: string;
  error?: string;
}

await runCliRaw(import.meta.url, {
  name: "abmind-hook-toolfailure",
  help: "PostToolUseFailure hook — store novel failure patterns as lessons.",
  flags: [],
  handler: async () => {
    ensureHooksDir();
    if (hooksDisabled()) { process.exit(0); }

    try {
      const payload = await readStdinJson<ToolFailurePayload>();
      const toolName = payload?.tool_name ?? "unknown";
      const error = payload?.error?.trim() ?? "";
      if (!error) { process.exit(0); }

      const client = await getMemoryClient(false);
      try {
        if (isClient(client)) {
          await client.privateMemory.instantStore({
            userId: "hook-user",
            contentEn: `Tool ${toolName} failed: ${error.slice(0, 200)}`,
            contentOriginal: `${toolName}: ${error.slice(0, 200)}`,
            memoryType: "lesson",
            emotionScore: -1,
          });
        } else {
          const memory = client as MemoryManager;
          const db = memory.getDatabase();
          if (!db) { process.exit(0); }
          const sleepData = new SleepDataAccess(db);
          let userId: string;
          try { userId = sleepData.getPrimaryUserId(); } catch { process.exit(0); }

          const dedupKey = `${toolName}:${error.slice(0, 50)}`;
          const existing = db.prepare(
            "SELECT id FROM extracted_memories WHERE content_en LIKE ? AND created_at > ? LIMIT 1"
          ).get(`%${dedupKey}%`, Date.now() - 86_400_000);
          if (existing) { process.exit(0); }

          await memory.editor.instantStore({
            userId,
            contentEn: `Tool ${toolName} failed: ${error.slice(0, 200)}`,
            contentOriginal: `${toolName}: ${error.slice(0, 200)}`,
            memoryType: "lesson",
            emotionScore: -1,
          });
        }
      } finally { closeClient(client); }
    } catch (err) { logHookError("toolfailure", err); }
    process.exit(0);
  },
});
