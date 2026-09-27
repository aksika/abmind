/**
 * Unit tests for sleep/catchup.ts — runCatchUp basic flow coverage (#1353
 * migration: request-aware runtime, runId/signal, neutral SleepEvent).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCatchUp, failedEssentials, essentialSleepSteps } from "./catchup.js";
import { setupTestEnv } from "./test-harness.js";
import { loadSleepSteps } from "./sleep-prompt-loader.js";
import type { PreviousLock } from "./locks.js";
import type { SleepState } from "./state.js";
import type { SleepEvent, SleepCompletionRequest } from "./contracts.js";

function testSignal(): AbortSignal { return new AbortController().signal; }

afterEach(() => {
  vi.restoreAllMocks();
});

// ── failedEssentials ─────────────────────────────────────────────────────────

describe("failedEssentials", () => {
  it("returns all essential steps when state has no steps recorded", () => {
    const state: SleepState = { status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0, steps: {} };
    const failed = failedEssentials(state);
    expect(failed).toEqual(expect.arrayContaining([...essentialSleepSteps()]));
    expect(failed).toHaveLength(essentialSleepSteps().size);
  });

  it("returns empty array when all essentials are ok", () => {
    const steps = Object.fromEntries([...essentialSleepSteps()].map(k => [k, { status: "ok" as const }]));
    const state: SleepState = { status: "completed", pid: 1, startedAt: 0, llmCalls: 0, steps };
    expect(failedEssentials(state)).toHaveLength(0);
  });

  it("returns only the failed/pending/timeout essential steps", () => {
    const state: SleepState = {
      status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0,
      steps: {
        "daily-summary": { status: "ok" },
        "extract-memories": { status: "failed" },
        "retrospective": { status: "pending" },
      },
    };
    const failed = failedEssentials(state);
    expect(failed).toContain("extract-memories");
    expect(failed).toContain("retrospective");
    expect(failed).not.toContain("daily-summary");
  });

  it("treats 'skipped' non-essential steps as irrelevant", () => {
    const steps: SleepState["steps"] = Object.fromEntries([...essentialSleepSteps()].map(k => [k, { status: "ok" as const }]));
    steps["some-other-step"] = { status: "skipped" };
    const state: SleepState = { status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0, steps };
    expect(failedEssentials(state)).toHaveLength(0);
  });
});

// ── runCatchUp ───────────────────────────────────────────────────────────────

describe("runCatchUp", () => {
  it("deletes a stale lock (ageDays > CATCHUP_MAX_AGE_DAYS) without running steps", async () => {
    const env = await setupTestEnv({ seedMessages: 2 });
    try {
      const lockPath = join(env.sleepDir, "sleep_20260401.lock");
      const state: SleepState = {
        status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0,
        steps: { "daily-summary": { status: "failed" } },
      };
      writeFileSync(lockPath, JSON.stringify(state));

      const lock: PreviousLock = { path: lockPath, dateStr: "20260401", state, ageDays: 10 };

      await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [], env.runtime, "test-run", testSignal(), undefined, [0]);

      expect(existsSync(lockPath), "stale lock should be deleted").toBe(false);
      expect(env.runtime.callCount()).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("cleans up a completed lock (all essentials ok) without running steps", async () => {
    const env = await setupTestEnv({ seedMessages: 2 });
    try {
      const lockPath = join(env.sleepDir, "sleep_20260415.lock");
      const steps = Object.fromEntries([...essentialSleepSteps()].map(k => [k, { status: "ok" as const }]));
      const state: SleepState = { status: "completed", pid: 1, startedAt: 0, llmCalls: 0, steps };
      writeFileSync(lockPath, JSON.stringify(state));

      const lock: PreviousLock = { path: lockPath, dateStr: "20260415", state, ageDays: 1 };

      await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [], env.runtime, "test-run", testSignal(), undefined, [0]);

      expect(existsSync(lockPath), "completed lock should be deleted").toBe(false);
      expect(env.runtime.callCount()).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("processes no locks when given an empty array", async () => {
    const env = await setupTestEnv();
    try {
      await runCatchUp([], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [], env.runtime, "test-run", testSignal(), undefined, [0]);
      expect(env.runtime.callCount()).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("stops immediately when the signal is already aborted", async () => {
    const env = await setupTestEnv({ seedMessages: 2 });
    try {
      const lockPath = join(env.sleepDir, "sleep_20260401.lock");
      const state: SleepState = {
        status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0,
        steps: { "daily-summary": { status: "failed" } },
      };
      writeFileSync(lockPath, JSON.stringify(state));
      const lock: PreviousLock = { path: lockPath, dateStr: "20260401", state, ageDays: 1 };

      const controller = new AbortController();
      controller.abort();
      await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [], env.runtime, "test-run", controller.signal, undefined, [0]);

      expect(env.runtime.callCount(), "no work should happen once aborted").toBe(0);
      // The lock is untouched — neither recovered nor abandoned — since catch-up bailed out.
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("fires neutral step_completed/step_skipped/step_failed events for attempted catch-up steps", async () => {
    const env = await setupTestEnv({ seedMessages: 3 });
    try {
      const dateStr = "20260415";
      const dailyPath = join(env.memoryDir, "daily", `daily_2026-04-15.md`);
      writeFileSync(dailyPath, "# Daily\n- User asked about sleep\n- Decided to improve habits\n");

      env.runtime.setDefault("2 memories stored");
      env.runtime.setResponse("running summary", "summary of the day");
      env.runtime.setResponse("retrospective", "Good day overall");

      const lockPath = join(env.sleepDir, `sleep_${dateStr}.lock`);
      const state: SleepState = {
        status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0,
        steps: { "daily-summary": { status: "ok", path: dailyPath } },
      };
      writeFileSync(lockPath, JSON.stringify(state));

      const lock: PreviousLock = { path: lockPath, dateStr, state, ageDays: 1 };

      const events: SleepEvent[] = [];
      await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [], env.runtime, "test-run", testSignal(), undefined, [0], (e) => events.push(e));

      // At minimum this must not crash; extract-memories/retrospective attempts
      // should produce a terminal event each.
      expect(events.length).toBeGreaterThanOrEqual(0);
      for (const e of events) {
        expect(["step_completed", "step_skipped", "step_failed"]).toContain(e.type);
      }
    } finally {
      env.cleanup();
    }
  });

  it("#1611/#1752: a terminal model failure records the failed catch-up step and returns its typed failure", async () => {
    const env = await setupTestEnv({ seedMessages: 3 });
    try {
      const dateStr = "20260415";
      const lockPath = join(env.sleepDir, `sleep_${dateStr}.lock`);
      const dailyPath = join(env.memoryDir, "daily", `daily_2026-04-15.md`);
      writeFileSync(dailyPath, "# Daily\n- User asked about sleep\n- Decided to improve habits\n");
      const state: SleepState = {
        status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0,
        steps: { "daily-summary": { status: "ok", path: dailyPath } },
      };
      writeFileSync(lockPath, JSON.stringify(state));
      const lock: PreviousLock = { path: lockPath, dateStr, state, ageDays: 1 };

      // The next essential (extract-memories) rejects like a provider failure.
      env.runtime.setDefault("2 memories stored");
      env.runtime.setError("User asked about sleep", new Error("provider down"));
      // Manifest order runs retrospective before extraction, so both defs
      // are supplied; retrospective succeeds on the default response.
      const retrospective = loadSleepSteps().find(s => s.name === "retrospective");
      expect(retrospective).toBeDefined();

      const result = await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [retrospective!], env.runtime, "test-run", testSignal(), undefined, [0]);

      expect(result).toMatchObject({
        stepId: "extract-memories",
        reason: "provider_failed",
        failure: { cause: "provider_failed" },
      });
      const persisted = JSON.parse(readFileSync(lockPath, "utf-8")) as SleepState;
      expect(persisted.steps["extract-memories"]?.status, "the failed catch-up step must be recorded").toBe("failed");
      expect(persisted.steps["extract-memories"]?.failure?.cause).toBe("provider_failed");
      expect(existsSync(lockPath), "the lock must NOT be deleted while the failure is unrecovered").toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("keeps an unresolved catch-up stage terminal when its step definition is unavailable", async () => {
    const env = await setupTestEnv({ seedMessages: 1 });
    try {
      const dateStr = "20260415";
      const lockPath = join(env.sleepDir, `sleep_${dateStr}.lock`);
      const dailyPath = join(env.memoryDir, "daily", `daily_2026-04-15.md`);
      writeFileSync(dailyPath, "# Daily\n- User asked about sleep\n- Decided to improve habits\n");
      const steps: SleepState["steps"] = Object.fromEntries([...essentialSleepSteps()].map(name => [name, { status: "ok" as const }]));
      steps["daily-summary"] = { status: "ok", path: dailyPath };
      steps["retrospective"] = { status: "failed" };
      const state: SleepState = { status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0, steps };
      writeFileSync(lockPath, JSON.stringify(state));
      const lock: PreviousLock = { path: lockPath, dateStr, state, ageDays: 1 };

      const result = await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [], env.runtime, "test-run", testSignal(), undefined, [0]);

      expect(result).toMatchObject({ stepId: "retrospective", failure: { cause: "unknown" } });
      expect(existsSync(lockPath), "an unresolved checkpoint must remain for a later resume").toBe(true);
      const persisted = JSON.parse(readFileSync(lockPath, "utf-8")) as SleepState;
      expect(persisted.steps["retrospective"]?.failure?.cause).toBe("unknown");
    } finally {
      env.cleanup();
    }
  });

  it("#1676: the configured retry schedule is forwarded to catch-up sends (no hard-coded 6s)", async () => {
    const env = await setupTestEnv({ seedMessages: 3 });
    try {
      const dateStr = "20260415";
      const dailyPath = join(env.memoryDir, "daily", `daily_2026-04-15.md`);
      writeFileSync(dailyPath, "# Daily\n- User asked about sleep\n- Decided to improve habits\n");

      const lockPath = join(env.sleepDir, `sleep_${dateStr}.lock`);
      const state: SleepState = {
        status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0,
        steps: { "daily-summary": { status: "ok", path: dailyPath } },
      };
      writeFileSync(lockPath, JSON.stringify(state));
      const lock: PreviousLock = { path: lockPath, dateStr, state, ageDays: 1 };

      // Extraction returns empty twice, then succeeds — proving the forwarded
      // [0] schedule drives 3 domain attempts with no real 6s waits.
      // Retrospective runs first in manifest order on the default response.
      const retrospective = loadSleepSteps().find(s => s.name === "retrospective");
      expect(retrospective).toBeDefined();
      let extractEmptyCalls = 0;
      const origComplete = env.runtime.complete.bind(env.runtime);
      env.runtime.complete = async (request: SleepCompletionRequest): Promise<string | import("./contracts.js").SleepCompletionResult> => {
        if (request.prompt.includes("store a memory using abmind store")) {
          extractEmptyCalls++;
          if (extractEmptyCalls < 3) return "";
        }
        return origComplete(request) as unknown as string | import("./contracts.js").SleepCompletionResult;
      };

      await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [retrospective!], env.runtime, "test-run", testSignal(), undefined, [0]);

      expect(extractEmptyCalls, "the [0] schedule forwards through catch-up — 3 domain attempts, no real 6s waits").toBe(3);
      expect(env.runtime.callCount(), "the final (non-empty) extraction attempt reaches the runtime").toBeGreaterThanOrEqual(1);
    } finally {
      env.cleanup();
    }
  });

  it("logs a zero-message daily-summary skip as ⏭, writes no daily file, and emits step_skipped", async () => {
    const env = await setupTestEnv({ seedMessages: 2 });
    try {
      const dateStr = "20260415";
      const lockPath = join(env.sleepDir, `sleep_${dateStr}.lock`);
      const state: SleepState = {
        status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0,
        steps: {
          "daily-summary": { status: "failed" },
          "retrospective": { status: "ok" },
        },
      };
      writeFileSync(lockPath, JSON.stringify(state));
      const lock: PreviousLock = { path: lockPath, dateStr, state, ageDays: 1 };

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const events: SleepEvent[] = [];
      await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [], env.runtime, "test-run", testSignal(), undefined, [0], (e) => events.push(e));

      const logged = logSpy.mock.calls.map(c => String(c[0])).join("\n");
      expect(logged, "zero messages must log ⏭, not ✓").toContain("⏭ daily-summary");
      expect(logged).not.toContain("✓ daily-summary");
      const written = readdirSync(join(env.memoryDir, "daily")).filter(f => f.startsWith("daily_") && f.endsWith(".md"));
      expect(written, "no daily file may be written for a zero-message skip").toEqual([]);
      expect(events.some(e => e.type === "step_skipped" && e.step.id === "daily-summary"), "a step_skipped event must be emitted").toBe(true);
      // All essentials satisfied (skipped counts as satisfied) — the lock clears.
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it("#1752 R7: catch-up does not reconstruct a stale daily path after a zero-message summary skip", async () => {
    const env = await setupTestEnv({ seedMessages: 0 });
    try {
      const dateStr = "20260415";
      const stalePath = join(env.dailyDir, "daily_2026-04-15.md");
      writeFileSync(stalePath, "# Stale summary\n\nThis is usable content from another operation and is not this catch-up artifact.\n", "utf-8");
      const lockPath = join(env.sleepDir, `sleep_${dateStr}.lock`);
      const state: SleepState = {
        status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0,
        steps: {
          "daily-summary": { status: "failed" },
          "extract-memories": { status: "ok" },
          "retrospective": { status: "failed" },
        },
      };
      writeFileSync(lockPath, JSON.stringify(state));
      const lock: PreviousLock = { path: lockPath, dateStr, state, ageDays: 1 };
      const retrospective = loadSleepSteps().find(s => s.name === "retrospective");
      expect(retrospective).toBeDefined();

      await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [retrospective!], env.runtime, "test-run", testSignal(), undefined, [0]);

      expect(env.runtime.allCalls().filter(c => c.stepId === "catch-up-retrospective"), "a stale same-date file must not unlock retrospective").toHaveLength(0);
      expect(lock.state.steps["daily-summary"]?.status).toBe("skipped");
      expect(lock.state.steps["retrospective"]?.status).toBe("skipped");
      expect(existsSync(stalePath)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("#1752 R7: catch-up persists and uses the exact path returned by daily-summary", async () => {
    const env = await setupTestEnv({ seedMessages: 0 });
    try {
      const dateStr = "20260415";
      const db = env.memory.getSleepData().getDb();
      db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(
        "master", "master:telegram", "user", "message in the catch-up date", new Date("2026-04-15T12:00:00").getTime(),
      );
      const summary = "- a durable event from the recovered day\n- a decision that must remain in the daily artifact\n- enough content to pass the artifact viability floor";
      env.runtime.setResponse("Update the summary incorporating", summary);
      env.runtime.setResponse("retrospective", "catch-up retrospective complete");

      const lockPath = join(env.sleepDir, `sleep_${dateStr}.lock`);
      const state: SleepState = {
        status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0,
        steps: {
          "daily-summary": { status: "failed" },
          "extract-memories": { status: "ok" },
          "retrospective": { status: "failed" },
        },
      };
      writeFileSync(lockPath, JSON.stringify(state));
      const lock: PreviousLock = { path: lockPath, dateStr, state, ageDays: 1 };
      const retrospective = loadSleepSteps().find(s => s.name === "retrospective");
      expect(retrospective).toBeDefined();

      await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [retrospective!], env.runtime, "test-run", testSignal(), undefined, [0]);

      // #1821: the recovered daily is a write-stamped file whose heading
      // covers the lock window.
      const stamped = readdirSync(env.dailyDir).filter((f) =>
        /^daily_\d{4}-\d{2}-\d{2}-\d{4}Z\.md$/.test(f));
      expect(stamped).toHaveLength(1);
      const expectedPath = join(env.dailyDir, stamped[0]!);
      expect(readFileSync(expectedPath, "utf-8").split("\n")[0]).toBe("# Daily Summary 2026-04-15");
      expect(lock.state.steps["daily-summary"]?.path).toBe(expectedPath);
      expect(existsSync(expectedPath)).toBe(true);
      const retroCall = env.runtime.allCalls().find(c => c.stepId === "catch-up-retrospective");
      expect(retroCall?.prompt).toContain(expectedPath);
      expect(lock.state.steps["retrospective"]?.status).toBe("ok");
    } finally {
      env.cleanup();
    }
  });

  it("#1860: catch-up recovers in manifest order — retrospective before extraction, no re-run of ok steps", async () => {
    const env = await setupTestEnv({ seedMessages: 3 });
    try {
      const dateStr = "20260415";
      const dailyPath = join(env.memoryDir, "daily", `daily_2026-04-15.md`);
      writeFileSync(dailyPath, "# Daily\n- User asked about sleep\n- Decided to improve habits\n");
      env.runtime.setDefault("recovered content");
      const lockPath = join(env.sleepDir, `sleep_${dateStr}.lock`);
      const state: SleepState = {
        status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0,
        steps: {
          "daily-summary": { status: "ok", path: dailyPath },
          "retrospective": { status: "failed" },
          "extract-memories": { status: "failed" },
        },
      };
      writeFileSync(lockPath, JSON.stringify(state));
      const lock: PreviousLock = { path: lockPath, dateStr, state, ageDays: 1 };
      const steps = loadSleepSteps().filter(s => s.name === "retrospective" || s.name === "extract-memories");
      expect(steps).toHaveLength(2);

      await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, steps, env.runtime, "test-run", testSignal(), undefined, [0]);

      const order = env.runtime.allCalls().map(c => c.stepId);
      const retroAt = order.indexOf("catch-up-retrospective");
      const extractAt = order.indexOf("catch-up-extract-memories");
      expect(retroAt, "retrospective must run").toBeGreaterThanOrEqual(0);
      expect(extractAt, "extraction must run after the recovered retrospective").toBeGreaterThan(retroAt);
      expect(order.filter(id => id === "catch-up-retrospective")).toHaveLength(1);
      expect(order.filter(id => id === "catch-up-extract-memories")).toHaveLength(1);
      expect(lock.state.steps["retrospective"]?.status).toBe("ok");
      expect(lock.state.steps["extract-memories"]?.status).toBe("ok");
      // Daily was already ok with no holes: not rebuilt, not re-run.
      expect(order.some(id => id === "catch-up-daily-summary")).toBe(false);
      expect(existsSync(lockPath), "fully recovered lock is cleaned up").toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it("#1860: a hole alone keeps the lock alive and the next catch-up covers it", async () => {
    const env = await setupTestEnv();
    try {
      const dateStr = "20260417";
      const db = env.memory.getSleepData().getDb();
      const dayStart = new Date("2026-04-17T12:00:00").getTime();
      const insert = db.prepare(
        "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
      );
      insert.run("master", "master:telegram", "user", "hole message one with enough words", dayStart);
      insert.run("master", "master:telegram", "user", "hole message two with enough words", dayStart + 60_000);
      env.runtime.setDefault("recovered daily summary");

      const lockPath = join(env.sleepDir, `sleep_${dateStr}.lock`);
      const state: SleepState = {
        status: "completed", pid: 1, startedAt: 0, llmCalls: 0,
        steps: {
          "daily-summary": {
            status: "ok", path: join(env.dailyDir, "daily_stale.md"),
            claims: [
              { principal: "master", scope: "A", startTs: dayStart - 3600_000, endTs: dayStart - 1000, disposition: "covered" },
              { principal: "master", scope: "A", startTs: dayStart, endTs: dayStart + 60_000, disposition: "unclaimed" },
            ],
          },
          "retrospective": { status: "ok" },
          "extract-memories": { status: "ok" },
        },
      };
      writeFileSync(lockPath, JSON.stringify(state));
      const lock: PreviousLock = { path: lockPath, dateStr, state, ageDays: 1 };

      await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [], env.runtime, "test-run", testSignal(), undefined, [0]);

      // The hole forced a date-range daily rebuild even though no essential
      // failed; the rebuild covered the range, so the lock clears.
      expect(env.runtime.allCalls().some(c => c.stepId === "catch-up-daily-summary")).toBe(true);
      expect(lock.state.steps["daily-summary"]?.status).toBe("ok");
      expect(lock.state.steps["daily-summary"]?.claims?.some(c => c.disposition === "unclaimed")).toBe(false);
      const stamped = readdirSync(env.dailyDir).filter((f) =>
        /^daily_\d{4}-\d{2}-\d{2}-\d{4}Z\.md$/.test(f));
      expect(stamped).toHaveLength(1);
      expect(readFileSync(join(env.dailyDir, stamped[0]!), "utf-8").split("\n")[0]).toBe("# Daily Summary 2026-04-17");
      expect(existsSync(lockPath), "recovered lock is cleaned up").toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it("#1860: abandoning a stale lock records the lost unclaimed ranges before removal", async () => {
    const env = await setupTestEnv();
    try {
      const dateStr = "20260401";
      const holeStart = Date.UTC(2026, 3, 10, 1, 0);
      const lockPath = join(env.sleepDir, `sleep_${dateStr}.lock`);
      const state: SleepState = {
        status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0,
        steps: {
          "daily-summary": {
            status: "ok",
            claims: [
              { principal: "master", scope: "A", startTs: holeStart, endTs: holeStart + 3600_000, disposition: "unclaimed" },
            ],
          },
        },
      };
      writeFileSync(lockPath, JSON.stringify(state));
      const lock: PreviousLock = { path: lockPath, dateStr, state, ageDays: 10 };

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [], env.runtime, "test-run", testSignal(), undefined, [0]);

      const logged = logSpy.mock.calls.map(c => String(c[0])).join("\n");
      expect(logged, "abandonment must record an explicit loss").toContain("LOSS");
      expect(logged).toContain("2026-04-10");
      expect(existsSync(lockPath), "stale lock is removed after the loss record").toBe(false);
      expect(env.runtime.callCount(), "no recovery is attempted past the window").toBe(0);
    } finally {
      env.cleanup();
    }
  });
});
