/**
 * Unit tests for sleep/llm-budget.ts — LlmBudget and sendWithRetry (#1229).
 *
 * Tests the three key scenarios from the spec:
 *   1. Budget exhaustion — sendWithRetry returns null when budget exhausted
 *   2. Retry success — empty responses retry and succeed on a later attempt
 *   3. Transport retry exhaustion — throws ModelUnavailableError after retry window
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmBudget, sendWithRetry, ModelUnavailableError, MAX_RETRIES } from "./llm-budget.js";
import { writeStateFile } from "./state.js";
import type { SleepState } from "./state.js";
import type { SleepRuntime } from "./runtime.js";
import { _resetAbmindEnv } from "../env-schema.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "abmind-budget-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeState(llmCalls = 0): SleepState {
  return { status: "ongoing", pid: 1, startedAt: 0, llmCalls, steps: {} };
}

function makeRuntime(respond: () => Promise<string>): SleepRuntime {
  return { complete: respond };
}

// ── LlmBudget ────────────────────────────────────────────────────────────────

describe("LlmBudget", () => {
  it("consume() returns true while under the cap", async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const state = makeState(0);
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);

      // Use default cap (18) — just verify that 3 calls under the cap all return true
      const budget = new LlmBudget(state, lockPath);
      expect(budget.consume()).toBe(true); // 1
      expect(budget.consume()).toBe(true); // 2
      expect(budget.consume()).toBe(true); // 3
      expect(budget.exhausted).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("consume() returns false and sets exhausted when cap exceeded", async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      process.env["SLEEP_MAX_LLM_CALLS"] = "2";
      _resetAbmindEnv();
      const state = makeState(0);
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);
      const budget = new LlmBudget(state, lockPath);
      budget.consume(); // 1
      budget.consume(); // 2
      const result = budget.consume(); // 3 — exceeds cap of 2
      expect(result).toBe(false);
      expect(budget.exhausted).toBe(true);
    } finally {
      delete process.env["SLEEP_MAX_LLM_CALLS"];
      _resetAbmindEnv();
      cleanup();
    }
  });

  it("pre-exhausted budget causes sendWithRetry to return null immediately (no LLM call)", async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      process.env["SLEEP_MAX_LLM_CALLS"] = "0";
      _resetAbmindEnv();
      const state = makeState(0);
      const lockPath = join(dir, "test.lock");
      writeStateFile(lockPath, state);
      const budget = new LlmBudget(state, lockPath);
      // Exhaust: llmCalls becomes 1 > cap 0 → exhausted = true
      budget.consume();
      expect(budget.exhausted).toBe(true);

      let called = false;
      const runtime = makeRuntime(async () => { called = true; return "response"; });
      const result = await sendWithRetry(runtime, "prompt", "test-step", false, budget, 0, () => 0, 0);
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

// ── sendWithRetry ────────────────────────────────────────────────────────────

describe("sendWithRetry — empty response retry", () => {
  it("retries on empty response and returns success on second attempt", async () => {
    let attempt = 0;
    const runtime = makeRuntime(async () => {
      attempt++;
      return attempt < 2 ? "" : "good response";
    });

    const result = await sendWithRetry(runtime, "prompt", "step", false, undefined, 0);
    expect(result).toBe("good response");
    expect(attempt).toBe(2);
  });

  it(`gives up after ${MAX_RETRIES} empty responses and returns null`, async () => {
    const runtime = makeRuntime(async () => "");
    const result = await sendWithRetry(runtime, "prompt", "step", false, undefined, 0);
    expect(result).toBeNull();
  });

  it("returns null if runtime returns whitespace-only", async () => {
    const runtime = makeRuntime(async () => "   \n  ");
    const result = await sendWithRetry(runtime, "prompt", "step", false, undefined, 0);
    expect(result).toBeNull();
  });
});

describe("sendWithRetry — transport failure / ModelUnavailableError", () => {
  it("throws ModelUnavailableError when transport fails and retry window is exhausted", async () => {
    const runtime = makeRuntime(async () => { throw new Error("connection refused"); });
    await expect(
      sendWithRetry(
        runtime, "prompt", "step", false,
        undefined,
        0,           // retryDelayMs
        () => 0,     // transportBackoffMs — no delay
        0,           // transportRetryWindowMs — deadline is immediate
      ),
    ).rejects.toThrow(ModelUnavailableError);
  });

  it("succeeds on a later attempt if transport recovers before window expires", async () => {
    let transportAttempts = 0;
    const runtime = makeRuntime(async () => {
      transportAttempts++;
      if (transportAttempts < 3) throw new Error("transport fail");
      return "recovered";
    });

    const result = await sendWithRetry(
      runtime, "prompt", "step", false,
      undefined,
      0,           // retryDelayMs
      () => 0,     // transportBackoffMs — no delay
      99_999_999,  // large window — give it time
    );
    expect(result).toBe("recovered");
    expect(transportAttempts).toBe(3);
  });

  it("ModelUnavailableError is instance of Error", async () => {
    const err = new ModelUnavailableError("test-step");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ModelUnavailableError");
    expect(err.message).toContain("test-step");
  });
});
