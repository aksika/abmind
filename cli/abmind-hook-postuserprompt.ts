#!/usr/bin/env node
/**
 * abmind hook PostUserPrompt — real-time extraction after high-signal exchanges.
 * Hybrid: heuristic gate + only extracts when triggered.
 */

import { runCliRaw } from "../src/cli-runner-raw.js";
import { loadMemoryConfig } from "../src/memory-config.js";
import { MemoryManager } from "../src/memory-manager.js";
import { SleepDataAccess } from "../src/sleep-data-access.js";
import { hooksDisabled, logHookError, readStdinJson, ensureHooksDir } from "../src/hook-helpers.js";

interface PostUserPromptPayload {
  hook_event_name?: string;
  user_message?: string;
  assistant_message?: string;
}

const SIGNAL_PATTERNS = [
  /\b(remember|don't forget|note that|my .+ is|I prefer|I decided|I always|I never)\b/i,
  /\b(password|secret|key|token|credential)\b/i,
  /\b(important|critical|rule|always do|never do)\b/i,
];

await runCliRaw(import.meta.url, {
  name: "abmind-hook-postuserprompt",
  help: "PostUserPrompt hook — real-time extraction on high-signal exchanges.",
  flags: [],
  handler: async () => {
    ensureHooksDir();
    if (hooksDisabled()) { process.exit(0); }

    try {
      const payload = await readStdinJson<PostUserPromptPayload>();
      const userMsg = payload?.user_message ?? "";
      const assistantMsg = payload?.assistant_message ?? "";
      const combined = userMsg + " " + assistantMsg;

      // Heuristic gate — only extract if high-signal
      const triggered = SIGNAL_PATTERNS.some(p => p.test(combined));
      if (!triggered) { process.exit(0); }

      const memory = new MemoryManager(loadMemoryConfig());
      await memory.initialize({ skipEmbeddingCheck: true });
      try {
        const db = memory.getDatabase();
        if (!db) { process.exit(0); }
        const sleepData = new SleepDataAccess(db);
        let userId: string;
        try { userId = sleepData.getPrimaryUserId(); } catch { process.exit(0); }

        // Record both messages for Dreamy extraction
        const now = Date.now();
        if (userMsg.length > 10) {
          memory.recordMessage({ userId, sessionId: "_A_realtime", role: "user", content: userMsg, timestamp: now - 1000 });
        }
        if (assistantMsg.length > 10) {
          memory.recordMessage({ userId, sessionId: "_A_realtime", role: "assistant", content: assistantMsg, timestamp: now });
        }
      } finally { memory.close(); }
    } catch (err) { logHookError("postuserprompt", err); }
    process.exit(0);
  },
});
