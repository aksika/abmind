#!/usr/bin/env node
/** abmind wake-up — Print current wake-up context. */
import { runCliRaw } from "../src/cli-runner-raw.js";
import type { FlagSpec } from "../src/cli-flags.js";
import { getMemoryClient, closeClient } from "../src/backend-factory.js";
import { MemoryManager } from "../src/memory-manager.js";
import { requirePrimaryUserId } from "../src/user-utils.js";

const FLAGS: readonly FlagSpec[] = [
  { name: "max-chars", type: "number" },
];

await runCliRaw(import.meta.url, {
  name: "abmind-wakeup",
  help: `Usage:
  abmind wake-up [--max-chars N]

Prints the current wake-up context (core memories, timelines, emotional
highlights) for the master user, capped at max-chars (default 5000).`,
  flags: FLAGS,
  handler: async ({ args }) => {
    const maxChars = args["max-chars"] !== undefined ? Number(args["max-chars"]) : 5000;

    const client = await getMemoryClient(false);
    const memory = client as MemoryManager;
    try {
      const primaryUserId = requirePrimaryUserId();
      const wakeUp = memory.buildWakeUp(primaryUserId, maxChars);
      if (wakeUp) {
        console.log(wakeUp);
        console.log(`\n--- ${wakeUp.length} chars, maxChars=${maxChars} ---`);
      } else {
        console.log("No wake-up context available.");
      }
    } finally {
      closeClient(client);
    }
  },
});
