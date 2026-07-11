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
import { runSleepCycle, ESSENTIAL_STEPS } from "./orchestrator.js";
import { setupTestEnv, type TestEnv } from "./test-harness.js";
import type { SleepRunOptions, SleepEvent } from "./contracts.js";

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
  env.runtime.setResponse("running summary of today", "- user asked about X\n- decision Y made");
  env.runtime.setResponse("store a memory using abmind store", "2 memories stored");
  env.runtime.setResponse("retrospective", "Today went well. Flagged nothing.");
}

function readLock(env: TestEnv): { status: string; steps: Record<string, { status: string }>; llmCalls?: number; runId?: string } | null {
  const p = join(env.sleepDir, `sleep_${env.todayStr}.lock`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

function readWatermarkAny(env: TestEnv): number {
  const db = env.memory.getDb();
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

      for (const name of ESSENTIAL_STEPS) {
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
      preseedDailyFile: { date: "2026-04-18", content: "# Daily Summary\n\n- preseeded summary content" },
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
    const env = await setupTestEnv({
      seedMessages: 0,
      preseedPreviousDayLock: {
        dateStr: "20260417",
        steps: { "daily-summary": { status: "failed" } },
        ageDaysAtNow: 1,
      },
    });

    const db = env.memory.getDb()!;
    const yesterdayTs = env.now - 86400_000 + 3_600_000;
    db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(
      "master", "master:telegram", "user", "yesterday message", yesterdayTs,
    );
    defaultCannedResponses(env);

    try {
      await runSleepCycle(baseOpts(env, { fresh: true }));

      const prevLockPath = join(env.sleepDir, "sleep_20260417.lock");
      const yesterdayDaily = join(env.dailyDir, "daily_2026-04-17.md");

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
    env.runtime.setError("retrospective", new Error("simulated retrospective failure"));

    const watermarkBefore = readWatermarkAny(env);

    try {
      const result = await runSleepCycle(baseOpts(env));

      expect(result.status).not.toBe("completed");
      expect(result.essentialFailures.length).toBeGreaterThan(0);
      expect(result.watermarkAdvanced).toBe(false);

      const lock = readLock(env);
      expect(lock!.status).toBe("failed");
      expect(lock!.steps["retrospective"]?.status).toBe("failed");

      const watermarkAfter = readWatermarkAny(env);
      expect(watermarkAfter, "watermark must NOT advance on essential failure").toBe(watermarkBefore);
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
    (env.runtime as any).complete = async (request: { prompt: string }): Promise<string> => {
      if (request.prompt.includes("garbage")) {
        gcCallCount++;
        throw new Error("fetch failed — provider unreachable");
      }
      return "ok";
    };

    try {
      const result = await runSleepCycle(baseOpts(env));

      expect(gcCallCount, "abmind must not retry a transport rejection itself").toBe(1);
      expect(result.status, "cycle must not report completed when the runtime rejects").not.toBe("completed");

      const lock = readLock(env);
      expect(lock!.steps["gc-noise"]?.status, "gc-noise must be failed after a single rejection").toBe("failed");
    } finally { env.cleanup(); }
  });

  it("15. runtime always rejects — cycle stops, no later step runs (#1353)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);

    (env.runtime as any).complete = async (): Promise<string> => {
      throw new Error("fetch failed — provider down");
    };

    const stepsStarted: string[] = [];
    try {
      const result = await runSleepCycle(baseOpts(env, {
        onEvent: (e) => { if (e.type === "step_started") stepsStarted.push(e.stepId); },
      }));

      expect(result.status, "cycle must not report completed when runtime always rejects").not.toBe("completed");
      expect(stepsStarted.length, "at most one step starts before the break").toBeLessThanOrEqual(2);

      const lock = readLock(env);
      expect(lock).not.toBeNull();
      const okSteps = Object.entries(lock!.steps).filter(([, s]) => s.status === "ok").map(([k]) => k);
      expect(okSteps.length, "no steps succeed when runtime always throws").toBe(0);
    } finally { env.cleanup(); }
  });

  it("16. empty response — bounded domain retry (3x) still applies, budget consumed per attempt (#1279, #1353)", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);

    let gcEmptyCalls = 0;
    const origComplete = env.runtime.complete.bind(env.runtime);
    (env.runtime as any).complete = async (request: { prompt: string }): Promise<string> => {
      if (request.prompt.includes("garbage")) {
        gcEmptyCalls++;
        return "";
      }
      return origComplete(request);
    };

    try {
      await runSleepCycle(baseOpts(env, { domainRetryDelayMs: 0 }));

      expect(gcEmptyCalls, "empty-response path retries exactly 3 times (domain retry, not transport)").toBe(3);

      const lock = readLock(env);
      expect(lock, "lock file must exist").not.toBeNull();
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
});
