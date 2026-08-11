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
import { getMemoryClient, closeClient } from "../src/backend-factory.js";
import { MemoryManager, getMemoryDb } from "../src/memory-manager.js";
import { SleepDataAccess } from "../src/sleep-data-access.js";
import { hooksDisabled, logHookError, readStdinJson, ensureHooksDir } from "../src/hook-helpers.js";
import { abmindHooksDir, extractionPendingPath, extractionFailuresPath } from "../src/mem-paths.js";
import { readdirSync, statSync, unlinkSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHookAdapterContext } from "./hook-lifecycle-adapter.js";

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

      const mem = await getMemoryClient(false);
      const memory = mem as MemoryManager;
      try {
        const maxChars = Number(process.env.ABMIND_HOOK_WAKEUP_MAX_CHARS ?? DEFAULT_WAKEUP_CHARS);
        const ctx = buildHookAdapterContext(memory);

        let output = "";
        if (ctx) {
          const sessionResult = await ctx.lifecycle!.startSession({
            identity: ctx.identity,
            maxChars,
          });
          if (sessionResult.ok && sessionResult.context.trim()) {
            output = sessionResult.context;
          }
        } else {
          // Fallback: direct wake-up if adapter context is unavailable
          const wakeUp = memory.buildWakeUp(maxChars);
          if (wakeUp && wakeUp.trim()) {
            output = wakeUp;
          }
        }

        // #644 — check core files exist
        const bundle = memory.getSessionBundle();
        if (!bundle.soul && !bundle.notes) {
          output += (output ? "\n\n" : "") + "[⚠️ SOUL BUNDLE MISSING] Core persona files (SOUL.md, agent_notes.md) not found. Alert the user.";
        }

        // #366 — check if extraction is needed
        const extractionBlock = buildExtractionInjection(memory);
        if (extractionBlock) {
          output += (output ? "\n\n" : "") + extractionBlock;
        }

        // #529 — check if full sleep is overdue (>24h since last audit)
        if (!extractionBlock) {
          const sleepBlock = buildSleepInjection(memory);
          if (sleepBlock) {
            output += (output ? "\n\n" : "") + sleepBlock;
          }
        }

        // #646 — system status
        const { buildStatusBlock } = await import("../src/status-block.js");
        const statusBlock = buildStatusBlock(memory);
        if (statusBlock) output += (output ? "\n\n" : "") + statusBlock;

        writeHookOutput(output, format);
      } finally {
        closeClient(mem);
      }
    } catch (err) {
      logHookError("wakeup", err);
    }

    process.exit(0);
  },
});

// ── #366 Extraction staleness check ────────────────────────────────────────

function buildExtractionInjection(memory: MemoryManager): string | null {
  const db = getMemoryDb(memory);
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

/** #528 — Inject sleep instructions when overdue (>24h since last audit). */
function buildSleepInjection(memory: MemoryManager): string | null {
  const memDir = memory.getConfig().memoryDir;
  const sleepDir = join(memDir, "sleep");
  try {
    const files = readdirSync(sleepDir).filter(f => f.startsWith("sleep_")).sort();
    if (files.length === 0) return null; // never slept — don't force on first run
    const latest = files[files.length - 1]!;
    const st = statSync(join(sleepDir, latest));
    const hoursSince = (Date.now() - st.mtimeMs) / 3600_000;
    if (hoursSince < 24) return null; // recent enough
  } catch { return null; }

  const today = new Date().toISOString().slice(0, 10);
  // Check if daily already exists for today
  const dailyDir = join(memDir, "daily");
  const dailyExists = existsSync(join(dailyDir, `daily_${today}.md`));

  if (dailyExists) return null; // daily written — sleep maintenance is current enough

  return `---
⚠️ MEMORY MAINTENANCE OVERDUE (>24h since last cycle)

Before responding, run these steps:

1. Read recent messages: \`abmind expand --since-last-extraction --format summary-prompt\`
2. Write a 2-3 paragraph narrative summary of what happened (topics discussed, decisions made, notable events):
   \`abmind sleep --write-daily "Your summary here"\`
3. If the expand output contains facts/preferences/decisions worth remembering long-term, store them:
   \`abmind store --translated "..." --original "..." --memory-type fact --emotion-tags "..." --user-id master\`
4. Then respond to the user normally.

Keep the summary factual and concise. Focus on what matters in a week, not greetings or debugging noise.
---`;
}
