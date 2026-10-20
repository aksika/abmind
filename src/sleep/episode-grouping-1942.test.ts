/**
 * episode-grouping-1942.test.ts — #1942 ordinal acceptance.
 *
 * Every scenario runs through the production composition: the real sleep
 * orchestrator, settlement and abmind DB via `test-harness.ts`, with only the
 * model runtime scripted. The grouping pass is never called directly.
 *
 * A1: normal/ultimate group complete exchanges; replay creates nothing new.
 * A2: interleaved sessions and a watermark-split exchange are grouped.
 * A3: catch-up is oldest-first and bounded per run.
 * A4: grouped, covered exchanges become prunable and are flushed.
 * A5: a poison group is receipted as rejected and retained.
 * A6: held acceptance, essential failure, and systemic grouping failure hold
 *     episodes and the watermark.
 * A7: pre-existing durables are byte-identical after the pass.
 * A9: the run summary reports created/replayed/rejected/waiting.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { getMemoryDb } from "../memory-manager.js";
import { runSleepCycle } from "./orchestrator.js";
import { cannedQuietFencedResponses, setupTestEnv, type TestEnv } from "./test-harness.js";
import { settleSleepRun } from "./settlement.js";
import { writeDailyFile } from "./sleep-daily-summary.js";
import { readReceipts } from "./receipts.js";
import { selectPrunableMessageIds } from "../personal-retention.js";
import type { SleepRunOptions } from "./contracts.js";
import type { SleepState } from "./state.js";
import { STEPPED_GROUPING_EXCHANGE_LIMIT } from "./episode-grouping.js";

function baseOpts(env: TestEnv, overrides: Partial<SleepRunOptions> = {}): SleepRunOptions {
  return {
    runtime: env.runtime,
    now: () => env.now,
    timeoutMs: 55 * 60_000,
    fresh: false,
    betweenStepBackoffMs: () => 0,
    retryDelays: [0],
    memoryConfigOverride: { memoryDir: env.memoryDir, memoryEnabled: true },
    ...overrides,
  };
}

function canned(env: TestEnv): void {
  env.runtime.setDefault("ok");
  env.runtime.setResponse("Update the summary incorporating", "- user asked about X\n- decision Y made\n- a second durable fact worth remembering across sessions");
  env.runtime.setResponse("store a memory using abmind store", "2 memories stored");
  cannedQuietFencedResponses(env.runtime);
  env.runtime.setResponse("Mark small talk", "[]");
}

function episodes(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM short_term_memories ORDER BY id").all() as Array<Record<string, unknown>>;
}

function seedExchange(
  db: Database.Database,
  sessionId: string,
  userTs: number,
  userText: string,
  assistantText: string,
): { userId: number; assistantId: number } {
  const insert = db.prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
  );
  const userId = Number(insert.run("master", sessionId, "user", userText, userTs).lastInsertRowid);
  const assistantId = Number(insert.run("master", sessionId, "assistant", assistantText, userTs + 500).lastInsertRowid);
  return { userId, assistantId };
}

function setWatermark(db: Database.Database, ts: number): void {
  db.prepare(
    "INSERT INTO extraction_watermarks (user_id, last_processed_timestamp) VALUES ('master', ?) ON CONFLICT(user_id) DO UPDATE SET last_processed_timestamp = excluded.last_processed_timestamp",
  ).run(ts);
}

function boundUserTurns(db: Database.Database): Set<number> {
  const bound = new Set<number>();
  const rows = db.prepare("SELECT source_message_ids FROM short_term_memories").all() as Array<{ source_message_ids: string }>;
  for (const row of rows) {
    const ids: unknown = JSON.parse(row.source_message_ids);
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "number") bound.add(id);
  }
  return bound;
}

describe("#1942 A1/A9: stepped levels group; replay creates nothing", () => {
  for (const level of ["normal", "ultimate"] as const) {
    it(`${level} groups complete exchanges and a replay leaves them unchanged`, async () => {
      const env = await setupTestEnv({ seedMessages: 6 });
      canned(env);
      try {
        const result = await runSleepCycle(baseOpts(env, { level }));
        expect(result.status).toBe("completed");
        const db = getMemoryDb(env.memory)!;
        const created = episodes(db);
        expect(created.length).toBeGreaterThan(0);
        expect(result.report).toMatch(/Grouping: \d+ created, 0 replayed, 0 rejected; 0 ungrouped exchange\(s\) waiting/);
        // A9: the audit carries the same line.
        const audits = readdirSync(join(env.memoryDir, "sleep")).filter(f => f.endsWith(".md"));
        expect(audits.length).toBeGreaterThan(0);
        const audit = audits.map(f => readFileSync(join(env.memoryDir, "sleep", f), "utf-8")).join("\n");
        expect(audit).toContain("Grouping:");

        // Replay: re-cover the same window and settle again. The bound-turn
        // check makes it a no-op; episodes stay byte-identical.
        setWatermark(db, 0);
        const replay = await runSleepCycle(baseOpts(env, { level, fresh: true }));
        expect(replay.status).toBe("completed");
        expect(episodes(db)).toEqual(created);
        expect(replay.report).toMatch(/Grouping: 0 created, 0 replayed, 0 rejected/);
      } finally {
        env.cleanup();
      }
    }, 30_000);
  }
});

describe("#1942 A2: interleaved sessions and watermark-split exchanges", () => {
  it("groups both interleaved sessions and the exchange split by the watermark", async () => {
    const env = await setupTestEnv({ seedMessages: 0 });
    canned(env);
    try {
      const db = getMemoryDb(env.memory)!;
      const insert = db.prepare(
        "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
      );
      const t0 = env.now - 10 * 60_000;
      const s1User = Number(insert.run("master", "master_A_01", "user", "interleaved session one question", t0).lastInsertRowid);
      const s2User = Number(insert.run("master", "master_A_02", "user", "interleaved session two question", t0 + 1000).lastInsertRowid);
      insert.run("master", "master_A_01", "assistant", "session one reply", t0 + 2000);
      insert.run("master", "master_A_02", "assistant", "session two reply", t0 + 3000);
      // The watermark sits on the user turn: the old builder's range
      // (watermark, ceiling] would miss it and retention could never prune it.
      setWatermark(db, t0 + 1000);

      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      const bound = boundUserTurns(db);
      expect(bound.has(s1User)).toBe(true);
      expect(bound.has(s2User)).toBe(true);
      expect(result.report).toMatch(/Grouping: 2 created/);
    } finally {
      env.cleanup();
    }
  }, 30_000);
});

describe("#1942 A3: bounded oldest-first catch-up", () => {
  it("groups at most the per-run limit, oldest first, across successive runs", async () => {
    const env = await setupTestEnv({ seedMessages: 0 });
    canned(env);
    try {
      const db = getMemoryDb(env.memory)!;
      const total = STEPPED_GROUPING_EXCHANGE_LIMIT + 5;
      const baseTs = env.now - (total + 10) * 60_000;
      const userIds: number[] = [];
      for (let i = 0; i < total; i++) {
        const ex = seedExchange(db, "master:telegram", baseTs + i * 60_000, `catch-up question ${i}`, `catch-up reply ${i}`);
        userIds.push(ex.userId);
      }
      // One new turn after the watermark authorizes the advance; the rest of
      // the backlog sits below it.
      setWatermark(db, baseTs + (total - 1) * 60_000);
      seedExchange(db, "master:telegram", baseTs + total * 60_000, "fresh question after watermark", "fresh reply");

      const first = await runSleepCycle(baseOpts(env));
      expect(first.status).toBe("completed");
      let bound = boundUserTurns(db);
      expect(userIds.slice(0, STEPPED_GROUPING_EXCHANGE_LIMIT).every(id => bound.has(id))).toBe(true);
      expect(userIds.slice(STEPPED_GROUPING_EXCHANGE_LIMIT).some(id => bound.has(id))).toBe(false);
      expect(first.report).toMatch(new RegExp(`Grouping: 1 created, 0 replayed, 0 rejected; 6 ungrouped`));
      const afterFirst = episodes(db).length;

      const later = env.now + 5 * 60_000;
      seedExchange(db, "master:telegram", later - 60_000, "another fresh question", "another fresh reply");
      const second = await runSleepCycle(baseOpts(env, { fresh: true, now: () => later }));
      expect(second.status).toBe("completed");
      bound = boundUserTurns(db);
      expect(userIds.every(id => bound.has(id))).toBe(true);
      expect(episodes(db).length - afterFirst).toBe(1);
      expect(second.report).toMatch(/Grouping: 1 created, 0 replayed, 0 rejected; 0 ungrouped/);
    } finally {
      env.cleanup();
    }
  }, 60_000);
});

describe("#1942 A4: grouped exchanges become prunable and are flushed", () => {
  it("the oldest exchange over target is grouped, selected by retention, and flushed", async () => {
    const env = await setupTestEnv({ seedMessages: 0 });
    canned(env);
    try {
      const db = getMemoryDb(env.memory)!;
      const total = 1001;
      const baseTs = env.now - (total + 10) * 60_000;
      const first = seedExchange(db, "master:telegram", baseTs, "oldest prunable question", "oldest prunable reply");
      for (let i = 1; i < total; i++) {
        seedExchange(db, "master:telegram", baseTs + i * 60_000, `history question ${i}`, `history reply ${i}`);
      }
      // Authorize a run with one turn beyond the watermark.
      setWatermark(db, baseTs + (total - 1) * 60_000);
      seedExchange(db, "master:telegram", baseTs + total * 60_000, "new turn authorizing settlement", "new reply");

      const selection = selectPrunableMessageIds(db, "master", { coveredThroughTs: env.now, targetExchanges: 1000 });
      expect(selection.messageIds).not.toContain(first.userId);

      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      expect(boundUserTurns(db).has(first.userId)).toBe(true);
      const remaining = db.prepare("SELECT id FROM messages WHERE id IN (?, ?)").all(first.userId, first.assistantId);
      expect(remaining).toEqual([]);
      // Ungrouped history beyond the per-run limit stays retained.
      const laterStillThere = db.prepare("SELECT id FROM messages WHERE session_id = 'master:telegram' AND content = 'history question 900'").get();
      expect(laterStillThere).toBeDefined();
    } finally {
      env.cleanup();
    }
  }, 120_000);
});

describe("#1942 A5: poison group isolation", () => {
  it("receipts a rejected group with its reason, retains it, and still groups others", async () => {
    const env = await setupTestEnv({ seedMessages: 0 });
    canned(env);
    try {
      const db = getMemoryDb(env.memory)!;
      const t0 = env.now - 10 * 60_000;
      const good1 = seedExchange(db, "master_A_01", t0, "first healthy question", "first healthy reply");
      const poison = seedExchange(db, "master_C_09", t0 + 10_000, "poison question", "");
      const good2 = seedExchange(db, "master_A_01", t0 + 20_000, "second healthy question", "second healthy reply");
      // Keep the poison exchange below the watermark so extraction never
      // offers its empty row; the fresh turn authorizes the run while the
      // three older exchanges are still ungrouped catch-up history.
      setWatermark(db, t0 + 25_000);
      const fresh = seedExchange(db, "master_A_01", t0 + 30_000, "fresh question authorizing settlement", "fresh reply");

      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      expect(result.report).toMatch(/Grouping: 2 created, 0 replayed, 1 rejected; 1 ungrouped/);
      const bound = boundUserTurns(db);
      expect(bound.has(good1.userId)).toBe(true);
      expect(bound.has(good2.userId)).toBe(true);
      expect(bound.has(fresh.userId)).toBe(true);
      expect(bound.has(poison.userId)).toBe(false);
      const rejected = readReceipts(env.memoryDir, result.runId).filter(r => r.op === "group" && r.disposition === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toContain("no preservable text");
      expect(rejected[0]!.evidence).toContain(String(poison.userId));
      // Retained: the poison exchange is still raw evidence.
      expect(db.prepare("SELECT id FROM messages WHERE id IN (?, ?)").all(poison.userId, poison.assistantId)).toHaveLength(2);
    } finally {
      env.cleanup();
    }
  }, 30_000);
});

describe("#1942 A6: gated runs create no episodes", () => {
  it("held acceptance creates no episodes and does not advance the watermark", async () => {
    const env = await setupTestEnv({ seedMessages: 6 });
    canned(env);
    env.runtime.setResponse(
      "Final Review and Repair",
      'FINDING step=daily-summary issue=incomplete detail="test hold"\nVERDICT: blocked reason="test hold"',
    );
    try {
      const db = getMemoryDb(env.memory)!;
      const result = await runSleepCycle(baseOpts(env, { level: "normal" }));
      expect(result.watermarkAdvanced).toBe(false);
      expect(episodes(db)).toHaveLength(0);
      expect(result.report).not.toContain("Grouping:");
    } finally {
      env.cleanup();
    }
  }, 30_000);

  it("an essential step failure creates no episodes and holds the watermark", async () => {
    const env = await setupTestEnv({ seedMessages: 6 });
    canned(env);
    env.runtime.setError("PROPOSAL-EXTRACTION-V1", new Error("extraction offline"));
    try {
      const db = getMemoryDb(env.memory)!;
      const result = await runSleepCycle(baseOpts(env, { level: "normal" }));
      expect(result.watermarkAdvanced).toBe(false);
      expect(episodes(db)).toHaveLength(0);
      expect(result.report).not.toContain("Grouping:");
    } finally {
      env.cleanup();
    }
  }, 30_000);

  it("a systemic grouping failure holds the watermark and states the reason", async () => {
    const env = await setupTestEnv({ seedMessages: 0 });
    try {
      const db = getMemoryDb(env.memory)!;
      const t0 = env.now - 10 * 60_000;
      seedExchange(db, "master:telegram", t0, "systemic question", "systemic reply");
      setWatermark(db, t0);
      const dailyPath = writeDailyFile(env.memoryDir, t0, t0 + 500, "daily summary text ".repeat(10), Date.now(), "master");
      const state: SleepState = {
        status: "ongoing", pid: 99999, startedAt: env.now - 3600_000, llmCalls: 0,
        steps: {
          "daily-summary": {
            status: "ok", essential: true, duration: 1, path: dailyPath,
            claims: [{ principal: "master", scope: "A", startTs: t0, endTs: t0 + 500, disposition: "covered" }],
          },
          "retrospective": { status: "ok", essential: true, duration: 1 },
          "extract-memories": { status: "ok", essential: true, duration: 1 },
        },
      };
      // The ready state survives; the episode table does not. Grouping must
      // treat this as systemic and hold the watermark.
      db.exec("DROP TABLE short_term_memories");
      const result = await settleSleepRun({
        runId: "test-1942-systemic",
        state,
        statePath: join(env.sleepDir, "sleep_test.lock"),
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
          dbStats: { messageCount: 2, messagesSinceLastSleep: 2, durableMemoryCount: 0, compressionRatio: 0 },
          recallProjection: { state: "not_built", servingGeneration: null, indexedDocuments: 0 },
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
        steppedLevel: true,
        manifestHasReview: false,
      });
      expect(result.watermarkAdvanced).toBe(false);
      expect(result.report).toContain("episode grouping held");
      expect(result.report).toContain("short_term_memories");
      const watermark = db.prepare("SELECT last_processed_timestamp FROM extraction_watermarks WHERE user_id = 'master'").get() as { last_processed_timestamp: number };
      expect(watermark.last_processed_timestamp).toBe(t0);
    } finally {
      env.cleanup();
    }
  }, 30_000);
});

describe("#1942 A7: durables are untouched", () => {
  it("a pre-existing durable row is byte-identical after step settlement", async () => {
    const env = await setupTestEnv({ seedMessages: 6 });
    canned(env);
    try {
      const db = getMemoryDb(env.memory)!;
      const ts = env.now - 86_400_000;
      db.prepare(
        `INSERT INTO long_term_memories
           (id, user_id, memory_type, content, authority, applicability_scope, provenance, evidence,
            classification, encrypted, sealed_format_version, valid_to, revision, semantic_revision,
            created_at, updated_at)
         VALUES (1001, 'master', 'fact', 'pre-existing durable fact', 'inference',
           '{"scope":"general"}', '{"topic":"general"}', '[]', 1, 0, 0, NULL, 1, 1, ?, ?)`,
      ).run(ts, ts);
      const before = db.prepare("SELECT * FROM long_term_memories WHERE id = 1001").get();
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      expect(episodes(db).length).toBeGreaterThan(0);
      expect(db.prepare("SELECT * FROM long_term_memories WHERE id = 1001").get()).toEqual(before);
    } finally {
      env.cleanup();
    }
  }, 30_000);
});
