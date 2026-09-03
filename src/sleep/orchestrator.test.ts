/**
 * Integration tests for the sleep orchestrator (#175, migrated to the
 * host-neutral contract in #1353).
 *
 * Covers the canonical scenarios from the backlog + plan:
 *   1. Fresh cycle — all steps run, watermark advances
 *   2. Resume — restart mid-cycle, skip ok steps, extract-memories consumes pre-seeded daily file
 *   3. Catch-up — previous day lock with failed essentials, recover via date-range
 *   4. Essential failure — watermark does NOT advance
 *   5. Budget exhaustion — status: partial/failed with budget tracked
 *   6. 3-day-old lock — abandoned + deleted
 *   7-8. resume/LLM-unavailable domain rules unchanged
 *   9-13. neutral SleepEvent lifecycle
 *   14-15. transport rejection surfaces immediately — no abmind-side backoff (#1353)
 *   16. empty response — bounded domain retry unchanged
 *   17-19. run identity, already_running, no_work
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runSleepCycle, essentialSleepSteps, evaluateSleepReview } from "./orchestrator.js";
import type { ReviewFinding, SleepReviewFacts } from "./orchestrator.js";
import { setupTestEnv, type TestEnv } from "./test-harness.js";
import type { SleepRunOptions, SleepEvent, SleepCompletionRequest } from "./contracts.js";
import type { SleepState, StepResult } from "./state.js";
import { getMemoryDb } from "../memory-manager.js";
import { metaGet, metaGetInt } from "../meta-store.js";
import { SleepCompletionDeadlineError } from "../sleep-service/runtime-broker.js";

/** Common run options — deterministic time, generous timeout, fresh forced. */
function baseOpts(env: TestEnv, overrides: Partial<SleepRunOptions> = {}): SleepRunOptions {
  return {
    runtime: env.runtime,
    now: () => env.now,
    timeoutMs: 60_000,
    fresh: false,
    betweenStepBackoffMs: () => 0,
    memoryConfigOverride: { memoryDir: env.memoryDir, memoryEnabled: true },
    ...overrides,
  };
}

/** Set canned responses for all LLM-driven steps. */
function defaultCannedResponses(env: TestEnv): void {
  env.runtime.setDefault("ok");
  // The single-shot daily prompt's real anchor is "Update the summary
  // incorporating" (buildPrompt) — the response must be long enough to clear
  // the shared 50-char daily-file viability floor (#1653).
  env.runtime.setResponse("Update the summary incorporating", "- user asked about X\n- decision Y made\n- a second durable fact worth remembering across sessions");
  env.runtime.setResponse("store a memory using abmind store", "2 memories stored");
  env.runtime.setResponse("retrospective", "Today went well. Flagged nothing.");
}

function recentCatchupDates(): { todayIso: string; previousIso: string; previousStr: string } {
  const today = new Date();
  const format = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const previous = new Date(today);
  previous.setDate(previous.getDate() - 1);
  const previousIso = format(previous);
  return { todayIso: format(today), previousIso, previousStr: previousIso.replace(/-/g, "") };
}

function readLock(env: TestEnv): { status: string; steps: Record<string, { status: string }>; llmCalls?: number; runId?: string } | null {
  const p = join(env.sleepDir, `sleep_${env.todayStr}.lock`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

function readWatermarkAny(env: TestEnv): number {
  const db = getMemoryDb(env.memory);
  if (!db) throw new Error("no db");
  const row = db.prepare("SELECT last_processed_timestamp FROM extraction_watermarks ORDER BY last_processed_timestamp DESC LIMIT 1").get() as { last_processed_timestamp: number } | undefined;
  return row?.last_processed_timestamp ?? 0;
}

describe("#175/#1353 sleep orchestrator integration", () => {
  it("1. fresh cycle — happy path: completes, watermark advances, budget matches unskipped count", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    try {
      const result = await runSleepCycle(baseOpts(env));

      expect(result.status).toBe("completed");
      expect(result.essentialFailures).toHaveLength(0);
      expect(result.watermarkAdvanced).toBe(true);
      expect(result.runId.length).toBeGreaterThan(0);

      const lock = readLock(env);
      expect(lock, "lock file must exist after run").not.toBeNull();
      expect(lock!.status).toBe("completed");
      expect(lock!.runId).toBe(result.runId);

      for (const name of essentialSleepSteps()) {
        expect(lock!.steps[name]?.status, `essential step ${name}`).toBe("ok");
      }

      expect(existsSync(join(env.dailyDir, `daily_${env.todayIso}.md`))).toBe(true);
      expect(readWatermarkAny(env)).toBeGreaterThan(0);
      expect(result.llmCalls, `llmCalls should be > 0 when work was done`).toBeGreaterThan(0);
    } finally { env.cleanup(); }
  });

  it("2. resume mid-cycle — skips ok steps, other steps still execute", async () => {
    const env = await setupTestEnv({
      seedMessages: 3,
      preseedLock: {
        status: "ongoing",
        steps: {
          "daily-summary": { status: "ok", duration: 2.5 },
          "extract-memories": { status: "ok", duration: 1.2 },
        },
      },
      preseedDailyFile: { date: "2026-04-18", content: "# Daily Summary\n\n- preseeded summary content that is long enough to be considered usable for extraction and retrospective (more than fifty chars)" },
    });
    defaultCannedResponses(env);
    try {
      const result = await runSleepCycle(baseOpts(env));

      const dailySummaryCalls = env.runtime.callsFor("running summary of today");
      expect(dailySummaryCalls.length, "daily-summary must NOT be re-invoked on resume").toBe(0);

      const retroCalls = env.runtime.callsFor("retrospective");
      expect(retroCalls.length, "non-preseeded steps must still execute on resume").toBeGreaterThan(0);

      const lock = readLock(env);
      expect(lock!.steps["daily-summary"]?.status).toBe("ok");
      expect(lock!.steps["extract-memories"]?.status).toBe("ok");
      expect(result.resumable).toBe(false); // completed successfully, not left resumable
    } finally { env.cleanup(); }
  });

  it("3. catch-up — previous day with failed daily-summary recovers via date-range summary", async () => {
    const dates = recentCatchupDates();
    const env = await setupTestEnv({
      today: dates.todayIso,
      seedMessages: 0,
      preseedPreviousDayLock: {
        dateStr: dates.previousStr,
        steps: { "daily-summary": { status: "failed" } },
        ageDaysAtNow: 1,
      },
    });

    const db = getMemoryDb(env.memory)!;
    const yesterdayTs = env.now - 86400_000 + 3_600_000;
    db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(
      "master", "master:telegram", "user", "yesterday message", yesterdayTs,
    );
    defaultCannedResponses(env);

    try {
      await runSleepCycle(baseOpts(env, { fresh: true }));

      const prevLockPath = join(env.sleepDir, `sleep_${dates.previousStr}.lock`);
      const yesterdayDaily = join(env.dailyDir, `daily_${dates.previousIso}.md`);

      const dailyWritten = existsSync(yesterdayDaily);
      const prevLockGone = !existsSync(prevLockPath);
      let prevLockOk = false;
      if (!prevLockGone) {
        const prev = JSON.parse(readFileSync(prevLockPath, "utf-8"));
        prevLockOk = prev.steps?.["daily-summary"]?.status === "ok";
      }
      expect(
        dailyWritten || prevLockGone || prevLockOk,
        `catch-up outcome: dailyWritten=${dailyWritten} prevLockGone=${prevLockGone} prevLockOk=${prevLockOk}`,
      ).toBe(true);
    } finally { env.cleanup(); }
  });

  it("3b. #1752: terminal catch-up failure keeps its stage/cause and remains resumable", async () => {
    const dates = recentCatchupDates();
    const env = await setupTestEnv({
      today: dates.todayIso,
      seedMessages: 0,
      preseedPreviousDayLock: {
        dateStr: dates.previousStr,
        steps: { "daily-summary": { status: "failed" } },
        ageDaysAtNow: 1,
      },
    });
    const db = getMemoryDb(env.memory)!;
    db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(
      "master", "master:telegram", "user", "yesterday message", env.now - 86_400_000 + 3_600_000,
    );
    const providerError = Object.assign(new Error("provider loop stopped"), {
      failure: { cause: "prompt_round_limit", detail: "hard 25 prompt rounds reached" },
    });
    env.runtime.setError("Update the summary incorporating", providerError);

    try {
      const result = await runSleepCycle(baseOpts(env, { fresh: true }));

      expect(result.status).toBe("failed");
      expect(result.resumable).toBe(true);
      expect(result.watermarkAdvanced).toBe(false);
      expect(result.report).toContain("Stage: daily-summary");
      expect(result.report).toContain("Cause: prompt_round_limit — hard 25 prompt rounds reached");
      expect(result.report).toContain("Resume: /sleep resume");
      expect(result.report).not.toContain("Stage: service");
      expect(metaGet(db, "sleep_last_success_ts"), "a catch-up failure must not record a successful cycle").toBeNull();
      expect(metaGetInt(db, "sleep_consecutive_failures"), "a catch-up failure must count toward failure state").toBe(1);

      const previousLock = JSON.parse(readFileSync(join(env.sleepDir, `sleep_${dates.previousStr}.lock`), "utf-8")) as SleepState;
      expect(previousLock.steps["daily-summary"]?.failure?.cause).toBe("prompt_round_limit");
    } finally { env.cleanup(); }
  });

  it("4. essential step failure — watermark does NOT advance", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    env.runtime.setError("retrospective", new Error("simulated retrospective failure"));

    const watermarkBefore = readWatermarkAny(env);

    try {
      const result = await runSleepCycle(baseOpts(env));

      expect(result.status).toBe("failed");
      expect(result.essentialFailures.length).toBeGreaterThan(0);
      expect(result.watermarkAdvanced).toBe(false);

      const lock = readLock(env);
      expect(lock!.status).toBe("failed");
      expect(lock!.steps["retrospective"]?.status).toBe("failed");

      const watermarkAfter = readWatermarkAny(env);
      expect(watermarkAfter, "watermark must NOT advance on essential failure").toBe(watermarkBefore);
    } finally { env.cleanup(); }
  });

  it("4b. #1611: a provider rejection on a NON-essential step is terminal — failed, resumable, no watermark, no later step", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    env.runtime.setError("Post-Retro Derivation", new Error("simulated retro-derive provider rejection"));

    const stepsStarted: string[] = [];
    const watermarkBefore = readWatermarkAny(env);

    try {
      const result = await runSleepCycle(baseOpts(env, {
        onEvent: (e) => { if (e.type === "step_started") stepsStarted.push(e.stepId); },
      }));

      // Model failure is terminal regardless of essential membership (#1611).
      expect(result.status, "a provider rejection must not degrade to partial").toBe("failed");
      expect(result.essentialFailures).toHaveLength(0);
      expect(result.resumable, "the failed sleep must stay resumable").toBe(true);
      expect(result.watermarkAdvanced, "no watermark advance on terminal model failure").toBe(false);
      expect(result.report).toContain("retro-derive");
      expect(result.report).toContain("provider_failed");
      expect(result.report).toContain("Stage:");
      expect(result.report).toContain("Action:");

      const lock = readLock(env);
      expect(lock!.status, "the lock must be failed, not completed").toBe("failed");
      expect(lock!.steps["retro-derive"]?.status).toBe("failed");

      const afterFailure = stepsStarted.indexOf("retro-derive");
      expect(afterFailure, "retro-derive must have started").toBeGreaterThanOrEqual(0);
      expect(stepsStarted.length, "no later step may start after the terminal failure").toBe(afterFailure + 1);

      const watermarkAfter = readWatermarkAny(env);
      expect(watermarkAfter).toBe(watermarkBefore);
    } finally { env.cleanup(); }
  });

  it("5. budget exhaustion — llmCalls tracked accurately", async () => {
    const originalBudget = process.env["SLEEP_MAX_LLM_CALLS"];
    process.env["SLEEP_MAX_LLM_CALLS"] = "2";

    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);

    try {
      const result = await runSleepCycle(baseOpts(env));
      expect(result.llmCalls, "budget tracking must work").toBeGreaterThan(0);
      const lock = readLock(env);
      expect(lock, "lock must exist").not.toBeNull();
    } finally {
      env.cleanup();
      if (originalBudget === undefined) delete process.env["SLEEP_MAX_LLM_CALLS"];
      else process.env["SLEEP_MAX_LLM_CALLS"] = originalBudget;
    }
  });

  it("6. 3-day-old lock — abandoned and deleted", async () => {
    const env = await setupTestEnv({
      seedMessages: 1,
      preseedPreviousDayLock: {
        dateStr: "20260414",
        steps: { "daily-summary": { status: "failed" } },
        ageDaysAtNow: 4,
      },
    });
    defaultCannedResponses(env);

    const oldLockPath = join(env.sleepDir, "sleep_20260414.lock");
    expect(existsSync(oldLockPath), "precondition: old lock seeded").toBe(true);

    try {
      await runSleepCycle(baseOpts(env));
      expect(existsSync(oldLockPath), "4-day-old lock must be deleted").toBe(false);
    } finally { env.cleanup(); }
  });

  it("7. resume with daily-summary done + path recorded — extract-memories runs (#181)", async () => {
    const dailyContent = "# Daily Summary\n\n- something memorable happened that we want to remember across sessions\n- also a second note to ensure the content passes the minimum length threshold";
    const env = await setupTestEnv({
      seedMessages: 3,
      preseedDailyFile: { date: "2026-04-18", content: dailyContent },
    });
    const dailyPath = join(env.memoryDir, "daily", "daily_2026-04-18.md");
    const lockPath = join(env.sleepDir, "sleep_20260418.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({
        status: "ongoing",
        pid: 99999,
        // Use the harness clock — a real-world startedAt would leave the
        // review's extraction window empty (#1653).
        startedAt: env.now - 60_000,
        llmCalls: 0,
        steps: {
          "daily-summary": { status: "ok", duration: 2.5, path: dailyPath },
        },
      }),
      "utf-8",
    );
    defaultCannedResponses(env);

    try {
      await runSleepCycle(baseOpts(env));

      const dailyCalls = env.runtime.callsFor("running summary of today");
      expect(dailyCalls.length, "daily-summary must NOT be re-invoked").toBe(0);

      const extractCalls = env.runtime.callsFor("store a memory");
      expect(extractCalls.length, "extract-memories must run when daily path is recorded").toBeGreaterThan(0);

      const lock = readLock(env);
      expect(lock!.steps["extract-memories"]?.status).toBe("ok");
    } finally { env.cleanup(); }
  });

  it("8. LLM unavailable on daily-summary — step fails, no deterministic fallback (#182)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    env.runtime.setError("Update the summary incorporating", new Error("LLM down"));

    const watermarkBefore = readWatermarkAny(env);

    try {
      const result = await runSleepCycle(baseOpts(env));

      expect(result.status, "cycle should NOT report completed when essential step fails").not.toBe("completed");

      const lock = readLock(env);
      expect(lock!.steps["daily-summary"]?.status, "daily-summary must be marked failed").toBe("failed");

      const watermarkAfter = readWatermarkAny(env);
      expect(watermarkAfter, "watermark must NOT advance when LLM is unavailable").toBe(watermarkBefore);

      const dailyFiles = readdirSync(join(env.memoryDir, "daily")).filter(f => f.startsWith("daily_") && f.endsWith(".md"));
      expect(dailyFiles, "no daily file should be written when LLM failed").toHaveLength(0);
    } finally { env.cleanup(); }
  });

  it("9. neutral SleepEvent fires step_started + exactly one terminal per step (#1353)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);

    const events: SleepEvent[] = [];
    try {
      await runSleepCycle(baseOpts(env, { onEvent: (e) => events.push(e) }));

      const started = events.filter(e => e.type === "step_started");
      const terminal = events.filter(e => e.type === "step_completed" || e.type === "step_skipped" || e.type === "step_failed");
      expect(started.length, "one step_started per attempted step").toBeGreaterThan(0);
      expect(started.length, "started count == terminal count").toBe(terminal.length);

      for (const e of started) {
        if (e.type !== "step_started") continue;
        expect(e.stepId.length, "stepId must be non-empty").toBeGreaterThan(0);
        expect(e.index, "index must be 1-based and positive").toBeGreaterThan(0);
        expect(e.total, "total must be positive").toBeGreaterThan(0);
        expect(e.index, "index must be <= total").toBeLessThanOrEqual(e.total);
      }

      const startIndexes = started.map(e => (e as { type: "step_started"; index: number }).index);
      for (let i = 1; i < startIndexes.length; i++) {
        expect(startIndexes[i], `start[${i}] must equal ${startIndexes[i - 1]! + 1}`).toBe(startIndexes[i - 1]! + 1);
      }
    } finally { env.cleanup(); }
  });

  it("10. step_skipped fires for skipped steps (#1353)", async () => {
    const env = await setupTestEnv({ seedMessages: 0 });
    defaultCannedResponses(env);

    const events: SleepEvent[] = [];
    try {
      await runSleepCycle(baseOpts(env, { fresh: true, mode: "manual", onEvent: (e) => events.push(e) }));

      const skipped = events.filter(e => e.type === "step_skipped");
      expect(skipped.length, "at least one step should skip with 0 messages").toBeGreaterThan(0);
    } finally { env.cleanup(); }
  });

  it("11. throwing event observer never breaks the cycle (#1353 constraint 5)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);

    let callCount = 0;
    try {
      const result = await runSleepCycle(baseOpts(env, {
        onEvent: (e) => { callCount++; if (e.type === "step_started") throw new Error("display bug"); },
      }));

      expect(result.status, "cycle must succeed even when the event observer throws").toBe("completed");
      expect(callCount, "observer must be called despite throwing").toBeGreaterThan(0);
    } finally { env.cleanup(); }
  });

  it("12. cycle_started fires once before any step, cycle_finished fires exactly once (#1353)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);

    let cycleStartFires = 0;
    let cycleFinishFires = 0;
    let cycleStartTotal = 0;
    const order: string[] = [];
    try {
      await runSleepCycle(baseOpts(env, {
        onEvent: (e) => {
          if (e.type === "cycle_started") { cycleStartFires++; cycleStartTotal = e.totalSteps; order.push("cycleStart"); }
          if (e.type === "cycle_finished") cycleFinishFires++;
          if (e.type === "step_started") order.push(`step:${e.stepId}`);
        },
      }));

      expect(cycleStartFires, "cycle_started fires exactly once per run").toBe(1);
      expect(cycleFinishFires, "cycle_finished fires exactly once per run").toBe(1);
      expect(cycleStartTotal, "totalSteps reported to cycle_started").toBeGreaterThan(0);
      expect(order[0], "cycle_started fires before first step").toBe("cycleStart");
    } finally { env.cleanup(); }
  });

  it("13. no onEvent callback — behaves identically (backward compat)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    try {
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      const lock = readLock(env);
      expect(lock!.status).toBe("completed");
    } finally { env.cleanup(); }
  });

  it("14. runtime rejection surfaces immediately — no abmind-side transport backoff/retry (#1353)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);

    // Every call throws — this must now surface on the FIRST attempt, not after
    // any abmind-owned retry window (that policy moved to the host).
    let gcCallCount = 0;
    env.runtime.complete = async (request: SleepCompletionRequest): Promise<string> => {
      if (request.prompt.includes("garbage")) {
        gcCallCount++;
        throw new Error("fetch failed — provider unreachable");
      }
      return "ok";
    };

    try {
      const result = await runSleepCycle(baseOpts(env));

      expect(gcCallCount, "abmind must not retry a transport rejection itself").toBe(1);
      expect(result.status, "a provider rejection is terminal — never completed").toBe("failed");
      expect(result.resumable).toBe(true);
      expect(result.watermarkAdvanced).toBe(false);

      const lock = readLock(env);
      expect(lock!.steps["gc-noise"]?.status, "gc-noise must be failed after a single rejection").toBe("failed");
    } finally { env.cleanup(); }
  });

  it("15. runtime always rejects — cycle stops, no later step runs (#1353)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);

    env.runtime.complete = async (): Promise<string> => {
      throw new Error("fetch failed — provider down");
    };

    const stepsStarted: string[] = [];
    try {
      const result = await runSleepCycle(baseOpts(env, {
        onEvent: (e) => { if (e.type === "step_started") stepsStarted.push(e.stepId); },
      }));

      expect(result.status, "a provider rejection is terminal — never completed").toBe("failed");
      expect(result.resumable).toBe(true);
      expect(result.report).toContain("Stage:");
      expect(result.report).toContain("Action:");
      expect(stepsStarted.length, "at most one step starts before the break").toBeLessThanOrEqual(2);
      expect(stepsStarted, "no step may start after the failing one").toEqual(stepsStarted.slice(0, 1));

      const lock = readLock(env);
      expect(lock).not.toBeNull();
      const okSteps = Object.entries(lock!.steps).filter(([, s]) => s.status === "ok").map(([k]) => k);
      expect(okSteps.length, "no steps succeed when runtime always throws").toBe(0);
    } finally { env.cleanup(); }
  });

  it("16. empty response — bounded domain retry (4x) still applies, budget consumed per attempt (#1279, #1353, #1752 R12)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);

    let gcEmptyCalls = 0;
    const origComplete = env.runtime.complete.bind(env.runtime);
    env.runtime.complete = async (request: SleepCompletionRequest): Promise<string | import("./contracts.js").SleepCompletionResult> => {
      if (request.prompt.includes("garbage")) {
        gcEmptyCalls++;
        return "";
      }
      return origComplete(request) as unknown as string | import("./contracts.js").SleepCompletionResult;
    };

    try {
      const result = await runSleepCycle(baseOpts(env, { retryDelays: [0] }));

      expect(gcEmptyCalls, "empty-response path retries exactly 4 times (domain retry, not transport)").toBe(4);
      // #1752 R11: invalid_response on non-essential gc-noise no longer fails cycle — partial, resumable, watermark advances
      expect(result.status).toBe("partial");
      expect(result.report).toContain("gc-noise");
      expect(result.report).toContain("invalid_response");

      const lock = readLock(env);
      expect(lock, "lock file must exist").not.toBeNull();
      expect(lock!.steps["gc-noise"]?.status, "gc-noise must be failed after retry exhaustion").toBe("failed");
      expect(result.resumable).toBe(true);
    } finally { env.cleanup(); }
  });

  it("17. each run gets a stable, unique runId; a resumed run records priorRunId lineage", async () => {
    const env = await setupTestEnv({
      seedMessages: 3,
      preseedLock: { status: "ongoing", steps: { "daily-summary": { status: "ok" } } },
    });
    defaultCannedResponses(env);
    try {
      const before = readLock(env);
      const priorRunId = before?.runId;

      const result = await runSleepCycle(baseOpts(env));

      expect(result.runId.length).toBeGreaterThan(0);
      const after = readLock(env) as { runId?: string; priorRunId?: string } | null;
      expect(after?.runId).toBe(result.runId);
      if (priorRunId) {
        expect(after?.priorRunId, "resumed run should record prior lineage, not impersonate it").toBe(priorRunId);
        expect(after?.runId).not.toBe(priorRunId);
      }
    } finally { env.cleanup(); }
  });

  it("18. concurrent in-process invocation against the same memory dir returns already_running", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    try {
      const [first, second] = await Promise.all([
        runSleepCycle(baseOpts(env)),
        runSleepCycle(baseOpts(env)),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toContain("already_running");
    } finally { env.cleanup(); }
  });

  it("19. no messages since last sleep returns no_work, not completed", async () => {
    const env = await setupTestEnv({ seedMessages: 0 });
    defaultCannedResponses(env);
    try {
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("no_work");
      expect(result.watermarkAdvanced).toBe(false);
    } finally { env.cleanup(); }
  });

  it("20. no-work guard is user-scoped — another user's messages do not count (#1608)", async () => {
    const env = await setupTestEnv({ seedMessages: 0 });
    defaultCannedResponses(env);
    try {
      // The harness primary user is "master". Messages exist in the DB but
      // only for a DIFFERENT user — the guard must not see them as work.
      const db = getMemoryDb(env.memory)!;
      db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(
        "adrika", "adrika:telegram", "user", "message from another user", env.now - 60_000,
      );
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("no_work");
      expect(result.watermarkAdvanced).toBe(false);
    } finally { env.cleanup(); }
  });

  it("21. #1611: explicit resume after a terminal failure reruns the failed step and skips completed checkpoints", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    // First run: retrospective (essential) rejects → sleep fails there.
    env.runtime.setError("retrospective", new Error("provider down"));
    try {
      const first = await runSleepCycle(baseOpts(env));
      expect(first.status).toBe("failed");
      expect(first.resumable).toBe(true);

      // User repairs the provider; the explicit resume reruns the failed step.
      let dailySummaryCalls = 0;
      env.runtime.complete = async (request: SleepCompletionRequest) => {
        if (request.prompt.includes("running summary of today")) {
          dailySummaryCalls++;
          return "- user asked about X\n- decision Y made";
        }
        if (request.prompt.includes("store a memory using abmind store")) return "2 memories stored";
        return "ok";
      };
      const second = await runSleepCycle(baseOpts(env));

      expect(second.status, "resume after provider repair completes the cycle").toBe("completed");
      expect(second.watermarkAdvanced).toBe(true);
      const lock = readLock(env);
      expect(lock!.steps["retrospective"]?.status).toBe("ok");
      // Completed checkpoints before the failure stay skipped on resume.
      expect(dailySummaryCalls, "daily-summary must not rerun on resume").toBe(0);
    } finally { env.cleanup(); }
  });

  it("22. #1611: a broker completion deadline maps to terminal step_deadline (step marked timeout)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    const orig = env.runtime.complete.bind(env.runtime);
    env.runtime.complete = async (request: SleepCompletionRequest) => {
      if (request.prompt.includes("garbage")) throw new SleepCompletionDeadlineError("comp-1", "gc-noise");
      return orig(request);
    };
    try {
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("failed");
      expect(result.resumable).toBe(true);
      expect(result.report).toContain("gc-noise");
      expect(result.report).toContain("step_deadline");
      const lock = readLock(env);
      expect(lock!.steps["gc-noise"]?.status, "deadline failures mark the step timeout").toBe("timeout");
    } finally { env.cleanup(); }
  });

  it("23. #1653: a normal run produces no review finding and keeps the report shape", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    try {
      const result = await runSleepCycle(baseOpts(env));

      expect(result.status).toBe("completed");
      expect(result.watermarkAdvanced).toBe(true);
      expect(result.report).toContain("Sleep completed");
      expect(result.report, "no review line on a healthy run").not.toContain("Review degraded");
      expect(result.report).not.toContain("Review");
      expect(result.resumable).toBe(false);
      const lock = readLock(env);
      for (const name of essentialSleepSteps()) {
        expect(lock!.steps[name]?.status, `essential step ${name}`).toBe("ok");
      }
    } finally { env.cleanup(); }
  });

  it("24. #1653: extraction reporting success without creating rows is downgraded — failed, resumable, no watermark, review line, then resume completes", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    // Bypass the harness's row-seeding hook: extraction "succeeds" but creates
    // no memories — the deterministic review must fail the run closed.
    const origComplete = env.runtime.complete.bind(env.runtime);
    env.runtime.complete = async (request: SleepCompletionRequest) => {
      if (request.prompt.includes("store a memory using abmind store")) return "2 memories stored";
      return origComplete(request);
    };
    const watermarkBefore = readWatermarkAny(env);
    try {
      const result = await runSleepCycle(baseOpts(env));

      expect(result.status, "zero extraction writes must fail the run").toBe("failed");
      expect(result.resumable).toBe(true);
      expect(result.watermarkAdvanced).toBe(false);
      expect(readWatermarkAny(env)).toBe(watermarkBefore);
      expect(result.report).toContain("Review degraded");
      expect(result.report).toContain("extract-memories");
      expect(result.report).toContain("no extraction writes");
      expect(result.report, "no raw model output in the report").not.toContain("2 memories stored");

      const lock = readLock(env);
      expect(lock!.steps["extract-memories"]?.status, "the ok step must be downgraded to failed").toBe("failed");
      expect(lock!.status).toBe("failed");

      // Same-day explicit resume reruns only the downgraded step — completed
      // checkpoints stay skipped, and the repaired extraction (real rows via
      // the harness hook) completes the cycle.
      env.runtime.complete = origComplete;
      const second = await runSleepCycle(baseOpts(env));
      expect(second.status, "resume after the extraction fix completes").toBe("completed");
      expect(second.watermarkAdvanced).toBe(true);
      expect(second.resumable).toBe(false);
      const lock2 = readLock(env);
      expect(lock2!.steps["extract-memories"]?.status).toBe("ok");
      expect(lock2!.steps["daily-summary"]?.status).toBe("ok");
      expect(env.runtime.callsFor("store a memory using abmind store"), "extraction must run exactly once in the resumed cycle").toHaveLength(1);
    } finally { env.cleanup(); }
  });

  it("25. #1653: an ok daily-summary whose recorded artifact is missing downgrades it before watermark advancement", async () => {
    const missingPath = join("/tmp", `abmind-missing-daily-${Date.now()}`, "daily_2026-04-18.md");
    const env = await setupTestEnv({
      seedMessages: 3,
      preseedLock: {
        status: "ongoing",
        steps: { "daily-summary": { status: "ok", duration: 2.5, path: missingPath } },
      },
    });
    defaultCannedResponses(env);
    const watermarkBefore = readWatermarkAny(env);
    try {
      const result = await runSleepCycle(baseOpts(env));

      expect(result.status, "a missing daily artifact must fail the run").toBe("failed");
      expect(result.resumable).toBe(true);
      expect(result.watermarkAdvanced).toBe(false);
      expect(readWatermarkAny(env)).toBe(watermarkBefore);
      expect(result.report).toContain("Review degraded");
      expect(result.report).toContain("daily-summary");
      expect(result.report, "the artifact path must never leak into the report").not.toContain("abmind-missing-daily");

      const lock = readLock(env);
      expect(lock!.steps["daily-summary"]?.status, "daily-summary must be downgraded to failed").toBe("failed");
    } finally { env.cleanup(); }
  });

  it("26. #1653: a partial run with a failed non-essential step is resumable; same-day resume reruns it while skipping ok/skipped checkpoints", async () => {
    const originalBudget = process.env["SLEEP_MAX_LLM_CALLS"];
    process.env["SLEEP_MAX_LLM_CALLS"] = "5";
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    try {
      const first = await runSleepCycle(baseOpts(env));

      expect(first.status, "non-essential exhaustion must degrade to partial, not failed").toBe("partial");
      expect(first.resumable, "a partial run with a failed non-essential step is resumable").toBe(true);
      expect(first.watermarkAdvanced, "essentials succeeded — the watermark still advances").toBe(true);
      expect(first.report).not.toContain("Review degraded");
      expect(first.essentialFailures).toHaveLength(0);

      const lock = readLock(env);
      const failedNonEssential = Object.entries(lock!.steps).filter(([, s]) => s.status === "failed").map(([k]) => k);
      expect(failedNonEssential.length).toBeGreaterThan(0);
      for (const name of essentialSleepSteps()) {
        expect(lock!.steps[name]?.status).toBe("ok");
      }
    } finally {
      if (originalBudget === undefined) delete process.env["SLEEP_MAX_LLM_CALLS"];
      else process.env["SLEEP_MAX_LLM_CALLS"] = originalBudget;
      env.cleanup();
    }
  });
});

describe("#1653 evaluateSleepReview — deterministic decision", () => {
  function review(
    steps: Record<string, StepResult>,
    facts?: Partial<SleepReviewFacts>,
  ): ReviewFinding[] {
    const state: SleepState = { status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0, steps };
    return evaluateSleepReview(
      state,
      {
        bufferedMessageCount: 0,
        extractedMemoryCount: null,
        stepCalls: () => 0,
        acceptedOutputChars: new Map(),
        dailyArtifactUsable: null,
        ...facts,
      },
      ["gc-noise", "daily-summary", "extract-memories", "retrospective", "retro-derive"],
    );
  }

  it("flags an ok budget-consuming step with zero accepted output; skips no-budget and skipped steps", () => {
    const findings = review(
      { "retro-derive": { status: "ok" }, "gc-noise": { status: "ok" }, "daily-summary": { status: "skipped" } },
      {
        stepCalls: (id) => (id === "retro-derive" ? 1 : 0),
        acceptedOutputChars: new Map([["gc-noise", 4]]),
      },
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ stepId: "retro-derive", code: "budget_without_output", downgrade: true, repeat: true });
  });

  it("does not flag an ok step with accepted output", () => {
    const findings = review(
      { "retro-derive": { status: "ok" } },
      { stepCalls: () => 1, acceptedOutputChars: new Map([["retro-derive", 12]]) },
    );
    expect(findings).toHaveLength(0);
  });

  it("existing failure takes precedence over derivative rules and is never rewritten", () => {
    const findings = review(
      { "daily-summary": { status: "failed" }, "extract-memories": { status: "timeout" } },
      {
        dailyArtifactUsable: false,
        bufferedMessageCount: 3,
        extractedMemoryCount: 0,
        stepCalls: () => 1,
      },
    );

    expect(findings.map(f => f.code)).toEqual(["step_failed", "step_failed"]);
    expect(findings.every(f => f.downgrade === false), "existing failures are not rewritten").toBe(true);
    expect(findings.every(f => f.repeat)).toBe(true);
  });

  it("flags an unusable daily artifact only when daily-summary is ok and the artifact is proven unusable", () => {
    expect(review({ "daily-summary": { status: "ok" } }, { dailyArtifactUsable: false })[0]).toMatchObject({
      stepId: "daily-summary", code: "daily_artifact_unusable", downgrade: true,
    });
    expect(review({ "daily-summary": { status: "ok" } }, { dailyArtifactUsable: true })).toHaveLength(0);
    expect(review({ "daily-summary": { status: "ok" } }, { dailyArtifactUsable: null }), "no artifact fact — no judgment").toHaveLength(0);
  });

  it("flags zero extraction writes only when messages, an ok step, and charged calls coincide", () => {
    const base = { "extract-memories": { status: "ok" } as StepResult };
    const okFacts = {
      bufferedMessageCount: 2,
      extractedMemoryCount: 0,
      stepCalls: (id: string) => (id === "extract-memories" ? 1 : 0),
      // the step accepted domain output — only the DB write count varies below
      acceptedOutputChars: new Map([["extract-memories", 18]]),
    };

    expect(review(base, okFacts)[0]).toMatchObject({ stepId: "extract-memories", code: "no_extraction_writes", downgrade: true });
    expect(review(base, { ...okFacts, extractedMemoryCount: 1 }), "rows exist — not flagged").toHaveLength(0);
    expect(review(base, { ...okFacts, bufferedMessageCount: 0 }), "no buffered messages — not flagged").toHaveLength(0);
    expect(review(base, { ...okFacts, stepCalls: () => 0 }), "no model call this attempt — not flagged").toHaveLength(0);
  });

  it("reports at most one finding per step in loaded step order", () => {
    const findings = review(
      {
        "gc-noise": { status: "failed" },
        "daily-summary": { status: "ok" },
        "extract-memories": { status: "ok" },
        "retro-derive": { status: "ok" },
      },
      {
        dailyArtifactUsable: false,
        bufferedMessageCount: 2,
        extractedMemoryCount: 0,
        stepCalls: (id) => (id === "extract-memories" || id === "retro-derive" ? 1 : 0),
        acceptedOutputChars: new Map(),
      },
    );

    expect(findings.map(f => f.stepId)).toEqual(["gc-noise", "daily-summary", "extract-memories", "retro-derive"]);
    expect(findings.map(f => f.code)).toEqual(["step_failed", "daily_artifact_unusable", "no_extraction_writes", "budget_without_output"]);
  });
});
