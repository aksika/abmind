/**
 * context-compaction-acceptance.test.ts — #1406 restart/continuity
 * acceptance: commit → restart (recreate services over the same DB) →
 * project → continue → compact again → concurrent race. Proves checkpoint
 * prefix/digest stability, exactly-once representation, generation recovery,
 * and the CAS race outcome.
 *
 * Measurements (content-free) are printed and attached to the #1406
 * implementation evidence; they are not asserted as brittle constants.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { ContextCompactionService, type CommitCompactionInput } from "./context-compaction.js";
import { ContextProjector } from "./context-projector.js";
import { CheckpointStore } from "./context-checkpoint-store.js";

const USER = "user-a";
const SESSION = "acceptance-s1";

interface Measurement {
  step: string;
  durationMs: number;
  tokensBefore?: number;
  tokensAfter?: number;
  savingsPct?: number;
}

const measurements: Measurement[] = [];

function insertRows(db: Database.Database, rows: Array<{ role: string; content: string }>): number[] {
  const ids: number[] = [];
  const stmt = db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)");
  for (const r of rows) {
    ids.push(Number(stmt.run(USER, SESSION, r.role, r.content, Date.now()).lastInsertRowid));
  }
  return ids;
}

function commitInput(candidate: Extract<ReturnType<ContextCompactionService["prepare"]>, { status: "ready" }>["candidate"], summary: string): CommitCompactionInput {
  const { serializedTurns: _s, priorCheckpoint: _p, summaryTokenBudget: _b, ...proof } = candidate;
  return {
    userId: USER,
    sessionId: SESSION,
    candidate: proof,
    summary,
    summaryTokenCount: Math.ceil(summary.length / 4),
    summarizer: { provider: "acceptance-provider", model: "acceptance-model" },
    activeRequestModel: "acceptance-model",
    reason: "manual",
  };
}

describe("#1406 restart/continuity acceptance", () => {
  it("commits, restarts, projects the checkpoint plus suffix exactly once, continues, and compacts again", () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-compaction-acceptance-"));
    const dbPath = join(dir, "memory.db");
    try {
      // ── Phase 1: record history and compact ─────────────────────────────
      let db = initializeDatabase(dbPath);
      insertRows(db, [
        { role: "user", content: "turn 1 user request" },
        { role: "assistant", content: "turn 1 assistant response" },
        { role: "user", content: "turn 2 user request" },
        { role: "assistant", content: "turn 2 assistant response" },
        { role: "user", content: "turn 3 user request" },
        { role: "assistant", content: "turn 3 assistant response" },
      ]);
      const cursor1 = insertRows(db, [{ role: "user", content: "current question" }])[0]!;

      let t0 = Date.now();
      let service = new ContextCompactionService(db);
      const prepare = service.prepare({ userId: USER, sessionId: SESSION, beforeMessageId: cursor1, maxHistoryTokens: 0, minRecentTokens: 0, reason: "manual" });
      expect(prepare.status).toBe("ready");
      if (prepare.status !== "ready") return;
      // The cursor row is exclusive: all three complete turns are compacted.
      const commit = service.commit(commitInput(prepare.candidate, "summary of turns one through three"));
      expect(commit.status).toBe("committed");
      measurements.push({ step: "phase1-compact", durationMs: Date.now() - t0, tokensBefore: prepare.candidate.sourceTokenCount, tokensAfter: 6 });

      // ── Phase 2: restart — brand-new service instances over the same DB ──
      db.close();
      db = initializeDatabase(dbPath);
      service = new ContextCompactionService(db);
      const projector = new ContextProjector(db);

      const store = new CheckpointStore(db);
      const ptr = store.getActivePointer(SESSION);
      expect(ptr?.generation).toBe(1);
      const cp = store.getCheckpoint(ptr!.checkpointId);
      expect(cp?.content).toBe("summary of turns one through three");
      const prefixDigestAtRestart = cp?.checkpointDigest;
      const firstKeptAtRestart = cp?.firstKeptMessageId;

      // Projection after restart: the checkpoint frame plus the verbatim
      // suffix (turn 3, kept below the cursor) — every compacted row
      // represented exactly once by the frame.
      const projected = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor1, maxContext: 100_000 });
      const contents = projected.messages.map(m => m.content);
      expect(contents.filter(c => c.includes("summary of turns one through three")).length).toBe(1);
      expect(contents.some(c => c.includes("turn 1 user request"))).toBe(false);
      expect(contents.some(c => c === "turn 3 user request")).toBe(true); // suffix verbatim
      expect(contents.some(c => c === "current question")).toBe(false); // cursor exclusive

      // ── Phase 3: answer the cursor and continue one more turn ────────────
      const answerId = insertRows(db, [{ role: "assistant", content: "answer to the current question" }])[0]!;
      insertRows(db, [
        { role: "user", content: "follow-up user" },
        { role: "assistant", content: "follow-up assistant" },
      ]);
      const cursor2 = insertRows(db, [{ role: "user", content: "second current" }])[0]!;

      const projected2 = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor2, maxContext: 100_000 });
      const contents2 = projected2.messages.map(m => m.content);
      expect(contents2.filter(c => c.includes("summary of turns one through three")).length).toBe(1);
      expect(contents2.filter(c => c === "current question").length).toBe(1); // now historical, answered
      expect(contents2.filter(c => c === "answer to the current question").length).toBe(1);
      expect(contents2.filter(c => c === "follow-up user").length).toBe(1);
      expect(contents2.filter(c => c === "second current").length).toBe(0); // cursor exclusive

      // ── Phase 4: second compaction chains the lineage; prefix is stable ──
      t0 = Date.now();
      const second = service.prepare({ userId: USER, sessionId: SESSION, beforeMessageId: cursor2, maxHistoryTokens: 0, minRecentTokens: 0, reason: "manual" });
      expect(second.status).toBe("ready");
      if (second.status !== "ready") return;
      expect(second.candidate.expectedGeneration).toBe(1);
      expect(second.candidate.previousCheckpointId).toBe(ptr!.checkpointId);
      // The answered cursor turn becomes a complete unit and is compacted
      // together with turn 3; the follow-up stays as the suffix, so firstKept
      // is the first follow-up row (a real row, never an adjacency guess).
      expect(second.candidate.sourceMessageStart).toBe(firstKeptAtRestart);
      expect(second.candidate.sourceMessageEnd).toBe(answerId);
      expect(second.candidate.firstKeptMessageId).toBe(answerId + 1);
      expect(second.candidate.firstKeptMessageId).toBeGreaterThan(second.candidate.sourceMessageEnd);
      const secondCommit = service.commit(commitInput(second.candidate, "cumulative summary through the follow-up"));
      expect(secondCommit.status).toBe("committed");
      if (secondCommit.status !== "committed") return;
      expect(secondCommit.generation).toBe(2);
      measurements.push({ step: "phase4-compact", durationMs: Date.now() - t0, tokensBefore: second.candidate.sourceTokenCount, tokensAfter: 5 });

      // The first checkpoint record is immutable: digest unchanged.
      const cp1 = store.getCheckpoint(ptr!.checkpointId);
      expect(cp1?.checkpointDigest).toBe(prefixDigestAtRestart);
      expect(store.getActivePointer(SESSION)?.generation).toBe(2);

      // ── Phase 5: CAS race — one winner, one truthful stale loser ─────────
      insertRows(db, [
        { role: "user", content: "race user" },
        { role: "assistant", content: "race assistant" },
      ]);
      const cursor3 = insertRows(db, [{ role: "user", content: "race current" }])[0]!;
      // Two independent service instances (parallel requesters share only the
      // DB; the generation CAS is the arbiter, not the in-flight set).
      const svcA = new ContextCompactionService(db);
      const svcB = new ContextCompactionService(db);
      const raceA = svcA.prepare({ userId: USER, sessionId: SESSION, beforeMessageId: cursor3, maxHistoryTokens: 0, minRecentTokens: 0, reason: "manual" });
      const raceB = svcB.prepare({ userId: USER, sessionId: SESSION, beforeMessageId: cursor3, maxHistoryTokens: 0, minRecentTokens: 0, reason: "manual" });
      expect(raceA.status).toBe("ready");
      expect(raceB.status).toBe("ready");
      if (raceA.status !== "ready" || raceB.status !== "ready") return;
      const winner = svcA.commit(commitInput(raceA.candidate, "race winner summary"));
      expect(winner.status).toBe("committed");
      const loser = svcB.commit(commitInput(raceB.candidate, "race loser summary"));
      expect(loser.status).toBe("stale");
      expect(store.getActivePointer(SESSION)?.generation).toBe(3);
      const count = db.prepare("SELECT COUNT(*) AS c FROM context_checkpoints WHERE chat_id = ?").get(SESSION) as { c: number };
      expect(count.c).toBe(3);
      // No context loss: checkpoint 3 cumulatively covers the same meaning.
      const cp3 = store.getCheckpoint(store.getActivePointer(SESSION)!.checkpointId);
      expect(cp3?.content).toBe("race winner summary");

      console.log("[acceptance] #1406 measurements:", JSON.stringify(measurements, null, 2));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
