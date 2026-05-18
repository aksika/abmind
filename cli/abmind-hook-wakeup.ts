#!/usr/bin/env node
/**
 * abmind hook wakeup — Kiro CLI agentSpawn hook (#344).
 *
 * Reads JSON from stdin: { hook_event_name: "agentSpawn", cwd }
 * Writes wake-up context to stdout. Exit 0 always (never blocks chat).
 *
 * Also cleans up stale sidecar files (>1h old) as a side effect — wakeup is
 * the natural "new session" signal.
 */

import { runCliRaw } from "../src/cli-runner-raw.js";
import { loadMemoryConfig } from "../src/memory-config.js";
import { MemoryManager } from "../src/memory-manager.js";
import { SleepDataAccess } from "../src/sleep-data-access.js";
import { hooksDisabled, logHookError, readStdinJson, ensureHooksDir } from "../src/hook-helpers.js";
import { abmindHooksDir, extractionPendingPath, extractionFailuresPath } from "../src/mem-paths.js";
import { readdirSync, statSync, unlinkSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_WAKEUP_CHARS = 5000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_HOURS = 24;
const DEFAULT_MIN_MESSAGES = 20;
const DEFAULT_MAX_FAILURES = 3;

function cleanupStaleSidecars(): void {
  try {
    const dir = abmindHooksDir();
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("last-prompt-")) continue;
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (now - st.mtimeMs > ONE_HOUR_MS) unlinkSync(p);
      } catch { /* skip this one */ }
    }
  } catch { /* dir doesn't exist yet — nothing to clean */ }
}

await runCliRaw(import.meta.url, {
  name: "abmind-hook-wakeup",
  help: `Usage:
  abmind hook wakeup

Kiro CLI agentSpawn hook. Reads hook event JSON from stdin, outputs wake-up
context for injection into the agent's context. Exits 0 unconditionally.

Disable via env var: ABMIND_HOOKS_DISABLED=true`,
  flags: [],
  handler: async () => {
    ensureHooksDir();
    cleanupStaleSidecars();

    if (hooksDisabled()) { process.exit(0); }

    try {
      await readStdinJson(); // payload is just { hook_event_name, cwd } — we don't use the contents, but drain stdin cleanly

      const { resolveHookFormat, writeHookOutput } = await import("./hook-output.js");
      const format = resolveHookFormat();

      const config = loadMemoryConfig();
      const memory = new MemoryManager(config);
      await memory.initialize({ skipEmbeddingCheck: true });
      try {
        const maxChars = Number(process.env.ABMIND_HOOK_WAKEUP_MAX_CHARS ?? DEFAULT_WAKEUP_CHARS);
        const wakeUp = memory.buildWakeUp(maxChars);
        let output = "";
        if (wakeUp && wakeUp.trim()) {
          output = wakeUp;
        }

        // #366 — check if extraction is needed
        const extractionBlock = buildExtractionInjection(memory);
        if (extractionBlock) {
          output += (output ? "\n\n" : "") + extractionBlock;
        }

        writeHookOutput(output, format);
      } finally {
        memory.close();
      }
    } catch (err) {
      logHookError("wakeup", err);
    }

    process.exit(0);
  },
});

// ── #366 Extraction staleness check ────────────────────────────────────────

function buildExtractionInjection(memory: MemoryManager): string | null {
  const db = memory.getDb();
  if (!db) return null;

  // Clean stale pending markers (>1h) — user-disappears is not a failure
  const pendingPath = extractionPendingPath();
  if (existsSync(pendingPath)) {
    try {
      const st = statSync(pendingPath);
      if (Date.now() - st.mtimeMs > ONE_HOUR_MS) unlinkSync(pendingPath);
    } catch { /* ignore */ }
  }

  // Check failure cooldown
  const maxFailures = Number(process.env.ABMIND_EXTRACTION_MAX_FAILURES ?? DEFAULT_MAX_FAILURES);
  const failuresPath = extractionFailuresPath();
  if (existsSync(failuresPath)) {
    try {
      const data = JSON.parse(readFileSync(failuresPath, "utf-8")) as { count: number; lastFailure: number };
      if (data.count >= maxFailures && Date.now() - data.lastFailure < 24 * ONE_HOUR_MS) return null;
      if (Date.now() - data.lastFailure >= 24 * ONE_HOUR_MS) unlinkSync(failuresPath); // reset after cooldown
    } catch { /* malformed — ignore */ }
  }

  // Check staleness
  const sleepData = new SleepDataAccess(db);
  const userId = sleepData.getPrimaryUserId();
  const watermark = sleepData.getExtractionWatermark(userId);
  const maxAgeMs = Number(process.env.ABMIND_EXTRACTION_MAX_AGE_HOURS ?? DEFAULT_MAX_AGE_HOURS) * 3600_000;
  const minMessages = Number(process.env.ABMIND_EXTRACTION_MIN_MESSAGES ?? DEFAULT_MIN_MESSAGES);

  if (Date.now() - watermark < maxAgeMs) return null; // recent enough

  const pending = (db.prepare(
    "SELECT COUNT(*) as c FROM messages WHERE user_id = ? AND timestamp > ?",
  ).get(userId, watermark) as { c: number }).c;

  if (pending < minMessages) return null; // not enough messages

  // Write pending marker
  writeFileSync(pendingPath, String(Date.now()));

  const daysSince = Math.round((Date.now() - watermark) / 86400_000);
  return `---
⚠️ MEMORY MAINTENANCE NEEDED (last extraction: ${daysSince} day${daysSince !== 1 ? "s" : ""} ago, ${pending} messages pending)

Run this extraction routine before responding to the user:

1. Read messages: \`abmind expand --since-last-extraction --format json\`
2. Produce a JSON object with this EXACT schema:
   {"daily": "One-paragraph narrative summary of what happened.", "memories": [{"content_en": "English fact", "content_original": "original if non-English", "memory_type": "fact"}, ...]}
   Valid memory_type: fact, decision, preference, event, lesson, feedback, story
3. Write to /tmp/abmind-extract.json
4. Run: \`abmind sleep --level native --apply /tmp/abmind-extract.json\`
5. Proceed with user's request normally.

Extract: facts about the user, decisions made, preferences stated, lessons learned. Skip: greetings, tool outputs, debugging noise.
---`;
}
