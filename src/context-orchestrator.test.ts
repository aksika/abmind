/**
 * context-orchestrator.test.ts — #1022 compaction hardening:
 * CompactionResult return, telemetry emission, anti-thrash guard, reentrancy.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { ContextOrchestrator } from "./context-orchestrator.js";
import type { ContextEngine } from "./context-engine.js";
import type { CompactionEvent } from "./context-orchestrator.js";

const CHAT = "1_A_01";
const BUDGET = 200_000;
const CHUNK_TOKENS = 1000;

/** A message stub that satisfies what serializeChunk reads. */
const msg = (content: string) => ({ role: "user", content, timestamp: Date.now(), classification: 1 });

/** Fake ContextEngine — only the methods runCompaction/afterResponse touch. */
function makeEngine(persistSummary = vi.fn(), setLastFailed = vi.fn()): ContextEngine {
  return {
    getDb: () => ({}),
    buildContext: () => ({
      summaries: [],
      messages: new Array(20).fill(0).map(() => msg("filler")),
      estimatedTokens: 9_999_999,
      pendingCompaction: true,
    }),
    getCompactionChunk: () => ({
      messages: [msg("hello world")],
      sourceStart: 1,
      sourceEnd: 10,
      classification: 1,
      chunkTokens: CHUNK_TOKENS,
      totalTokens: 5000,
    }),
    getSummaries: () => [],
    persistSummary,
    setLastFailed,
    needsCondensation: () => ({ needed: false, leafIds: [] }),
  } as unknown as ContextEngine;
}

const HEALTHY = "s".repeat(200); //  50 tok  → 95% savings
const LOW = "s".repeat(3800); // 950 tok  → 5% savings (< 10%, not inflation)

const flush = () => new Promise(r => setTimeout(r, 0));

describe("ContextOrchestrator #1022", () => {
  let events: CompactionEvent[];
  beforeEach(() => { events = []; });

  const build = (summarize: (s: string, b: number, p: string) => Promise<string>, opts?: { model?: string | null; sink?: boolean }) =>
    new ContextOrchestrator({
      contextEngine: makeEngine(),
      summarize,
      getLastAssistantTimestamp: () => null,
      compactionModel: opts?.model ?? "cheap-model",
      onCompactionEvent: opts?.sink === false ? undefined : (e) => events.push(e),
    });

  it("returns a CompactionResult and emits one telemetry event on a normal pass", async () => {
    const orch = build(async () => HEALTHY);
    const result = await orch.forceCompact(CHAT, BUDGET);

    expect(result.ok).toBe(true);
    expect(result.level).toBe("normal");
    expect(result.tokensBefore).toBe(CHUNK_TOKENS);
    expect(result.tokensAfter).toBe(50);
    expect(result.savingsPct).toBeCloseTo(0.95, 2);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      conversationId: CHAT,
      tokensBefore: CHUNK_TOKENS,
      tokensAfter: 50,
      model: "cheap-model",
      level: "normal",
    });
    expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("empty summary → fallback level, savingsPct 0, event emitted", async () => {
    const orch = build(async () => "");
    const result = await orch.forceCompact(CHAT, BUDGET);

    expect(result.ok).toBe(true);
    expect(result.level).toBe("fallback");
    expect(result.savingsPct).toBe(0);
    expect(events[0]!.level).toBe("fallback");
  });

  it("standalone abmind: no sink + null model → no throw, identical behavior", async () => {
    const orch = build(async () => HEALTHY, { model: null, sink: false });
    const result = await orch.forceCompact(CHAT, BUDGET);
    expect(result.ok).toBe(true);
    expect(result.level).toBe("normal");
    expect(events).toHaveLength(0); // sink not injected
  });

  it("two sub-10% auto passes → third auto pass is skipped (summarize not called)", async () => {
    const summarize = vi.fn(async () => LOW);
    const orch = build(summarize);

    // Two low-savings passes via the auto path (afterResponse fires runCompaction async).
    await orch.afterResponse(CHAT, BUDGET); await flush();
    await orch.afterResponse(CHAT, BUDGET); await flush();
    expect(summarize).toHaveBeenCalledTimes(2);

    // Third auto pass: anti-thrash tripped → preempted, summarize NOT called again.
    await orch.afterResponse(CHAT, BUDGET); await flush();
    expect(summarize).toHaveBeenCalledTimes(2);
    // A skipped telemetry event was emitted for the preempt.
    expect(events.some(e => e.level === "skipped")).toBe(true);
  });

  it("manual /compact always runs regardless of anti-thrash, and a healthy pass clears + recovers", async () => {
    const summarize = vi.fn()
      .mockResolvedValueOnce(LOW)      // pass 1 (auto)  → fails=1
      .mockResolvedValueOnce(LOW)      // pass 2 (auto)  → fails=2, tripped
      .mockResolvedValueOnce(HEALTHY)  // pass 3 (manual, bypasses check) → clears
      .mockResolvedValue(HEALTHY);     // pass 4 (auto, recovered)
    const orch = build(summarize);

    await orch.afterResponse(CHAT, BUDGET); await flush();
    await orch.afterResponse(CHAT, BUDGET); await flush();
    expect(summarize).toHaveBeenCalledTimes(2); // tripped

    // Manual forceCompact bypasses the anti-thrash CHECK → runs even while tripped.
    const manual = await orch.forceCompact(CHAT, BUDGET);
    expect(manual.ok).toBe(true);
    expect(manual.level).toBe("normal");
    expect(summarize).toHaveBeenCalledTimes(3);

    // The healthy manual pass cleared the counter → next auto pass fires again (recovery).
    await orch.afterResponse(CHAT, BUDGET); await flush();
    expect(summarize).toHaveBeenCalledTimes(4);
  });

  it("reentrancy guard: concurrent forceCompact → second returns skipped, no double summarize", async () => {
    let release!: (v: string) => void;
    const summarize = vi.fn(() => new Promise<string>(r => { release = r; }));
    const orch = build(summarize);

    const p1 = orch.forceCompact(CHAT, BUDGET);
    const p2 = orch.forceCompact(CHAT, BUDGET); // enters while p1 is awaiting summarize
    release(HEALTHY);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(summarize).toHaveBeenCalledTimes(1);
    // Exactly one skipped, one real result (order not guaranteed).
    const skipped = [r1, r2].filter(r => r.skipped);
    const done = [r1, r2].filter(r => r.ok);
    expect(skipped).toHaveLength(1);
    expect(done).toHaveLength(1);
    expect(skipped[0]!.level).toBe("skipped");
  });
});
