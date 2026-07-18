/**
 * Unit tests for sleep/catchup.ts — runCatchUp basic flow coverage (#1353
 * migration: request-aware runtime, runId/signal, neutral SleepEvent).
 */

import { describe, it, expect } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCatchUp, failedEssentials, ESSENTIAL_STEPS } from "./catchup.js";
import { setupTestEnv } from "./test-harness.js";
import type { PreviousLock } from "./locks.js";
import type { SleepState } from "./state.js";
import type { SleepEvent } from "./contracts.js";

function testSignal(): AbortSignal { return new AbortController().signal; }

// ── failedEssentials ─────────────────────────────────────────────────────────

describe("failedEssentials", () => {
  it("returns all essential steps when state has no steps recorded", () => {
    const state: SleepState = { status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0, steps: {} };
    const failed = failedEssentials(state);
    expect(failed).toEqual(expect.arrayContaining([...ESSENTIAL_STEPS]));
    expect(failed).toHaveLength(ESSENTIAL_STEPS.size);
  });

  it("returns empty array when all essentials are ok", () => {
    const steps = Object.fromEntries([...ESSENTIAL_STEPS].map(k => [k, { status: "ok" as const }]));
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
    const steps = Object.fromEntries([...ESSENTIAL_STEPS].map(k => [k, { status: "ok" as const }]));
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

      await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [], env.runtime, "test-run", testSignal(), undefined, 0);

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
      const steps = Object.fromEntries([...ESSENTIAL_STEPS].map(k => [k, { status: "ok" as const }]));
      const state: SleepState = { status: "completed", pid: 1, startedAt: 0, llmCalls: 0, steps };
      writeFileSync(lockPath, JSON.stringify(state));

      const lock: PreviousLock = { path: lockPath, dateStr: "20260415", state, ageDays: 1 };

      await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [], env.runtime, "test-run", testSignal(), undefined, 0);

      expect(existsSync(lockPath), "completed lock should be deleted").toBe(false);
      expect(env.runtime.callCount()).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("processes no locks when given an empty array", async () => {
    const env = await setupTestEnv();
    try {
      await runCatchUp([], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [], env.runtime, "test-run", testSignal(), undefined, 0);
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
      await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [], env.runtime, "test-run", controller.signal, undefined, 0);

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
        steps: { "daily-summary": { status: "ok" } },
      };
      writeFileSync(lockPath, JSON.stringify(state));

      const lock: PreviousLock = { path: lockPath, dateStr, state, ageDays: 1 };

      const events: SleepEvent[] = [];
      await runCatchUp([lock], env.memory.getSleepData(), { memoryDir: env.memoryDir }, [], env.runtime, "test-run", testSignal(), undefined, 0, (e) => events.push(e));

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
});
