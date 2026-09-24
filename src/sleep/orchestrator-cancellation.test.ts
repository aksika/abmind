/**
 * Regression tests for #1840: `runSleepCycle` early exits must not retain the
 * wall-clock cancellation timer or the caller-signal abort listener.
 *
 * Each test drives the real `runSleepCycle` boundary with the shared harness.
 * Only `setTimeout`/`clearTimeout` are faked (Date, fs, and the DB stay real),
 * so `vi.getTimerCount()` counts exactly the timers the cycle arms. The
 * caller-signal listener is observed with `node:events` `getEventListeners`.
 * All three tests fail on the pre-fix code (one leaked timer + one leaked
 * listener on each path) and pass after.
 */

import { describe, it, expect, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getEventListeners } from "node:events";
import { runSleepCycle } from "./orchestrator.js";
import { setupTestEnv, type TestEnv } from "./test-harness.js";
import { getMemoryDb } from "../memory-manager.js";
import type { SleepRunOptions } from "./contracts.js";

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

function abortListenerCount(signal: AbortSignal): number {
  return getEventListeners(signal, "abort").length;
}

describe("#1840 sleep cancellation cleanup on early exits", () => {
  it("no-work return leaves no wall-clock timer and no caller-signal listener", async () => {
    const env = await setupTestEnv({ seedMessages: 0 });
    const caller = new AbortController();
    // Fake only the timer functions; the cycle never advances time, so the
    // wall-clock timeout stays pending unless the cycle clears it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const result = await runSleepCycle(baseOpts(env, { signal: caller.signal }));
      expect(result.status).toBe("no_work");
      expect(result.watermarkAdvanced).toBe(false);
      expect(vi.getTimerCount(), "wall-clock timeout must be cleared on the no-work exit").toBe(0);
      expect(abortListenerCount(caller.signal), "caller abort listener must be removed on the no-work exit").toBe(0);
    } finally {
      vi.useRealTimers();
      env.cleanup();
    }
  });

  it("durable already-running return leaves no wall-clock timer and no caller-signal listener", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    // Live PID in an ongoing lock: the orchestrator must take the durable
    // already-running exit. (The harness preseed uses a dead PID for resume.)
    writeFileSync(join(env.sleepDir, `sleep_${env.todayStr}.lock`), JSON.stringify({
      status: "ongoing",
      pid: process.pid,
      startedAt: env.now - 60_000,
      llmCalls: 0,
      steps: {},
    }));
    const caller = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const result = await runSleepCycle(baseOpts(env, { signal: caller.signal }));
      expect(result.status).toBe("already_running");
      expect(env.runtime.callCount(), "no step work may run on the already-running exit").toBe(0);
      expect(vi.getTimerCount(), "wall-clock timeout must be cleared on the already-running exit").toBe(0);
      expect(abortListenerCount(caller.signal), "caller abort listener must be removed on the already-running exit").toBe(0);
    } finally {
      vi.useRealTimers();
      env.cleanup();
    }
  });

  it("setup failure cleans up cancellation and still releases the in-process guard", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    const savedUserId = process.env["ABMIND_USER_ID"];
    // No manifest.json exists in the temp home, so removing the env identity
    // makes ensurePrimaryUserId() return null and the cycle throw inside the
    // outer try — a setup-region failure before the step loop.
    delete process.env["ABMIND_USER_ID"];
    const caller = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await expect(runSleepCycle(baseOpts(env, { signal: caller.signal })))
        .rejects.toThrow("Primary user identity is not configured");
      expect(vi.getTimerCount(), "wall-clock timeout must be cleared on setup failure").toBe(0);
      expect(abortListenerCount(caller.signal), "caller abort listener must be removed on setup failure").toBe(0);
    } finally {
      if (savedUserId === undefined) delete process.env["ABMIND_USER_ID"];
      else process.env["ABMIND_USER_ID"] = savedUserId;
      vi.useRealTimers();
    }
    // Guard released: with identity restored and messages drained, a
    // follow-up call is admitted (already_running would prove the opposite).
    const db = getMemoryDb(env.memory);
    db?.prepare("DELETE FROM messages").run();
    try {
      const retry = await runSleepCycle(baseOpts(env));
      expect(retry.status).toBe("no_work");
    } finally {
      env.cleanup();
    }
  });
});
