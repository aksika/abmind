#!/usr/bin/env node
/**
 * abmind hook store — Kiro CLI stop hook (#344).
 *
 * Reads JSON from stdin: { hook_event_name: "stop", cwd, assistant_response }
 * Reads the matching sidecar file for the prompt (written by the recall hook).
 * Records the full turn (user prompt + assistant response). Deletes sidecar.
 *
 * Exit 0 unconditionally. NEVER writes to stdout (Kiro's stop hook stdout is
 * shown to the user — we don't want noise after every turn).
 *
 * GAP: The stop hook does NOT fire on Ctrl+C / SIGINT / process crash /
 * session timeout. Those turns are lost. Users who need every-turn recording
 * should use the dedicated-agent pattern (#343) instead.
 */

import { runCliRaw } from "../src/cli-runner-raw.js";
import { loadMemoryConfig } from "../src/memory-config.js";
import { MemoryManager } from "../src/memory-manager.js";
import { SleepDataAccess } from "../src/sleep-data-access.js";
import { hooksDisabled, logHookError, readStdinJson, ensureHooksDir } from "../src/hook-helpers.js";
import { hookSidecarPath, abmindHooksDir, hookSidecarKey } from "../src/mem-paths.js";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

interface StopPayload {
  hook_event_name?: string;
  cwd?: string;
  assistant_response?: string;
}

await runCliRaw(import.meta.url, {
  name: "abmind-hook-store",
  help: `Usage:
  abmind hook store

Kiro CLI stop hook. Reads hook event JSON from stdin, records the turn
(user prompt + assistant response) via abmind's message store.

The user prompt comes from a sidecar file written by the recall hook
(keyed on KIRO_SESSION_ID). If the sidecar is missing, only the
assistant response is recorded.

Exits 0 unconditionally. Writes nothing to stdout.

Env var: ABMIND_HOOKS_DISABLED=true disables all hooks.`,
  flags: [],
  handler: async () => {
    ensureHooksDir();
    if (hooksDisabled()) { process.exit(0); }

    try {
      const payload = await readStdinJson<StopPayload>();
      const assistantResponse = payload?.assistant_response?.trim();
      // If there's no assistant response, nothing to record — but still clean up sidecar.
      const sidecarPath = hookSidecarPath();

      let userPrompt: string | undefined;
      if (existsSync(sidecarPath)) {
        try { userPrompt = readFileSync(sidecarPath, "utf-8").trim(); }
        catch (err) { logHookError("store:sidecar-read", err); }
      }

      if (assistantResponse || userPrompt) {
        const memory = new MemoryManager(loadMemoryConfig());
        await memory.initialize({ skipEmbeddingCheck: true });
        try {
          const db = memory.getDatabase();
          if (!db) { process.exit(0); }
          const sleepData = new SleepDataAccess(db);
          let userId: string;
          try { userId = sleepData.getPrimaryUserId(); }
          catch { process.exit(0); /* no user registered yet */ }

          const sessionId = process.env.KIRO_SESSION_ID?.trim() || "kiro-hooks";
          const now = Date.now();

          if (userPrompt) {
            memory.recordMessage({
              userId,
              sessionId,
              role: "user",
              content: userPrompt,
              timestamp: now - 1,  // prompt before response
            });
          }
          if (assistantResponse) {
            // Append tools context from postToolUse sidecar
            let content = assistantResponse;
            const toolsSidecar = join(abmindHooksDir(), `tools-${hookSidecarKey()}.sidecar`);
            if (existsSync(toolsSidecar)) {
              try {
                const tools = readFileSync(toolsSidecar, "utf-8").trim();
                if (tools) content += `\n\n[tools used]\n${tools}`;
              } catch (err) { logHookError("store:tools-read", err); }
            }
            memory.recordMessage({
              userId,
              sessionId,
              role: "assistant",
              content,
              timestamp: now,
            });
          }
        } finally {
          memory.close();
        }
      }

      // Clean up sidecars regardless of outcome
      if (existsSync(sidecarPath)) {
        try { unlinkSync(sidecarPath); }
        catch (err) { logHookError("store:sidecar-unlink", err); }
      }
      const toolsSidecarCleanup = join(abmindHooksDir(), `tools-${hookSidecarKey()}.sidecar`);
      if (existsSync(toolsSidecarCleanup)) {
        try { unlinkSync(toolsSidecarCleanup); }
        catch (err) { logHookError("store:tools-unlink", err); }
      }
    } catch (err) {
      logHookError("store", err);
    }

    process.exit(0);
  },
});
