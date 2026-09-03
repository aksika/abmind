/**
 * Unit tests for sleep/llm-budget.ts — LlmBudget and sendToRuntime (#1353, #1611, #1676).
 *
 * Tests the key scenarios:
 *   1. Budget exhaustion — sendToRuntime returns null when budget exhausted
 *   2. Domain retry — empty responses retry under a refreshed per-attempt
 *      window (#1676), not one immutable logical-step deadline
 *   3. Transport rejection — surfaces immediately as a typed terminal
 *      SleepModelFailureError, no abmind-side backoff/retry window
 *   4. #1611/#1676 — per-attempt deadline windows, cleanup-headroom refusal,
 *      retry schedule (6s / 15min) with clamping, and cancellation-aware
 *      waiting; terminal reasons classify provider_failed / provider_timeout /
 *      step_deadline / invalid_response.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmBudget, sendToRuntime, TransportUnavailableError, SleepModelFailureError, isSleepModelFailure, MAX_DOMAIN_RETRIES, DEFAULT_RETRY_DELAYS } from "./llm-budget.js";
import { SleepCompletionDeadlineError, RuntimeCompletionAdmissionError } from "../sleep-service/runtime-broker.js";
import { writeStateFile } from "./state.js";
import type { SleepState } from "./state.js";
import type { SleepRuntime, SleepCompletionRequest } from "./contracts.js";
import { _resetAbmindEnv } from "../env-schema.js";

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "abmind-budget-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeState(llmCalls = 0): SleepState {
  return { status: "ongoing", pid: 1, startedAt: 0, llmCalls, steps: {} };
}

function makeRuntime(respond: (req: SleepCompletionRequest) => Promise<string>): SleepRuntime {
  return { complete: respond };
}

const testRunId = "test-run";
function testSignal(): AbortSignal { return new AbortController().signal; }

/** #1611: a far-future deadline so budget/retry/transport tests never trip the
 *  cleanup-headroom gate. */
const GENEROUS_DEADLINE = Date.now() + 3600_000;

describe("LlmBudget", () => {
  it("consume() returns true while under the cap", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const state = makeState(0);
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);

      const budget = new LlmBudget(state, lockPath);
      expect(budget.consume("daily-summary")).toBe(true);
      expect(budget.consume("daily-summary")).toBe(true);
      expect(budget.consume("retrospective")).toBe(true);
      expect(budget.exhausted).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("consume() returns false and sets exhausted when cap exceeded", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      process.env["SLEEP_MAX_LLM_CALLS"] = "2";
      _resetAbmindEnv();
      const state = makeState(0);
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);
      const budget = new LlmBudget(state, lockPath);
      budget.consume("gc-noise");
      budget.consume("gc-noise");
      const result = budget.consume("gc-noise");
      expect(result).toBe(false);
      expect(budget.exhausted).toBe(true);
    } finally {
      delete process.env["SLEEP_MAX_LLM_CALLS"];
      _resetAbmindEnv();
      cleanup();
    }
  });

  it("#1653: callsFor() attributes each charge to its logical step, run-locally", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const state = makeState(0);
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);
      const budget = new LlmBudget(state, lockPath);

      budget.consume("daily-summary");
      budget.consume("daily-summary");
      budget.consume("extract-memories");
      budget.consume("catch-up-daily-summary");

      expect(budget.callsFor("daily-summary")).toBe(2);
      expect(budget.callsFor("extract-memories")).toBe(1);
      // #1653: catch-up keeps a distinct id — never merged into the current
      // day's step.
      expect(budget.callsFor("catch-up-daily-summary")).toBe(1);
      expect(budget.callsFor("retrospective"), "unused steps report zero").toBe(0);

      // The durable run-level total keeps its existing meaning.
      expect(budget.calls).toBe(4);
      expect(state.llmCalls).toBe(4);
    } finally { cleanup(); }
  });

  it("#1653: callsFor() starts empty for a fresh instance — resume does not inherit prior attribution", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const state = makeState(3); // durable total survived the first attempt
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);
      const budget = new LlmBudget(state, lockPath);
      expect(budget.callsFor("daily-summary"), "a resumed attempt sees no prior per-step calls").toBe(0);
      expect(budget.calls).toBe(3);
    } finally { cleanup(); }
  });

  it("pre-exhausted budget causes sendToRuntime to return null immediately (no LLM call)", async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      process.env["SLEEP_MAX_LLM_CALLS"] = "0";
      _resetAbmindEnv();
      const state = makeState(0);
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);
      const budget = new LlmBudget(state, lockPath);
      budget.consume("gc-noise");
      expect(budget.exhausted).toBe(true);

      let called = false;
      const runtime = makeRuntime(async () => { called = true; return "response"; });
      const result = await sendToRuntime(runtime, "prompt", "test-step", testRunId, testSignal(), GENEROUS_DEADLINE, budget, [0]);
      expect(result).toBeNull();
      expect(called).toBe(false);
    } finally {
      delete process.env["SLEEP_MAX_LLM_CALLS"];
      _resetAbmindEnv();
      cleanup();
    }
  });

  it("calls value reflects actual llmCalls count", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const state = makeState(5);
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);
      const budget = new LlmBudget(state, lockPath);
      expect(budget.calls).toBe(5);
    } finally {
      cleanup();
    }
  });
});

describe("sendToRuntime — request shape", () => {
  it("passes prompt/stepId/runId/signal/deadlineAt through to the runtime", async () => {
    let received: SleepCompletionRequest | null = null;
    const runtime = makeRuntime(async (req) => { received = req; return "ok"; });
    const signal = testSignal();
    await sendToRuntime(runtime, "hello", "my-step", "run-123", signal, GENEROUS_DEADLINE, undefined, [0]);
    expect(received).not.toBeNull();
    expect(received!.prompt).toBe("hello");
    expect(received!.stepId).toBe("my-step");
    expect(received!.runId).toBe("run-123");
    expect(received!.signal).toBe(signal);
    // #1676: the request deadline is refreshed onto the attempt start, so it
    // equals the entry window re-based on `now` — approximately the supplied
    // timestamp, within microsecond clock drift.
    expect(received!.deadlineAt).toBeGreaterThan(GENEROUS_DEADLINE - 5_000);
    expect(received!.deadlineAt).toBeLessThan(GENEROUS_DEADLINE + 5_000);
  });

  it("returns null immediately when the signal is already aborted", async () => {
    let called = false;
    const runtime = makeRuntime(async () => { called = true; return "ok"; });
    const controller = new AbortController();
    controller.abort();
    const result = await sendToRuntime(runtime, "prompt", "step", testRunId, controller.signal, GENEROUS_DEADLINE, undefined, [0]);
    expect(result).toBeNull();
    expect(called).toBe(false);
  });
});

describe("sendToRuntime — domain retry (empty response)", () => {
  it("retries on empty response and returns success on a later attempt", async () => {
    let attempt = 0;
    const deadlineAt = Date.now() + 3600_000;
    const runtime = makeRuntime(async () => {
      attempt++;
      return attempt < 2 ? "" : "good response";
    });

    const result = await sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), deadlineAt, undefined, [0]);
    expect(result).toBe("good response");
    expect(attempt).toBe(2);
  });

  it(`gives up after ${MAX_DOMAIN_RETRIES} empty responses with the terminal invalid_response reason`, async () => {
    const runtime = makeRuntime(async () => "");
    await expect(
      sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, [0]),
    ).rejects.toMatchObject({ reason: "invalid_response", stepId: "step" });
  });

  it("returns null if the signal aborts between domain retries", async () => {
    const controller = new AbortController();
    const runtime = makeRuntime(async () => { controller.abort(); return ""; });
    const result = await sendToRuntime(runtime, "prompt", "step", testRunId, controller.signal, GENEROUS_DEADLINE, undefined, [0]);
    expect(result).toBeNull();
  });

  it("#1676: each attempt gets a refreshed deadline based on the entry window — the clock restarts per attempt", async () => {
    let clock = 1_000_000;
    const windowMs = 300_000;
    const received: number[] = [];
    let attempt = 0;
    const runtime = makeRuntime(async (req) => {
      received.push(req.deadlineAt);
      attempt++;
      // Attempt 1 consumes 290s of its window and returns empty — past the
      // point where the OLD absolute-deadline model (window 300s, headroom 30s)
      // would refuse the retry (only 10s would remain).
      if (attempt === 1) { clock += 290_000; return ""; }
      return "ok";
    });
    const result = await sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), clock + windowMs, undefined, [0], () => clock);
    expect(result).toBe("ok");
    expect(received[0], "first attempt deadline is the entry window onto its start").toBe(1_000_000 + windowMs);
    expect(received[1], "retry deadline is refreshed onto the new attempt start — a full window again").toBe(1_290_000 + windowMs);
    expect(received[1]!).toBeGreaterThan(received[0]!);
  });
});

describe("sendToRuntime — retry schedule and cancellation (#1676)", () => {
  it("waits 30s before attempt 2 and 15min before attempt 3 and 15min before the final attempt (default schedule)", async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const runtime = makeRuntime(async () => {
        attempt++;
        return attempt < 3 ? "" : "ok";
      });
      const promise = sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, DEFAULT_RETRY_DELAYS);
      await vi.advanceTimersByTimeAsync(30_000);   // attempt 1 empty → 30s wait fires → attempt 2
      await vi.advanceTimersByTimeAsync(900_000); // attempt 2 empty → 15min wait fires → attempt 3
      expect(await promise).toBe("ok");
      expect(attempt).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps to the last schedule entry for retries beyond the schedule length", async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const runtime = makeRuntime(async () => {
        attempt++;
        return attempt < 3 ? "" : "ok";
      });
      // schedule [0, 5]: attempt 2 waits 0, attempt 3 waits 5ms (last entry)
      const promise = sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, [0, 5]);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5);
      expect(await promise).toBe("ok");
      expect(attempt).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an empty schedule means no wait between retries", async () => {
    let attempt = 0;
    const runtime = makeRuntime(async () => {
      attempt++;
      return attempt < 3 ? "" : "ok";
    });
    const result = await sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, []);
    expect(result).toBe("ok");
    expect(attempt).toBe(3);
  });

  it("cancellation during a retry wait returns null, makes no further call, and leaves no timer alive", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let calls = 0;
      const runtime = makeRuntime(async () => { calls++; return ""; });
      const promise = sendToRuntime(runtime, "prompt", "step", testRunId, controller.signal, GENEROUS_DEADLINE, undefined, DEFAULT_RETRY_DELAYS);
      await vi.advanceTimersByTimeAsync(30_000);   // attempt 1 empty → 30s wait → attempt 2
      await vi.advanceTimersByTimeAsync(0);       // attempt 2 empty → 15min wait begins
      controller.abort();
      expect(await promise).toBeNull();
      expect(calls, "the aborted wait must not start another provider call").toBe(2);
      // Advancing the (cleared) 15-minute timer must not trigger another call.
      await vi.advanceTimersByTimeAsync(900_000);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sendToRuntime — transport rejection (#1353)", () => {
  it("surfaces a rejection immediately as TransportUnavailableError — no abmind-side backoff/retry", async () => {
    let calls = 0;
    const runtime = makeRuntime(async () => { calls++; throw new Error("connection refused"); });
    await expect(
      sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, [0]),
    ).rejects.toThrow(TransportUnavailableError);
    expect(calls, "abmind must not retry a transport rejection itself").toBe(1);
  });

  it("a transport rejection is a terminal model failure classified as provider_failed", async () => {
    const runtime = makeRuntime(async () => { throw new Error("boom"); });
    try {
      await sendToRuntime(runtime, "prompt", "test-step", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, [0]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SleepModelFailureError);
      expect(isSleepModelFailure(err)).toBe(true);
      expect((err as SleepModelFailureError).reason).toBe("provider_failed");
      expect((err as Error).name).toBe("TransportUnavailableError");
      expect((err as Error).message).toContain("test-step");
    }
  });

  it("#1611: a host-supplied provider_timeout code classifies as provider_timeout", async () => {
    const runtime = makeRuntime(async () => { throw new Error("provider_timeout"); });
    await expect(
      sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, [0]),
    ).rejects.toMatchObject({ reason: "provider_timeout" });
  });

  it("does not consume budget on a transport rejection (no tokens used)", async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const state = makeState(0);
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);
      const budget = new LlmBudget(state, lockPath);
      const runtime = makeRuntime(async () => { throw new Error("down"); });
      await expect(sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, budget, [0])).rejects.toThrow(TransportUnavailableError);
      expect(budget.calls).toBe(0);
    } finally { cleanup(); }
  });
});

describe("sendToRuntime — #1676 per-attempt deadline windows", () => {
  it("refuses to start a call when the attempt window is at or below the cleanup headroom — step_deadline without touching the host", async () => {
    let clock = 0;
    const runtime = makeRuntime(async () => { throw new Error("must not be called"); });
    // Entry window is 10s (deadlineAt=10_000 at fake clock 0): the refreshed
    // per-attempt window is 10s, below the 30s headroom — refuse immediately.
    await expect(
      sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), 10_000, undefined, [0], () => clock),
    ).rejects.toMatchObject({ reason: "step_deadline" });
  });

  it("a SleepCompletionDeadlineError is terminal with reason step_deadline and still charges the budget", async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const state = makeState(0);
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);
      const budget = new LlmBudget(state, lockPath);
      const runtime = makeRuntime(async () => { throw new SleepCompletionDeadlineError("comp-1", "step"); });
      await expect(
        sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, budget, [0]),
      ).rejects.toMatchObject({ reason: "step_deadline" });
      expect(budget.calls, "real model time was spent — the budget must be consumed").toBe(1);
    } finally { cleanup(); }
  });

  it("a deadline rejection is NOT surfaced as TransportUnavailableError", async () => {
    const runtime = makeRuntime(async () => { throw new SleepCompletionDeadlineError("comp-1", "step"); });
    await expect(
      sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, [0]),
    ).rejects.toMatchObject({ reason: "step_deadline" });
  });

  it("a generic rejection still throws TransportUnavailableError (#1279 unchanged)", async () => {
    const runtime = makeRuntime(async () => { throw new Error("connection lost"); });
    await expect(sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, [0])).rejects.toThrow(TransportUnavailableError);
  });
});

describe("sendToRuntime — #1681 admission refusals", () => {
  it("a provider_unavailable refusal surfaces as TransportUnavailableError with the stable code and provider_failed reason", async () => {
    const runtime = makeRuntime(async () => { throw new RuntimeCompletionAdmissionError("provider_unavailable", "extract-memories"); });
    try {
      await sendToRuntime(runtime, "prompt", "extract-memories", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, [0]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransportUnavailableError);
      expect((err as TransportUnavailableError).providerCode).toBe("provider_unavailable");
      expect((err as TransportUnavailableError).reason, "the terminal sleep reason stays provider_failed").toBe("provider_failed");
      expect((err as Error).message).toContain("provider_unavailable");
      expect((err as Error).message).toContain("extract-memories");
    }
  });

  it("a completion_pending refusal also carries its stable code through the wrapper", async () => {
    const runtime = makeRuntime(async () => { throw new RuntimeCompletionAdmissionError("completion_pending", "step-2"); });
    await expect(
      sendToRuntime(runtime, "prompt", "step-2", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, [0]),
    ).rejects.toMatchObject({ reason: "provider_failed", providerCode: "completion_pending" });
  });

  it("an admission refusal consumes no LLM budget — no model call was ever made", async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const state = makeState(0);
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);
      const budget = new LlmBudget(state, lockPath);
      const runtime = makeRuntime(async () => { throw new RuntimeCompletionAdmissionError("provider_unavailable", "step"); });
      await expect(
        sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, budget, [0]),
      ).rejects.toThrow(TransportUnavailableError);
      expect(budget.calls, "a refused admission never reaches the model").toBe(0);
    } finally { cleanup(); }
  });
});

describe("sendToRuntime — #1653 per-step attribution", () => {
  it("charges a successful call to its logical step exactly once", async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const state = makeState(0);
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);
      const budget = new LlmBudget(state, lockPath);
      const runtime = makeRuntime(async () => "good response");

      const result = await sendToRuntime(runtime, "prompt", "extract-memories", testRunId, testSignal(), GENEROUS_DEADLINE, budget, [0]);
      expect(result).toBe("good response");
      expect(budget.callsFor("extract-memories")).toBe(1);
      expect(budget.callsFor("gc-noise")).toBe(0);
      expect(budget.calls, "durable total equals charged attempts").toBe(1);
    } finally { cleanup(); }
  });

  it("charges every empty-domain retry to the same step — once per attempt", async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const state = makeState(0);
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);
      const budget = new LlmBudget(state, lockPath);
      let attempt = 0;
      const runtime = makeRuntime(async () => { attempt++; return attempt < 3 ? "" : "good response"; });

      const result = await sendToRuntime(runtime, "prompt", "retrospective", testRunId, testSignal(), GENEROUS_DEADLINE, budget, [0]);
      expect(result).toBe("good response");
      expect(attempt).toBe(3);
      expect(budget.callsFor("retrospective"), "each model-reaching attempt is charged exactly once").toBe(3);
      expect(budget.calls).toBe(3);
    } finally { cleanup(); }
  });

  it("charges a charged deadline error to the correct step once (#1611 error path)", async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const state = makeState(0);
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);
      const budget = new LlmBudget(state, lockPath);
      const runtime = makeRuntime(async () => { throw new SleepCompletionDeadlineError("comp-1", "step"); });

      await expect(
        sendToRuntime(runtime, "prompt", "daily-summary", testRunId, testSignal(), GENEROUS_DEADLINE, budget, [0]),
      ).rejects.toMatchObject({ reason: "step_deadline" });
      expect(budget.callsFor("daily-summary"), "real model time was spent — attributed to the logical step").toBe(1);
      expect(budget.callsFor("extract-memories")).toBe(0);
      expect(budget.calls).toBe(1);
    } finally { cleanup(); }
  });
});
