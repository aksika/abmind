#!/usr/bin/env node
/**
 * abmind sleep — standalone sleep cycle entry point.
 *
 * Uses $ABMIND_LLM_CMD as the LLM runtime. The template must contain
 * '{PROMPT_FILE}' which abmind substitutes with a temp file path.
 *
 * Exit codes:
 *   0  success
 *   1  fatal (missing env, malformed template, init failure)
 *   2  completed with failed steps
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliRaw } from "../src/cli-runner-raw.js";
import type { FlagSpec } from "../src/cli-flags.js";
import { loadMemoryConfig } from "../src/memory-config.js";
import { localDate } from "../src/local-time.js";
import { abmindHome } from "../src/mem-paths.js";
import { parseLevel, DEFAULT_LEVEL } from "../src/sleep/levels.js";
import type { Level } from "../src/sleep/levels.js";
import type { SleepRuntime } from "../src/sleep/runtime.js";
import { runSleepCycle } from "../src/sleep/orchestrator.js";
import { runBasicCycle } from "../src/sleep/basic.js";
import { runNativeApply } from "../src/sleep/native.js";
import { MemoryManager } from "../src/memory-manager.js";
import { SleepDataAccess } from "../src/sleep-data-access.js";

const FLAGS: readonly FlagSpec[] = [
  { name: "level", type: "string" },
  { name: "apply", type: "string" },
  { name: "write-daily", type: "string" },
  { name: "dry-run", type: "boolean" },
  { name: "verbose", type: "boolean" },
  { name: "force", type: "boolean" },
];

/** Create a SleepRuntime that shells out to $ABMIND_LLM_CMD with a temp prompt file. */
function makeLlmCmdRuntime(template: string): SleepRuntime {
  const workDir = join(tmpdir(), `abmind-sleep-${process.pid}`);
  mkdirSync(workDir, { recursive: true });
  let callCount = 0;
  return {
    async complete(prompt: string): Promise<string> {
      callCount++;
      const promptFile = join(workDir, `prompt-${callCount}.txt`);
      writeFileSync(promptFile, prompt);
      try {
        const cmd = template.replace(/\{PROMPT_FILE\}/g, promptFile);
        return execFileSync("sh", ["-c", cmd], { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
      } finally {
        try { unlinkSync(promptFile); } catch { /* */ }
      }
    },
  };
}

await runCliRaw(import.meta.url, {
  name: "abmind-sleep",
  banner: "sleep",
  help: `abmind sleep — run a sleep cycle

Usage:
  abmind sleep --level <level> [--dry-run] [--verbose] [--force]
  abmind sleep --level native --apply <file> [--dry-run]

Levels:
  basic      1 LLM call, single-shot daily + memories (frontier models only)
  budget     ~3 LLM calls, essential extraction only
  normal     ~10-14 LLM calls, default
  ultimate   ~14 LLM calls, everything every day
  native     Agent-produced JSON → memory DB (no LLM callback needed)

Env:
  ABMIND_LLM_CMD   Shell template with {PROMPT_FILE}. Required for non-dry runs (except native).
  ABMIND_HOME      Base for memory/ prompts/ logs/. Default: ~/.abmind/

Examples:
  ABMIND_LLM_CMD='cat {PROMPT_FILE} | claude -p' abmind sleep --level basic
  abmind sleep --level native --apply /tmp/sleep-native.json
  abmind sleep --level normal --dry-run`,
  flags: FLAGS,
  handler: async ({ args }) => {
    const levelArg = args["level"] !== undefined ? String(args["level"]) : undefined;
    const dryRun = args["dry-run"] === true;
    const verbose = args["verbose"] === true;
    const force = args["force"] === true;

    const resolvedHome = abmindHome();
    console.error(`[abmind sleep] ABMIND_HOME: ${resolvedHome}`);
    const memoryDirProbe = join(resolvedHome, "memory");
    if (!existsSync(memoryDirProbe)) {
      console.error(`[abmind sleep] WARN: ${memoryDirProbe} does not exist — a fresh memory store will be initialized here.`);
    }

    const memoryConfig = loadMemoryConfig();

    // #528: --write-daily "<text>" — write today's daily summary file directly
    const writeDailyText = args["write-daily"] !== undefined ? String(args["write-daily"]) : undefined;
    if (writeDailyText) {
      const { writeDailyFile } = await import("../src/sleep/sleep-daily-summary.js");
      const today = localDate();
      if (dryRun) {
        console.error(`[abmind sleep] DRY RUN: would write daily for ${today} (${writeDailyText.length} chars)`);
      } else {
        const path = writeDailyFile(memoryConfig.memoryDir, today, writeDailyText);
        console.error(`[abmind sleep] Daily written: ${path}`);
        // #838: write lock so Dreamy/hasSleepAuditToday() won't re-fire
        const sleepDir = join(memoryConfig.memoryDir, "sleep");
        mkdirSync(sleepDir, { recursive: true });
        writeFileSync(join(sleepDir, `sleep_${today.replace(/-/g, "")}.lock`), JSON.stringify({ status: "completed", source: "cli-native", ts: Date.now() }));
      }
      process.exit(0);
    }

    const level: Level = levelArg ? parseLevel(levelArg) : DEFAULT_LEVEL;

    // Native level: no LLM runtime needed, handle early
    if (level === "native") {
      const applyFile = args["apply"] !== undefined ? String(args["apply"]) : undefined;
      if (!applyFile) {
        console.error("[abmind sleep] FATAL: --level native requires --apply <file>");
        process.exit(1);
      }
      const result = await runNativeApply({
        filePath: applyFile,
        memoryConfig,
        dryRun,
      });
      if (!result.ok) {
        console.error(`[abmind sleep] Native failed: ${result.error ?? "unknown"}`);
        process.exit(1);
      }
      for (const w of result.warnings) console.error(`[abmind sleep] warn: ${w}`);
      console.error(`[abmind sleep] Native done: ${result.memoriesStored} memories stored, daily=${result.dailyPath ?? "—"}`);
      return;
    }

    let runtime: SleepRuntime;
    if (dryRun) {
      runtime = { complete: async () => "(dry-run stub)" };
    } else {
      const cmdTemplate = process.env["ABMIND_LLM_CMD"];
      if (!cmdTemplate) {
        console.error("[abmind sleep] FATAL: ABMIND_LLM_CMD is not set. Example:");
        console.error("  export ABMIND_LLM_CMD='cat {PROMPT_FILE} | claude -p'");
        process.exit(1);
      }
      if (!cmdTemplate.includes("{PROMPT_FILE}")) {
        console.error("[abmind sleep] FATAL: ABMIND_LLM_CMD must contain the '{PROMPT_FILE}' substitution token.");
        console.error(`  Got: ${cmdTemplate}`);
        process.exit(1);
      }
      runtime = makeLlmCmdRuntime(cmdTemplate);
    }

    try {
      if (level === "basic") {
        const memory = new MemoryManager(memoryConfig);
        await memory.initialize({ skipEmbeddingCheck: true });
        try {
          const db = memory.getDb();
          if (!db) throw new Error("MemoryManager DB not available after init");
          const sleepData = new SleepDataAccess(db);
          const userId = sleepData.getPrimaryUserId();
          const watermark = sleepData.getExtractionWatermark(userId);
          const msgs = sleepData.getMessagesAfter(watermark);

          if (msgs.length === 0 && !force) {
            console.error("[abmind sleep] No messages since last sleep. Use --force to run anyway.");
            return;
          }

          const messagesBlock = msgs.length > 0
            ? msgs.map(m => `[${m.role}]${m.emotion_score ? ` (emotion:${m.emotion_score})` : ""} ${m.content.slice(0, 500)}`).join("\n")
            : "(no new messages — running housekeeping via --force)";

          const firstTs = msgs.length > 0 ? watermark : Date.now();
          const lastTs = msgs.length > 0 ? Date.now() : Date.now();
          const toIso = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

          const result = await runBasicCycle({
            runtime, memoryConfig, userId,
            dateStart: toIso(firstTs), dateEnd: toIso(lastTs),
            messages: messagesBlock,
          });

          if (!result.ok) {
            console.error(`[abmind sleep] Basic failed: ${result.error ?? "unknown"}`);
            process.exit(1);
          }
          for (const w of result.warnings) console.error(`[abmind sleep] warn: ${w}`);
          console.error(`[abmind sleep] Basic done: ${result.memoriesStored} memories stored, daily=${result.dailyPath ?? "—"}`);
          return;
        } finally {
          memory.close();
        }
      }

      const result = await runSleepCycle({
        runtime, level,
        flags: { dryRun, verbose, force },
        memoryConfigOverride: memoryConfig,
      });
      if (!result.ok) process.exit(2);
    } catch (err) {
      console.error(`[abmind sleep] FATAL: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  },
});
