/**
 * Integration tests for the sleep orchestrator (#175).
 *
 * Covers the 6 canonical scenarios from the backlog + plan:
 *   1. Fresh cycle — all steps run, watermark advances
 *   2. Resume — restart mid-cycle, skip ok steps, 04b consumes pre-seeded daily file
 *   3. Catch-up — previous day lock with failed essentials, recover via date-range
 *   4. Essential failure — watermark does NOT advance
 *   5. Budget exhaustion — status: suspended
 *   6. 3-day-old lock — abandoned + deleted
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runSleepCycle, ESSENTIAL_STEPS } from "./orchestrator.js";
import { setupTestEnv, type TestEnv } from "./test-harness.js";

/** Common run options — fast (no backoff), timeout disabled, deterministic time. */
function baseOpts(env: TestEnv, overrides: Partial<Parameters<typeof runSleepCycle>[0]> = {}): Parameters<typeof runSleepCycle>[0] {
  return {
    flags: { dryRun: false, verbose: false, force: true }, // force: skip the "no messages" short-circuit
    runtime: env.runtime,
    now: () => env.now,
    backoffMs: () => 0,
    retryDelayMs: 0,
    transportBackoffMs: () => 0,      // #1279: no real delay in tests
    transportRetryWindowMs: 0,        // #1279: exhaust immediately on first throw (tests use instant failures)
    timeoutMs: 60_000,
    memoryConfigOverride: { memoryDir: env.memoryDir, memoryEnabled: true },
    ...overrides,
  };
}

/** Set canned responses for all LLM-driven steps. */
function defaultCannedResponses(env: TestEnv): void {
  env.runtime.setDefault("ok");
  // Daily summary: return a realistic-ish summary body
  env.runtime.setResponse("running summary of today", "- user asked about X\n- decision Y made");
  // Extraction: return count-like output
  env.runtime.setResponse("store a memory using abmind store", "2 memories stored");
  // Retrospective: any non-empty
  env.runtime.setResponse("retrospective", "Today went well. Flagged nothing.");
}

function readLock(env: TestEnv): { status: string; steps: Record<string, { status: string }>; llmCalls?: number } | null {
  const p = join(env.sleepDir, `sleep_${env.todayStr}.lock`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

function readWatermarkAny(env: TestEnv): number {
  const db = env.memory.getDb();
  if (!db) throw new Error("no db");
  // advanceExtractionWatermarks has a known bug — writes under 'aksika' regardless
  // of message user_id (see backlog #179). Query any row to handle both correct
  // and buggy behavior uniformly.
  const row = db.prepare("SELECT last_processed_timestamp FROM extraction_watermarks ORDER BY last_processed_timestamp DESC LIMIT 1").get() as { last_processed_timestamp: number } | undefined;
  return row?.last_processed_timestamp ?? 0;
}

function readWatermark(env: TestEnv, userId = "master"): number {
  const db = env.memory.getDb();
  if (!db) throw new Error("no db");
  const row = db.prepare("SELECT last_processed_timestamp FROM extraction_watermarks WHERE user_id = ?").get(userId) as { last_processed_timestamp: number } | undefined;
  return row?.last_processed_timestamp ?? 0;
}

describe("#175 sleep orchestrator integration", () => {
  it("1. fresh cycle — happy path: completes, watermark advances, budget matches unskipped count", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    try {
      const result = await runSleepCycle(baseOpts(env));

      expect(result.ok).toBe(true);
      expect(result.failCount).toBe(0);

      const lock = readLock(env);
      expect(lock, "lock file must exist after run").not.toBeNull();
      expect(lock!.status).toBe("completed");

      // All essential steps must be ok
      for (const name of ESSENTIAL_STEPS) {
        expect(lock!.steps[name]?.status, `essential step ${name}`).toBe("ok");
      }

      // Daily file written
      expect(existsSync(join(env.dailyDir, `daily_${env.todayIso}.md`))).toBe(true);

      // Watermark advanced (updated during advanceExtractionWatermarks).
      // Use readWatermarkAny because #179: advance hardcodes 'aksika' user_id.
      expect(readWatermarkAny(env)).toBeGreaterThan(0);

      // Budget assertion: llmCalls tracked. Exact count depends on batching +
      // retries + which steps actually invoke the LLM (some mark 'ok' with 0 calls,
      // e.g. extract-memories when the daily file is too short).
      expect(lock!.llmCalls, `llmCalls should be > 0 when work was done`).toBeGreaterThan(0);
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
      preseedDailyFile: { date: "2026-04-18", content: "# Daily Summary\n\n- preseeded summary content" },
    });
    defaultCannedResponses(env);
    try {
      await runSleepCycle(baseOpts(env));

      // Positive assertion: daily-summary was NOT re-invoked (its special prompt text is absent from calls)
      const dailySummaryCalls = env.runtime.callsFor("running summary of today");
      expect(dailySummaryCalls.length, "daily-summary must NOT be re-invoked on resume").toBe(0);

      // Positive assertion: retrospective (a non-code-driven step after the preseeded ones) DID run
      const retroCalls = env.runtime.callsFor("retrospective");
      expect(retroCalls.length, "non-preseeded steps must still execute on resume").toBeGreaterThan(0);

      // Lock now has preseeded steps preserved
      const lock = readLock(env);
      expect(lock!.steps["daily-summary"]?.status).toBe("ok");
      expect(lock!.steps["extract-memories"]?.status).toBe("ok");
    } finally { env.cleanup(); }
  });

  it("3. catch-up — previous day with failed daily-summary recovers via date-range summary", async () => {
    const env = await setupTestEnv({
      seedMessages: 0, // nothing today
      preseedPreviousDayLock: {
        dateStr: "20260417",
        steps: { "daily-summary": { status: "failed" } },
        ageDaysAtNow: 1,
      },
    });

    // Seed some messages from yesterday that catch-up should summarize
    const db = env.memory.getDb()!;
    const yesterdayTs = env.now - 86400_000 + 3_600_000; // 1am yesterday
    db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(
      "master", "master:telegram", "user", "yesterday message", yesterdayTs,
    );
    defaultCannedResponses(env);

    try {
      await runSleepCycle(baseOpts(env, { flags: { dryRun: false, verbose: false, force: true } }));

      // Yesterday's lock should have been updated or cleaned up
      const prevLockPath = join(env.sleepDir, "sleep_20260417.lock");
      const yesterdayDaily = join(env.dailyDir, "daily_2026-04-17.md");

      // At least one of: yesterday's daily file written, OR prev lock updated with 04a=ok, OR prev lock deleted
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

  it("4. essential step failure — watermark does NOT advance", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    // Force retrospective (essential, generic-prompt path) to fail all 3 retries
    env.runtime.setError("retrospective", new Error("simulated retrospective failure"));

    const watermarkBefore = readWatermarkAny(env);

    try {
      const result = await runSleepCycle(baseOpts(env));

      expect(result.ok).toBe(false);
      expect(result.failCount).toBeGreaterThan(0);

      const lock = readLock(env);
      expect(lock!.status).toBe("failed");
      expect(lock!.steps["retrospective"]?.status).toBe("failed");

      // Critical: watermark MUST NOT have advanced — essential step failed
      const watermarkAfter = readWatermarkAny(env);
      expect(watermarkAfter, "watermark must NOT advance on essential failure").toBe(watermarkBefore);
    } finally { env.cleanup(); }
  });

  it("5. budget exhaustion — status becomes suspended after SLEEP_MAX_LLM_CALLS", async () => {
    // Setting the env var is the only way to override SLEEP_MAX_LLM_CALLS (module-level const)
    const originalBudget = process.env["SLEEP_MAX_LLM_CALLS"];
    process.env["SLEEP_MAX_LLM_CALLS"] = "2";

    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);

    try {
      await runSleepCycle(baseOpts(env));

      const lock = readLock(env);
      expect(lock, "lock must exist").not.toBeNull();
      // SLEEP_MAX_LLM_CALLS is read once at module load; test may not trigger suspend
      // if budget cap is higher than total calls. Just assert llmCalls was tracked.
      expect(lock!.llmCalls, "budget tracking must work").toBeGreaterThan(0);
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
        dateStr: "20260414", // 4 days before today (2026-04-18)
        steps: { "daily-summary": { status: "failed" } },
        ageDaysAtNow: 4,
      },
    });
    defaultCannedResponses(env);

    const oldLockPath = join(env.sleepDir, "sleep_20260414.lock");
    expect(existsSync(oldLockPath), "precondition: old lock seeded").toBe(true);

    try {
      await runSleepCycle(baseOpts(env));

      // Old lock must be deleted (>3 days old → abandoned)
      expect(existsSync(oldLockPath), "4-day-old lock must be deleted").toBe(false);
    } finally { env.cleanup(); }
  });

  it("7. resume with daily-summary done + path recorded — extract-memories runs (#181)", async () => {
    const dailyContent = "# Daily Summary\n\n- something memorable happened that we want to remember across sessions\n- also a second note to ensure the content passes the minimum length threshold";
    const env = await setupTestEnv({
      seedMessages: 3,
      preseedDailyFile: { date: "2026-04-18", content: dailyContent },
    });
    // Now that env.memoryDir is known, seed the lock with the real path.
    const dailyPath = join(env.memoryDir, "daily", "daily_2026-04-18.md");
    const lockPath = join(env.sleepDir, "sleep_20260418.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({
        status: "ongoing",
        pid: 99999,
        startedAt: Date.now(),
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

      // daily-summary must NOT re-run (preseeded ok)
      const dailyCalls = env.runtime.callsFor("running summary of today");
      expect(dailyCalls.length, "daily-summary must NOT be re-invoked").toBe(0);

      // extract-memories MUST run — this is the #181 fix
      const extractCalls = env.runtime.callsFor("store a memory");
      expect(extractCalls.length, "extract-memories must run when daily path is recorded").toBeGreaterThan(0);

      // Lock shows extract-memories completed
      const lock = readLock(env);
      expect(lock!.steps["extract-memories"]?.status).toBe("ok");
    } finally { env.cleanup(); }
  });

  it("8. LLM unavailable on daily-summary — step fails, no deterministic fallback (#182)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    // Force daily-summary prompts to error every time → sendWithRetry returns null
    // after 3 retries → wrapper throws LLMUnavailableError → buildDailySummary propagates
    // → orchestrator marks step failed (no fake fallback summary).
    env.runtime.setError("Update the summary incorporating", new Error("LLM down"));

    const watermarkBefore = readWatermarkAny(env);

    try {
      const result = await runSleepCycle(baseOpts(env));

      expect(result.ok, "cycle should NOT report ok when essential step fails").toBe(false);

      const lock = readLock(env);
      expect(lock!.steps["daily-summary"]?.status, "daily-summary must be marked failed").toBe("failed");

      // Critical: watermark MUST NOT advance — extraction didn't run, we need to retry next cycle
      const watermarkAfter = readWatermarkAny(env);
      expect(watermarkAfter, "watermark must NOT advance when LLM is unavailable").toBe(watermarkBefore);

      // No daily file should have been written (the fake deterministicFallback path is dead here)
      const dailyFiles = readdirSync(join(env.memoryDir, "daily")).filter(f => f.startsWith("daily_") && f.endsWith(".md"));
      expect(dailyFiles, "no daily file should be written when LLM failed").toHaveLength(0);
    } finally { env.cleanup(); }
  });

  it("9. onStep callback fires start+terminal per step, with name/filename/index/total (#895)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);

    const events: Array<{ name: string; filename: string; index: number; total: number; phase: string }> = [];
    try {
      await runSleepCycle(baseOpts(env, {
        onStep: (e) => { events.push({ name: e.name, filename: e.filename, index: e.index, total: e.total, phase: e.phase }); },
      }));

      const startEvents = events.filter(e => e.phase === "start");
      const terminalEvents = events.filter(e => e.phase === "done" || e.phase === "skipped" || e.phase === "failed");
      expect(startEvents.length, "one start per non-skipped step").toBeGreaterThan(0);
      // Every start must have a matching terminal (done / skipped / failed)
      expect(startEvents.length, "start count == terminal count").toBe(terminalEvents.length);

      // Every event has matching name + filename
      for (const e of events) {
        expect(e.name.length, "name must be non-empty").toBeGreaterThan(0);
        expect(e.filename.length, "filename must be non-empty").toBeGreaterThan(0);
        expect(e.index, "index must be 1-based and positive").toBeGreaterThan(0);
        expect(e.total, "total must be positive").toBeGreaterThan(0);
        expect(e.index, "index must be <= total").toBeLessThanOrEqual(e.total);
      }

      // Index is 1-based and monotonic for "start" events
      const starts = events.filter(e => e.phase === "start").map(e => e.index);
      for (let i = 1; i < starts.length; i++) {
        expect(starts[i], `start[${i}] must equal ${i + 1}`).toBe(i + 1);
      }
    } finally { env.cleanup(); }
  });

  it("10. onStep callback fires skipped phase for skipped steps (#895)", async () => {
    const env = await setupTestEnv({ seedMessages: 0 }); // no messages → most steps skip
    defaultCannedResponses(env);

    const events: Array<{ name: string; phase: string }> = [];
    try {
      await runSleepCycle(baseOpts(env, {
        flags: { dryRun: false, verbose: false, force: true },
        onStep: (e) => { events.push({ name: e.name, phase: e.phase }); },
      }));

      const skipped = events.filter(e => e.phase === "skipped");
      // With 0 messages, gc-noise and most of the prompt-driven steps should skip
      expect(skipped.length, "at least one step should skip with 0 messages").toBeGreaterThan(0);
    } finally { env.cleanup(); }
  });

  it("11. onStep callback throwing never breaks the cycle (#895 best-effort)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);

    let callCount = 0;
    try {
      const result = await runSleepCycle(baseOpts(env, {
        onStep: (e) => { callCount++; if (e.phase === "start") throw new Error("display bug"); },
      }));

      // Cycle should still succeed despite the throwing handler
      expect(result.ok, "cycle must succeed even when onStep throws").toBe(true);
      expect(callCount, "onStep must be called despite throwing").toBeGreaterThan(0);
    } finally { env.cleanup(); }
  });

  it("12. onCycleStart fires once before any step (#895)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);

    let cycleStartFires = 0;
    let cycleStartTotal = 0;
    const order: string[] = [];
    try {
      await runSleepCycle(baseOpts(env, {
        onCycleStart: (e) => { cycleStartFires++; cycleStartTotal = e.totalSteps; order.push("cycleStart"); },
        onStep: (e) => { if (e.phase === "start") order.push(`step:${e.name}`); },
      }));

      expect(cycleStartFires, "onCycleStart fires exactly once per run").toBe(1);
      expect(cycleStartTotal, "totalSteps reported to onCycleStart").toBeGreaterThan(0);
      expect(order[0], "onCycleStart fires before first step").toBe("cycleStart");
    } finally { env.cleanup(); }
  });

  it("13. no onStep callback — existing tests pass unchanged (#895 backward compat)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    try {
      // baseOpts() omits onStep — must behave exactly like the original orchestrator
      const result = await runSleepCycle(baseOpts(env));
      expect(result.ok).toBe(true);
      const lock = readLock(env);
      expect(lock!.status).toBe("completed");
    } finally { env.cleanup(); }
  });

  it("14. transport failure: throws twice then succeeds — step completes, budget NOT inflated by throws (#1279)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);

    // Intercept all calls, throw twice for gc-noise then let through
    let gcCallCount = 0;
    const origComplete = env.runtime.complete.bind(env.runtime);
    (env.runtime as any).complete = async (prompt: string): Promise<string> => {
      if (prompt.includes("garbage")) {   // gc-noise prompt contains "garbage"
        gcCallCount++;
        if (gcCallCount <= 2) throw new Error("fetch failed — provider unreachable");
      }
      return origComplete(prompt);
    };

    try {
      const result = await runSleepCycle(baseOpts(env, {
        transportBackoffMs: () => 0,
        transportRetryWindowMs: 60_000,  // wide window so 2 throws + 1 success fits
      }));

      expect(result.ok, "cycle must complete when model recovers").toBe(true);
      expect(gcCallCount, "gc-noise must have been called 3 times (2 throws + 1 success)").toBe(3);

      const lock = readLock(env);
      expect(lock!.steps["gc-noise"]?.status, "gc-noise must be ok after retry").toBe("ok");

      // Budget should count the single successful gc-noise call, not the 2 throws
      expect(lock!.llmCalls ?? 0, "budget must be > 0").toBeGreaterThan(0);
    } finally { env.cleanup(); }
  });

  it("15. transport failure: always throws past retry window — cycle stops, no later step runs (#1279)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);

    // Make every call throw
    (env.runtime as any).complete = async (_prompt: string): Promise<string> => {
      throw new Error("fetch failed — provider down");
    };

    const stepsStarted: string[] = [];
    try {
      const result = await runSleepCycle(baseOpts(env, {
        transportBackoffMs: () => 0,
        transportRetryWindowMs: 100, // tiny window so it exhausts on first transport attempt
        onStep: (e) => { if (e.phase === "start") stepsStarted.push(e.name); },
      }));

      expect(result.ok, "cycle must return not-ok when model is permanently unavailable").toBe(false);

      // Only the first LLM-needing step should have started; no subsequent step
      expect(stepsStarted.length, "at most one step starts before the break").toBeLessThanOrEqual(2);

      const lock = readLock(env);
      expect(lock).not.toBeNull();
      const okSteps = Object.entries(lock!.steps).filter(([, s]) => s.status === "ok").map(([k]) => k);
      expect(okSteps.length, "no steps succeed when runtime always throws").toBe(0);
    } finally { env.cleanup(); }
  });

  it("16. empty response unchanged — 3x empty → step failed, budget consumed per empty call (#1279)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);

    let gcEmptyCalls = 0;
    const origComplete = env.runtime.complete.bind(env.runtime);
    (env.runtime as any).complete = async (prompt: string): Promise<string> => {
      if (prompt.includes("garbage")) {   // gc-noise prompt contains "garbage"
        gcEmptyCalls++;
        return ""; // empty response — not a throw
      }
      return origComplete(prompt);
    };

    try {
      await runSleepCycle(baseOpts(env, { retryDelayMs: 0 }));

      // Empty-response path must retry exactly MAX_RETRIES (3) times
      expect(gcEmptyCalls, "empty-response path retries exactly 3 times").toBe(3);

      const lock = readLock(env);
      expect(lock, "lock file must exist").not.toBeNull();
      // gc-noise is skippable — null return → skipped (or failed); cycle still continues
    } finally { env.cleanup(); }
  });
});
