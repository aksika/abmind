#!/usr/bin/env node
/**
 * abmind hook PostCompact — inject fresh recall after context compaction.
 * Re-grounds the agent with relevant memories after context was trimmed.
 * NOTE: Claude Code does not officially support this event yet.
 * When it does, this hook activates automatically.
 */

import { runCliRaw } from "../src/cli-runner-raw.js";
import { requirePrimaryUserId } from "../src/user-utils.js";
import { getMemoryClient, closeClient, isClient } from "../src/backend-factory.js";
import { MemoryManager, getMemoryDb } from "../src/memory-manager.js";
import { SleepDataAccess } from "../src/sleep-data-access.js";
import { hooksDisabled, logHookError, readStdinJson, ensureHooksDir } from "../src/hook-helpers.js";
import { extractEnglishTokens } from "../src/query-tokenizer.js";

interface PostCompactPayload {
  hook_event_name?: string;
  summary?: string;
}

await runCliRaw(import.meta.url, {
  name: "abmind-hook-postcompact",
  help: "PostCompact hook — inject fresh recall after context compaction.",
  flags: [],
  handler: async () => {
    ensureHooksDir();
    if (hooksDisabled()) { process.exit(0); }

    try {
      const payload = await readStdinJson<PostCompactPayload>();
      const summary = payload?.summary?.trim();
      if (!summary) { process.exit(0); }

      const client = await getMemoryClient(false);
      try {
        const tokens = extractEnglishTokens(summary);
        if (tokens.length === 0) { process.exit(0); }

        if (isClient(client)) {
          const result = await client.privateMemory.recall({
            translated: tokens, userId: requirePrimaryUserId(), limit: 5, maxClassification: 2,
          });
          if (result.results.length > 0) {
            const output = result.results.map(h => `- ${h.content}`).join("\n");
            process.stdout.write(output.slice(0, 2000));
          }
        } else {
          const memory = client as MemoryManager;
          const db = getMemoryDb(memory);
          if (!db) { process.exit(0); }
          const sleepData = new SleepDataAccess(db);
          let userId: string;
          try { userId = sleepData.getPrimaryUserId(); } catch { process.exit(0); }

          const results = await memory.search(tokens.join(" "), { userId, limit: 5 });
          if (results.length > 0) {
            const output = results.map((r: any) => `- ${r.content_en}`).join("\n");
            process.stdout.write(output.slice(0, 2000));
          }
        }
      } finally { closeClient(client); }
    } catch (err) { logHookError("postcompact", err); }
    process.exit(0);
  },
});
