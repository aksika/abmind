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
import { hookSidecarKey } from "../src/mem-paths.js";
import { OWNED_RECALL_CONTRACT } from "../src/owned-recall-contract.js";
import { hooksDisabled, logHookError, readStdinJson, ensureHooksDir } from "../src/hook-helpers.js";

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
        // #1928 M4 — the compaction summary is an explicit anchor for a
        // normal recall; the owner packet text travels intact.
        const sessionKey = hookSidecarKey();
        const principal = requirePrimaryUserId();
        const request = {
          contract: OWNED_RECALL_CONTRACT,
          profile: "recall_normal",
          identity: { principal, conversation: sessionKey, execution: sessionKey, host: "abmind-cli-hooks" },
          query: { text: summary },
          capacity: { maxItems: 5, maxOutputBytes: 2000 },
        } as const;
        const packet = isClient(client)
          ? await client.privateMemory.recall({ ...request })
          : await client.recall({ ...request });
        if (packet.text) process.stdout.write(packet.text.endsWith("\n") ? packet.text : packet.text + "\n");
      } finally { closeClient(client); }
    } catch (err) { logHookError("postcompact", err); }
    process.exit(0);
  },
});
