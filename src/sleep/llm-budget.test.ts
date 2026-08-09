/**
 * Unit tests for sleep/llm-budget.ts — LlmBudget and sendToRuntime (#1353, #1611).
 *
 * Tests the key scenarios:
 *   1. Budget exhaustion — sendToRuntime returns null when budget exhausted
 *   2. Domain retry — empty responses retry under the SAME absolute deadline
 *   3. Transport rejection — surfaces immediately as a typed terminal
 *      SleepModelFailureError, no abmind-side backoff/retry window
 *   4. #1611 — one absolute deadline per logical step: retries reuse it,
 *      cleanup-headroom refuses new calls, and terminal reasons classify
 *      provider_failed / provider_timeout / step_deadline / invalid_response.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmBudget, sendToRuntime, TransportUnavailableError, SleepModelFailureError, isSleepModelFailure, MAX_DOMAIN_RETRIES } from "./llm-budget.js";
import { SleepCompletionDeadlineError } from "../sleep-service/runtime-broker.js";
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
      expect(budget.consume()).toBe(true);
      expect(budget.consume()).toBe(true);
      expect(budget.consume()).toBe(true);
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
      budget.consume();
      budget.consume();
      const result = budget.consume();
      expect(result).toBe(false);
      expect(budget.exhausted).toBe(true);
    } finally {
      delete process.env["SLEEP_MAX_LLM_CALLS"];
      _resetAbmindEnv();
      cleanup();
    }
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
      budget.consume();
      expect(budget.exhausted).toBe(true);

      let called = false;
      const runtime = makeRuntime(async () => { called = true; return "response"; });
      const result = await sendToRuntime(runtime, "prompt", "test-step", testRunId, testSignal(), GENEROUS_DEADLINE, budget, 0);
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
    await sendToRuntime(runtime, "hello", "my-step", "run-123", signal, GENEROUS_DEADLINE, undefined, 0);
    expect(received).not.toBeNull();
    expect(received!.prompt).toBe("hello");
    expect(received!.stepId).toBe("my-step");
    expect(received!.runId).toBe("run-123");
    expect(received!.signal).toBe(signal);
    expect(received!.deadlineAt).toBe(GENEROUS_DEADLINE);
  });

  it("returns null immediately when the signal is already aborted", async () => {
    let called = false;
    const runtime = makeRuntime(async () => { called = true; return "ok"; });
    const controller = new AbortController();
    controller.abort();
    const result = await sendToRuntime(runtime, "prompt", "step", testRunId, controller.signal, GENEROUS_DEADLINE, undefined, 0);
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

    const result = await sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), deadlineAt, undefined, 0);
    expect(result).toBe("good response");
    expect(attempt).toBe(2);
  });

  it(`gives up after ${MAX_DOMAIN_RETRIES} empty responses with the terminal invalid_response reason`, async () => {
    const runtime = makeRuntime(async () => "");
    await expect(
      sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, 0),
    ).rejects.toMatchObject({ reason: "invalid_response", stepId: "step" });
  });

  it("returns null if the signal aborts between domain retries", async () => {
    const controller = new AbortController();
    const runtime = makeRuntime(async () => { controller.abort(); return ""; });
    const result = await sendToRuntime(runtime, "prompt", "step", testRunId, controller.signal, GENEROUS_DEADLINE, undefined, 0);
    expect(result).toBeNull();
  });

  it("#1611: every retry carries the SAME absolute deadline — the clock never restarts", async () => {
    const received: Array<number | undefined> = [];
    let attempt = 0;
    const deadlineAt = Date.now() + 3600_000;
    const runtime = makeRuntime(async (req) => {
      received.push(req.deadlineAt);
      attempt++;
      return attempt < 2 ? "" : "ok";
    });
    const result = await sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), deadlineAt, undefined, 0);
    expect(result).toBe("ok");
    expect(received).toEqual([deadlineAt, deadlineAt]);
  });
});

describe("sendToRuntime — transport rejection (#1353)", () => {
  it("surfaces a rejection immediately as TransportUnavailableError — no abmind-side backoff/retry", async () => {
    let calls = 0;
    const runtime = makeRuntime(async () => { calls++; throw new Error("connection refused"); });
    await expect(
      sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, 0),
    ).rejects.toThrow(TransportUnavailableError);
    expect(calls, "abmind must not retry a transport rejection itself").toBe(1);
  });

  it("a transport rejection is a terminal model failure classified as provider_failed", async () => {
    const runtime = makeRuntime(async () => { throw new Error("boom"); });
    try {
      await sendToRuntime(runtime, "prompt", "test-step", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, 0);
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
      sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, 0),
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
      await expect(sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, budget, 0)).rejects.toThrow(TransportUnavailableError);
      expect(budget.calls).toBe(0);
    } finally { cleanup(); }
  });
});

describe("sendToRuntime — #1611 one deadline per logical step", () => {
  it("refuses to start a call once cleanup headroom has begun — step_deadline without touching the host", async () => {
    let clock = 0;
    const runtime = makeRuntime(async () => { throw new Error("must not be called"); });
    // Deadline 10s from the fake clock start: the first check sees 10s left
    // and refuses (10s < 30s headroom).
    await expect(
      sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), 10_000, undefined, 0, () => clock),
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
        sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, budget, 0),
      ).rejects.toMatchObject({ reason: "step_deadline" });
      expect(budget.calls, "real model time was spent — the budget must be consumed").toBe(1);
    } finally { cleanup(); }
  });

  it("a deadline rejection is NOT surfaced as TransportUnavailableError", async () => {
    const runtime = makeRuntime(async () => { throw new SleepCompletionDeadlineError("comp-1", "step"); });
    await expect(
      sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, 0),
    ).rejects.toMatchObject({ reason: "step_deadline" });
  });

  it("a generic rejection still throws TransportUnavailableError (#1279 unchanged)", async () => {
    const runtime = makeRuntime(async () => { throw new Error("connection lost"); });
    await expect(sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), GENEROUS_DEADLINE, undefined, 0)).rejects.toThrow(TransportUnavailableError);
  });
});
