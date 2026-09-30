/**
 * #1860 acceptance integration: a middle-batch hole in the claim ledger
 * holds the watermark below it through the real settlement → watermark →
 * flush path. Multi-principal and multi-session-type rows prove only
 * consumed scopes are claimed.
 *
 * Note: through the production step wrapper every runtime rejection is a
 * terminal-typed model failure (`SleepModelFailureError extends
 * LLMUnavailableError`), so a mid-batch provider failure fails the step
 * (no advance, catch-up recovers) rather than producing ok-with-hole. The
 * skipped-batch shape below is the contract `buildDailySummary` honors for
 * non-terminal domain errors; whatever produces it, settlement must hold.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { setupTestEnv } from "./test-harness.js";
import { settleSleepRun } from "./settlement.js";
import { writeDailyFile } from "./sleep-daily-summary.js";
import { getMemoryDb } from "../memory-manager.js";
import { claimsForDailySummary } from "./shared-execution.js";
import type { SleepState } from "./state.js";

describe("#1860 hole blocks advance, only consumed scopes claimed", () => {
  it("watermark lands below the hole; covered-old prunes, hole/foreign/worker rows survive both sweeps", async () => {
    const env = await setupTestEnv();
    try {
      const db = getMemoryDb(env.memory);
      if (!db) throw new Error("no db");
      const t0 = env.now - 30 * 86400000; // old enough for the age sweep
      const t1 = env.now - 3 * 3600_000;
      const t2 = env.now - 2 * 3600_000; // the hole
      const t3 = env.now - 1 * 3600_000;
      const insert = db.prepare(
        "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, ?)",
      );
      insert.run("master", "master:telegram", "old covered message", t0);
      insert.run("master", "master:telegram", "covered message", t1);
      insert.run("master", "master:telegram", "hole message never summarized", t2);
      insert.run("master", "master:telegram", "later covered message", t3);
      const foreignId = insert.run("other", "plain", "foreign message never read", t1).lastInsertRowid;
      const workerId = insert.run("master", "sess_W_9", "worker turn never read", t1).lastInsertRowid;

      const dailyPath = writeDailyFile(env.memoryDir, t0, t3, "durable summary line ".repeat(10), Date.now(), "master");
      const state: SleepState = {
        status: "ongoing", pid: 99999, startedAt: env.now - 3600_000, llmCalls: 0,
        steps: {
          "daily-summary": {
            status: "ok", essential: true, duration: 1, path: dailyPath,
            claims: [
              { principal: "master", scope: "A", startTs: t0, endTs: t1, disposition: "covered" },
              { principal: "master", scope: "A", startTs: t2, endTs: t2, disposition: "unclaimed" },
              { principal: "master", scope: "A", startTs: t3, endTs: t3, disposition: "covered" },
            ],
          },
          "retrospective": { status: "ok", essential: true, duration: 1 },
          "extract-memories": { status: "ok", essential: true, duration: 1 },
        },
      };
      const statePath = join(env.sleepDir, "sleep_test.lock");

      const result = await settleSleepRun({
        runId: "test-1860",
        state,
        statePath,
        budget: undefined,
        watermarkTargetTs: env.now,
        memory: env.memory,
        sleepData: env.memory.getSleepData(),
        db,
        gcCycleSelection: null,
        gcDiagnostic: null,
        onEvent: undefined,
        snapshot: {
          timestamp: new Date(env.now).toISOString(),
          workingDirs: [],
          dbStats: {
            messageCount: 6, messagesSinceLastSleep: 6, embeddingCount: 0,
            nullEmbeddingCount: 0, extractedMemoryCount: 0, compressionRatio: 0,
            darwinism: { avgRecallCount: 0, avgRelevanceScore: 0, neverRecalled: 0, recalledLast30d: 0 },
          },
          fts5Health: { messages_fts: "ok", extracted_memories_fts: "ok", extracted_memories_original_fts: "ok" },
          diskUsageBytes: 0,
          diskBudgetBytes: 1000000,
          topicFiles: [],
          lastSleepAudit: null,
          lastSleepTimestamp: null,
          wakeupDate: null,
          todoContents: null,
          cronContents: null,
        },
        vars: {},
        primaryUserId: "master",
        modelUsed: "test",
        memoryDir: env.memoryDir,
        wiredResults: { purged: 0, deduped: 0, embedded: 0, anomaliesFixed: 0, walOk: true, ftsOk: true },
        terminalModelFailure: null,
        newEvidenceRevisions: new Map(),
        existingEvidenceRevisions: new Map(),
        currentRunNewIds: new Set(),
        acceptedOutputChars: new Map([["daily-summary", 100]]),
        stepOrder: ["daily-summary", "retrospective", "extract-memories"],
        now: () => env.now,
        signal: new AbortController().signal,
        startedAt: env.now - 3600_000,
      });

      expect(result.status).toBe("completed");
      expect(result.watermarkAdvanced).toBe(true);

      const wm = (userId: string): number | undefined =>
        (db.prepare("SELECT last_processed_timestamp AS ts FROM extraction_watermarks WHERE user_id = ?").get(userId) as { ts: number } | undefined)?.ts;

      // The watermark holds below the hole's first message.
      expect(wm("master")).toBe(t2 - 1);
      // No watermark is created for a principal sleep never read.
      expect(wm("other")).toBeUndefined();

      const byTs = (ts: number): unknown =>
        db.prepare("SELECT id FROM messages WHERE timestamp = ?").get(ts);
      const byId = (id: number | bigint): unknown =>
        db.prepare("SELECT id FROM messages WHERE id = ?").get(Number(id));
      // Covered and old: pruned by the age sweep through proven coverage.
      expect(byTs(t0)).toBeUndefined();
      // The hole and everything after it survive both sweeps.
      expect(byTs(t2)).toBeDefined();
      expect(byTs(t3)).toBeDefined();
      // Foreign-principal and non-consumed-session rows are never claimed.
      expect(byId(foreignId)).toBeDefined();
      expect(byId(workerId)).toBeDefined();

      // The run reports its coverage decision and the retained volume.
      expect(result.report).toContain("Coverage:");
      expect(result.report).toContain("retained:");
    } finally {
      env.cleanup();
    }
  });
});

describe("claimsForDailySummary", () => {
  it("maps covered/skipped/excluded intervals to scoped claims", () => {
    const claims = claimsForDailySummary("master", {
      summary: "s",
      startTs: 1,
      endTs: 9,
      covered: [{ scope: "A", startTs: 1, endTs: 2 }],
      skipped: [{ scope: "C", startTs: 3, endTs: 4 }],
      excluded: [{ startTs: 5, endTs: 6, reason: "system-prefix" }],
    });
    expect(claims).toEqual([
      { principal: "master", scope: "A", startTs: 1, endTs: 2, disposition: "covered" },
      { principal: "master", scope: "C", startTs: 3, endTs: 4, disposition: "unclaimed" },
      { principal: "master", scope: "excluded", startTs: 5, endTs: 6, disposition: "excluded", reason: "system-prefix" },
    ]);
  });
});
