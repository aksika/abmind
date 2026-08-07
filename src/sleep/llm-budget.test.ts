/**
 * Unit tests for sleep/llm-budget.ts — LlmBudget and sendToRuntime (#1353).
 *
 * Tests the key scenarios:
 *   1. Budget exhaustion — sendToRuntime returns null when budget exhausted
 *   2. Domain retry — empty responses retry and succeed on a later attempt
 *   3. Transport rejection — surfaces immediately as TransportUnavailableError,
 *      no abmind-side backoff/retry window (moved to the host per #1353).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmBudget, sendToRuntime, TransportUnavailableError, MAX_DOMAIN_RETRIES } from "./llm-budget.js";
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
      const result = await sendToRuntime(runtime, "prompt", "test-step", testRunId, testSignal(), budget, 0);
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
  it("passes prompt/stepId/runId/signal through to the runtime", async () => {
    let received: SleepCompletionRequest | null = null;
    const runtime = makeRuntime(async (req) => { received = req; return "ok"; });
    const signal = testSignal();
    await sendToRuntime(runtime, "hello", "my-step", "run-123", signal, undefined, 0);
    expect(received).not.toBeNull();
    expect(received!.prompt).toBe("hello");
    expect(received!.stepId).toBe("my-step");
    expect(received!.runId).toBe("run-123");
    expect(received!.signal).toBe(signal);
  });

  it("returns null immediately when the signal is already aborted", async () => {
    let called = false;
    const runtime = makeRuntime(async () => { called = true; return "ok"; });
    const controller = new AbortController();
    controller.abort();
    const result = await sendToRuntime(runtime, "prompt", "step", testRunId, controller.signal, undefined, 0);
    expect(result).toBeNull();
    expect(called).toBe(false);
  });
});

describe("sendToRuntime — domain retry (empty response)", () => {
  it("retries on empty response and returns success on a later attempt", async () => {
    let attempt = 0;
    const runtime = makeRuntime(async () => {
      attempt++;
      return attempt < 2 ? "" : "good response";
    });

    const result = await sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), undefined, 0);
    expect(result).toBe("good response");
    expect(attempt).toBe(2);
  });

  it(`gives up after ${MAX_DOMAIN_RETRIES} empty responses and returns null`, async () => {
    const runtime = makeRuntime(async () => "");
    const result = await sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), undefined, 0);
    expect(result).toBeNull();
  });

  it("returns null if runtime returns whitespace-only", async () => {
    const runtime = makeRuntime(async () => "   \n  ");
    const result = await sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), undefined, 0);
    expect(result).toBeNull();
  });
});

describe("sendToRuntime — transport rejection (#1353)", () => {
  it("surfaces a rejection immediately as TransportUnavailableError — no abmind-side backoff/retry", async () => {
    let calls = 0;
    const runtime = makeRuntime(async () => { calls++; throw new Error("connection refused"); });
    await expect(
      sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), undefined, 0),
    ).rejects.toThrow(TransportUnavailableError);
    expect(calls, "abmind must not retry a transport rejection itself").toBe(1);
  });

  it("TransportUnavailableError is instance of Error and names the step", async () => {
    const runtime = makeRuntime(async () => { throw new Error("boom"); });
    try {
      await sendToRuntime(runtime, "prompt", "test-step", testRunId, testSignal(), undefined, 0);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(TransportUnavailableError);
      expect((err as Error).name).toBe("TransportUnavailableError");
      expect((err as Error).message).toContain("test-step");
    }
  });

  it("does not consume budget on a transport rejection (no tokens used)", async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const state = makeState(0);
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);
      const budget = new LlmBudget(state, lockPath);
      const runtime = makeRuntime(async () => { throw new Error("down"); });
      await expect(sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), budget, 0)).rejects.toThrow(TransportUnavailableError);
      expect(budget.calls).toBe(0);
    } finally { cleanup(); }
  });
});

describe("sendToRuntime — completion deadline classification (#1603)", () => {
  it("a SleepCompletionDeadlineError fails the step (returns null) instead of stopping the cycle", async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const state = makeState(0);
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);
      const budget = new LlmBudget(state, lockPath);
      const runtime = makeRuntime(async () => { throw new SleepCompletionDeadlineError("comp-1", "step"); });
      const result = await sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), budget, 0);
      expect(result).toBeNull();
      expect(budget.calls, "real model time was spent — the budget must be consumed").toBe(1);
    } finally { cleanup(); }
  });

  it("a deadline rejection is NOT surfaced as TransportUnavailableError", async () => {
    const runtime = makeRuntime(async () => { throw new SleepCompletionDeadlineError("comp-1", "step"); });
    const result = await sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), undefined, 0);
    expect(result).toBeNull();
  });

  it("a generic rejection still throws TransportUnavailableError (#1279 unchanged)", async () => {
    const runtime = makeRuntime(async () => { throw new Error("connection lost"); });
    await expect(sendToRuntime(runtime, "prompt", "step", testRunId, testSignal(), undefined, 0)).rejects.toThrow(TransportUnavailableError);
  });
});
