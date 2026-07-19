#!/usr/bin/env node
/**
 * abmind hook Notification — log as session breadcrumb for retrospective.
 */

import { runCliRaw } from "../src/cli-runner-raw.js";
import { getMemoryClient, closeClient } from "../src/backend-factory.js";
import { MemoryManager } from "../src/memory-manager.js";
import { SleepDataAccess } from "../src/sleep-data-access.js";
import { hooksDisabled, logHookError, readStdinJson, ensureHooksDir } from "../src/hook-helpers.js";

interface NotificationPayload {
  hook_event_name?: string;
  message?: string;
}

await runCliRaw(import.meta.url, {
  name: "abmind-hook-notification",
  help: "Notification hook — log as session breadcrumb.",
  flags: [],
  handler: async () => {
    ensureHooksDir();
    if (hooksDisabled()) { process.exit(0); }

    try {
      const payload = await readStdinJson<NotificationPayload>();
      const message = payload?.message?.trim();
      if (!message) { process.exit(0); }

      const client = await getMemoryClient(false);
      const memory = client as MemoryManager;
      try {
        const db = memory.getDatabase();
        if (!db) { process.exit(0); }
        const sleepData = new SleepDataAccess(db);
        let userId: string;
        try { userId = sleepData.getPrimaryUserId(); } catch { process.exit(0); }

        memory.recordMessage({
          userId, sessionId: "_S_breadcrumb", role: "assistant",
          content: `[NOTIFICATION] ${message.slice(0, 200)}`,
          timestamp: Date.now(),
        });
      } finally { closeClient(client); }
    } catch (err) { logHookError("notification", err); }
    process.exit(0);
  },
});
