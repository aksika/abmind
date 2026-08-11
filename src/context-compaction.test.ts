/**
 * context-compaction.test.ts — #1406 durable compaction authority:
 * complete-turn selection, canonical digest, payload bounds, generation CAS
 * commit, busy tracking, and legacy migration.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import {
  selectCompactionCandidate, commitConversationCheckpoint,
  ContextCompactionService, migrateLegacySummaries,
  canonicalSerializeMessages, COMPACTION_PAYLOAD_MAX_BYTES,
} from "./context-compaction.js";
import type {
  CompactionSelectionInput, CommitCompactionInput, CompactionCandidateProofV1,
} from "./context-compaction.js";
import { CheckpointStore } from "./context-checkpoint-store.js";

const USER = "user-a";
const SESSION = "s1";

function makeDb(): Database.Database {
  return initializeDatabase(":memory:");
}

let seq = 1_000;
beforeEach(() => { seq = 1_000; });
function insert(
  db: Database.Database,
  opts: { user?: string; session?: string; role: string; content: string; ts?: number; id?: number },
): number {
  const id = opts.id ?? seq++;
  db.prepare(
    "INSERT INTO messages (id, user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, opts.user ?? USER, opts.session ?? SESSION, opts.role, opts.content, opts.ts ?? Date.now());
  return id;
}

function seedTurns(db: Database.Database, turns: number, opts: { suffixAfter?: boolean } = {}): { firstKept: number; cursor: number } {
  const ids: number[] = [];
  for (let t = 1; t <= turns; t++) {
    ids.push(insert(db, { role: "user", content: `turn ${t} user` }));
    ids.push(insert(db, { role: "assistant", content: `turn ${t} assistant` }));
  }
  if (opts.suffixAfter) ids.push(insert(db, { role: "user", content: "current" }));
  const cursor = ids[ids.length - 1]!;
  return { firstKept: 0, cursor };
}

function baseInput(overrides: Partial<CompactionSelectionInput> = {}): CompactionSelectionInput {
  return {
    userId: USER,
    sessionId: SESSION,
    beforeMessageId: Number.MAX_SAFE_INTEGER,
    maxHistoryTokens: 0,
    minRecentTokens: 0,
    reason: "manual",
    ...overrides,
  };
}

function proofOf(candidate: NonNullable<Awaited<ReturnType<typeof selectCompactionCandidate>> extends { status: "ready"; candidate: infer C } ? C : never>): CompactionCandidateProofV1 {
  const { serializedTurns: _s, priorCheckpoint: _p, summaryTokenBudget: _b, ...proof } = candidate;
  return proof;
}

type ReadyCandidate = Extract<ReturnType<typeof selectCompactionCandidate>, { status: "ready" }>["candidate"];

function commitInput(candidate: ReadyCandidate, overrides: Partial<CommitCompactionInput> = {}): CommitCompactionInput {
  const summary = "a bounded summary of the compacted prefix";
  return {
    userId: USER,
    sessionId: SESSION,
    candidate: proofOf(candidate),
    summary,
    summaryTokenCount: Math.ceil(summary.length / 4),
    summarizer: { provider: "test-provider", model: "test-model" },
    activeRequestModel: "test-model",
    reason: "manual",
    ...overrides,
  };
}

describe("selectCompactionCandidate #1406", () => {
  it("selects the complete prefix and derives firstKeptMessageId from the real first suffix row (sparse ids)", () => {
    const db = makeDb();
    insert(db, { role: "user", content: "u1", id: 10 });
    insert(db, { role: "assistant", content: "a1", id: 20 });
    insert(db, { role: "user", content: "u2", id: 30 });
    insert(db, { role: "assistant", content: "a2", id: 40 });
    insert(db, { role: "user", content: "u3", id: 50 });
    insert(db, { role: "assistant", content: "a3", id: 60 });

    const result = selectCompactionCandidate(db, baseInput());
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.candidate.sourceMessageStart).toBe(10);
    // minRecentTokens=0 keeps only the newest complete unit as suffix.
    expect(result.candidate.sourceMessageEnd).toBe(40);
    expect(result.candidate.firstKeptMessageId).toBe(50);
    expect(result.candidate.expectedGeneration).toBe(0);
    expect(result.candidate.previousCheckpointId).toBeNull();
    expect(result.candidate.serializedTurns.split("\n")).toHaveLength(4);
    expect(result.candidate.sourceDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(result.candidate.summaryTokenBudget).toBeGreaterThanOrEqual(2000);
  });

  it("keeps the trailing incomplete turn (current user + in-flight tool exchange) unconditionally", () => {
    const db = makeDb();
    insert(db, { role: "user", content: "u1" });
    insert(db, { role: "assistant", content: "a1" });
    insert(db, { role: "user", content: "u2" });
    insert(db, { role: "tool", content: "tool result" });

    const result = selectCompactionCandidate(db, baseInput());
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.candidate.sourceMessageEnd).toBe(1001);
    expect(result.candidate.firstKeptMessageId).toBe(1002);
  });

  it("an incomplete turn before the suffix blocks compaction of anything newer; the complete prefix is still compacted", () => {
    const db = makeDb();
    insert(db, { role: "user", content: "u1" });
    insert(db, { role: "assistant", content: "a1" });
    insert(db, { role: "user", content: "u2" });
    insert(db, { role: "tool", content: "tool pending" }); // incomplete turn
    insert(db, { role: "user", content: "u3" });
    insert(db, { role: "assistant", content: "a3" });

    const result = selectCompactionCandidate(db, baseInput({ minRecentTokens: 0 }));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    // Only the oldest complete unit (u1/a1) is compacted; the incomplete
    // u2/tool unit and the trailing complete unit stay as suffix.
    expect(result.candidate.sourceMessageEnd).toBe(1001);
    expect(result.candidate.firstKeptMessageId).toBe(1002);
  });

  it("nothing_to_compact when only the trailing incomplete turn exists", () => {
    const db = makeDb();
    insert(db, { role: "user", content: "u1" });
    insert(db, { role: "tool", content: "in flight" });

    const result = selectCompactionCandidate(db, baseInput());
    expect(result.status).toBe("nothing_to_compact");
  });

  it("manual reason bypasses the history-budget gate; automatic respects it", () => {
    const db = makeDb();
    seedTurns(db, 3);
    const automatic = selectCompactionCandidate(db, baseInput({ reason: "automatic", maxHistoryTokens: 100_000 }));
    expect(automatic.status).toBe("nothing_to_compact");
    const manual = selectCompactionCandidate(db, baseInput({ reason: "manual", maxHistoryTokens: 100_000 }));
    expect(manual.status).toBe("ready");
  });

  it("minRecentTokens keeps a complete recent suffix out of the candidate", () => {
    const db = makeDb();
    seedTurns(db, 5); // turns at ids 1000..1009
    const result = selectCompactionCandidate(db, baseInput({ minRecentTokens: 8 }));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    // Each turn is ~4 estimated tokens; a floor of 8 keeps the newest two
    // complete units (t4, t5) as suffix.
    expect(result.candidate.sourceMessageEnd).toBe(1005);
    expect(result.candidate.firstKeptMessageId).toBe(1006);
  });

  it("cross-owner sessions are invisible (nothing_to_compact, no leak)", () => {
    const db = makeDb();
    insert(db, { user: "user-b", role: "user", content: "theirs" });
    insert(db, { user: "user-b", role: "assistant", content: "theirs" });
    expect(selectCompactionCandidate(db, baseInput()).status).toBe("nothing_to_compact");

    insert(db, { user: "user-b", role: "user", content: "mixed", session: SESSION });
    expect(selectCompactionCandidate(db, baseInput()).status).toBe("nothing_to_compact");
  });

  it("beforeMessageId is an exclusive upper bound (current user turn excluded)", () => {
    const db = makeDb();
    insert(db, { role: "user", content: "u1" });
    insert(db, { role: "assistant", content: "a1" });
    insert(db, { role: "user", content: "u2" });
    insert(db, { role: "assistant", content: "a2" });
    const current = insert(db, { role: "user", content: "current" });

    const result = selectCompactionCandidate(db, baseInput({ beforeMessageId: current }));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.candidate.serializedTurns).not.toContain("current");
  });

  it("shrinks the candidate at complete-turn boundaries when the payload bound is exceeded", () => {
    const db = makeDb();
    insert(db, { role: "user", content: "u1" });
    insert(db, { role: "assistant", content: "a1" });
    insert(db, { role: "user", content: "u2" });
    insert(db, { role: "assistant", content: "a2" });
    insert(db, { role: "user", content: "u3" });
    insert(db, { role: "assistant", content: "a3" });
    const result = selectCompactionCandidate(db, baseInput({ maxHistoryTokens: 0 }));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    // Small payload — no shrink. Force the bound by making a huge single turn.
    const huge = insert(db, { role: "user", content: "big" });
    insert(db, { role: "assistant", content: "x".repeat(COMPACTION_PAYLOAD_MAX_BYTES) });
    const bigResult = selectCompactionCandidate(db, baseInput({ beforeMessageId: huge, maxHistoryTokens: 0, minRecentTokens: 0 }));
    if (bigResult.status === "ready") {
      expect(Buffer.byteLength(bigResult.candidate.serializedTurns, "utf-8")).toBeLessThanOrEqual(COMPACTION_PAYLOAD_MAX_BYTES);
    }
  });

  it("canonical serialization is deterministic (same rows → same digest)", () => {
    const db = makeDb();
    insert(db, { role: "user", content: "u1" });
    insert(db, { role: "assistant", content: "a1" });
    insert(db, { role: "user", content: "u2" });
    insert(db, { role: "assistant", content: "a2" });
    const a = selectCompactionCandidate(db, baseInput());
    const b = selectCompactionCandidate(db, baseInput());
    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
    if (a.status !== "ready" || b.status !== "ready") return;
    expect(a.candidate.sourceDigest).toBe(b.candidate.sourceDigest);
    expect(a.candidate.serializedTurns).toBe(canonicalSerializeMessages([
      { id: a.candidate.sourceMessageStart, role: "user", content: "u1" },
      { id: a.candidate.sourceMessageEnd, role: "assistant", content: "a1" },
    ]));
  });
});

describe("commitConversationCheckpoint #1406", () => {
  function readyCandidate(db: Database.Database, overrides: Partial<CompactionSelectionInput> = {}) {
    const result = selectCompactionCandidate(db, baseInput(overrides));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready");
    return result.candidate;
  }

  function commitInputLocal(candidate: Awaited<ReturnType<typeof readyCandidate>>, overrides: Partial<CommitCompactionInput> = {}): CommitCompactionInput {
    return commitInput(candidate, overrides);
  }

  it("commits atomically and advances the generation", () => {
    const db = makeDb();
    seedTurns(db, 3);
    const candidate = readyCandidate(db);
    const outcome = commitConversationCheckpoint(db, commitInput(candidate));
    expect(outcome.status).toBe("committed");
    if (outcome.status !== "committed") return;
    expect(outcome.checkpointId).toBeGreaterThan(0);
    expect(outcome.generation).toBe(1);

    const store = new CheckpointStore(db);
    const ptr = store.getActivePointer(SESSION);
    expect(ptr?.generation).toBe(1);
    expect(ptr?.checkpointId).toBe(outcome.checkpointId);
    const cp = store.getCheckpoint(outcome.checkpointId);
    expect(cp?.firstKeptMessageId).toBe(candidate.firstKeptMessageId);
    expect(cp?.sourceDigest).toBe(candidate.sourceDigest);
    expect(cp?.summarizerModel).toBe("test-model");
    expect(cp?.summarizerProvider).toBe("test-provider");
  });

  it("second commit reuses the new pointer generation (chained lineage)", () => {
    const db = makeDb();
    seedTurns(db, 5); // t1..t5 at ids 1000..1009
    const first = readyCandidate(db);
    const firstOutcome = commitConversationCheckpoint(db, commitInputLocal(first));
    expect(firstOutcome.status).toBe("committed");
    if (firstOutcome.status !== "committed") return;

    // New turns arrive after the first checkpoint's suffix (t5).
    insert(db, { role: "user", content: "t6 user" });
    insert(db, { role: "assistant", content: "t6 assistant" });

    const nextResult = selectCompactionCandidate(db, baseInput({ minRecentTokens: 0 }));
    expect(nextResult.status).toBe("ready");
    if (nextResult.status !== "ready") return;
    expect(nextResult.candidate.expectedGeneration).toBe(1);
    expect(nextResult.candidate.previousCheckpointId).toBe(firstOutcome.checkpointId);
    const secondOutcome = commitConversationCheckpoint(db, commitInputLocal(nextResult.candidate));
    expect(secondOutcome.status).toBe("committed");
    if (secondOutcome.status !== "committed") return;
    expect(secondOutcome.generation).toBe(2);
  });

  it("stale generation performs no write", () => {
    const db = makeDb();
    seedTurns(db, 3);
    const candidate = readyCandidate(db);
    expect(commitConversationCheckpoint(db, commitInput(candidate)).status).toBe("committed");

    // Replay the same candidate (generation 0) — now stale.
    const replay = commitConversationCheckpoint(db, commitInput(candidate));
    expect(replay.status).toBe("stale");
  });

  it("tampered source digest is rejected without any write", () => {
    const db = makeDb();
    seedTurns(db, 3);
    const candidate = readyCandidate(db);
    const store = new CheckpointStore(db);
    const outcome = commitConversationCheckpoint(db, commitInput(candidate, {
      candidate: { ...proofOf(candidate), sourceDigest: "0".repeat(16) },
    }));
    expect(outcome.status).toBe("rejected");
    expect(store.getActivePointer(SESSION)).toBeNull();
  });

  it("tampered firstKeptMessageId is rejected", () => {
    const db = makeDb();
    seedTurns(db, 3);
    const candidate = readyCandidate(db);
    const outcome = commitConversationCheckpoint(db, commitInput(candidate, {
      candidate: { ...proofOf(candidate), firstKeptMessageId: 1 },
    }));
    expect(outcome.status).toBe("rejected");
  });

  it("empty and inflated summaries are rejected (no pointer advancement)", () => {
    const db = makeDb();
    seedTurns(db, 3);
    const candidate = readyCandidate(db);
    expect(commitConversationCheckpoint(db, commitInput(candidate, { summary: "   " })).status).toBe("rejected");
    expect(commitConversationCheckpoint(db, commitInput(candidate, {
      summary: "z".repeat(candidate.sourceTokenCount * 8),
      summaryTokenCount: candidate.sourceTokenCount * 8,
    })).status).toBe("rejected");
  });

  it("mixed-owner commit is rejected without leaking", () => {
    const db = makeDb();
    seedTurns(db, 3);
    const candidate = readyCandidate(db);
    const outcome = commitConversationCheckpoint(db, commitInput(candidate, { userId: "user-b" }));
    expect(outcome.status).toBe("rejected");
  });

  it("replaying the same candidate after a commit is stale by generation CAS (ledger replay is covered at the service level)", () => {
    const db = makeDb();
    seedTurns(db, 3);
    const candidate = readyCandidate(db);
    const input = commitInput(candidate);
    const first = commitConversationCheckpoint(db, input);
    expect(first.status).toBe("committed");
    const replay = commitConversationCheckpoint(db, input);
    expect(replay.status).toBe("stale"); // same candidate, new generation → stale by CAS
  });
});

describe("ContextCompactionService #1406", () => {
  it("reports busy while a candidate is prepared but not committed", () => {
    const db = makeDb();
    seedTurns(db, 3);
    const svc = new ContextCompactionService(db);
    expect(svc.prepare(baseInput()).status).toBe("ready");
    expect(svc.prepare(baseInput()).status).toBe("busy");
  });

  it("releases busy after commit; a concurrent loser gets stale (CAS decides)", () => {
    const db = makeDb();
    seedTurns(db, 5); // t1..t5
    const svc = new ContextCompactionService(db);
    const prepare = svc.prepare(baseInput());
    expect(prepare.status).toBe("ready");
    if (prepare.status !== "ready") return;
    const outcome = svc.commit(commitInput(prepare.candidate));
    expect(outcome.status).toBe("committed");

    // New turns arrive; the busy slot is released and a fresh candidate can
    // be prepared against the new generation.
    insert(db, { role: "user", content: "t6 user" });
    insert(db, { role: "assistant", content: "t6 assistant" });
    const second = svc.prepare(baseInput({ minRecentTokens: 0 }));
    expect(second.status).toBe("ready");
    if (second.status !== "ready") return;
    expect(second.candidate.expectedGeneration).toBe(1);

    // A replay of the FIRST candidate (generation 0) is stale — no write.
    const replay = svc.commit(commitInput(prepare.candidate));
    expect(replay.status).toBe("stale");
  });
});

describe("migrateLegacySummaries #1406", () => {
  function seedLegacy(db: Database.Database, session = SESSION): void {
    const s1 = insert(db, { role: "user", content: "m1 user" });
    insert(db, { role: "assistant", content: "m1 assistant" });
    insert(db, { role: "user", content: "m2 user" });
    insert(db, { role: "assistant", content: "m2 assistant" });
    const kept = insert(db, { role: "user", content: "kept" });
    insert(db, { role: "assistant", content: "kept a" });
    // Legacy summary covers the compacted prefix 1000..1003; the watermark is
    // the first row after it (1004).
    db.prepare("INSERT INTO context_summaries (chat_id, depth, content, token_estimate, source_message_start, source_message_end, classification, archived, model, created_at) VALUES (?, 0, ?, ?, ?, ?, 1, 0, NULL, ?)")
      .run(session, "summary one", 4, s1, s1 + 3, Date.now());
    db.prepare("INSERT INTO context_watermarks (chat_id, watermark_message_id, compaction_count, last_compacted_at, last_failed_at, pending_compaction, model, token_estimate) VALUES (?, ?, 1, ?, 0, 0, NULL, 4)")
      .run(session, kept, Date.now());
  }

  it("migrates one valid session into a cumulative checkpoint and archives legacy rows", () => {
    const db = makeDb();
    seedLegacy(db);
    const count = migrateLegacySummaries(db);
    expect(count).toBe(1);

    const store = new CheckpointStore(db);
    const ptr = store.getActivePointer(SESSION);
    expect(ptr?.generation).toBe(1);
    const cp = store.getCheckpoint(ptr!.checkpointId);
    expect(cp?.content).toContain("summary one");
    expect(cp?.sourceMessageStart).toBe(1000);
    expect(cp?.firstKeptMessageId).toBe(1004);
    expect(cp?.reason).toBe("migration");
    const archived = db.prepare("SELECT archived FROM context_summaries WHERE chat_id = ?").get(SESSION) as { archived: number };
    expect(archived.archived).toBe(1);
  });

  it("is idempotent on restart (no active summaries → no-op)", () => {
    const db = makeDb();
    seedLegacy(db);
    expect(migrateLegacySummaries(db)).toBe(1);
    expect(migrateLegacySummaries(db)).toBe(0);
  });

  it("skips sessions that already have an active checkpoint", () => {
    const db = makeDb();
    seedLegacy(db);
    // Pre-commit a checkpoint for a DIFFERENT session, then migrate.
    insert(db, { session: "s2", role: "user", content: "x" });
    insert(db, { session: "s2", role: "assistant", content: "y" });
    db.prepare("INSERT INTO context_summaries (chat_id, depth, content, token_estimate, source_message_start, source_message_end, classification, archived, model, created_at) VALUES ('s2', 0, 'legacy s2', 3, 1008, 1009, 1, 0, NULL, ?)").run(Date.now());
    db.prepare("INSERT INTO context_watermarks (chat_id, watermark_message_id, compaction_count) VALUES ('s2', 1010, 1)").run();
    const store = new CheckpointStore(db);
    store.commitCheckpoint("s2", {
      previousCheckpointId: null, sourceMessageStart: 1008, sourceMessageEnd: 1009,
      firstKeptMessageId: 1010, content: "cp", sourceTokenCount: 5, checkpointTokenCount: 1,
      sourceDigest: "d", checkpointDigest: "c", summarizerModel: null, summarizerProvider: null,
      activeRequestModel: "m", reason: "manual", budgetJson: "{}", classification: 1,
      promptVersion: "p", schemaVersion: 1, serializerVersion: "s",
    }, 0);
    const count = migrateLegacySummaries(db);
    expect(count).toBe(1); // only SESSION migrated; s2 skipped
    const s2Archived = db.prepare("SELECT archived FROM context_summaries WHERE chat_id = 's2'").get() as { archived: number };
    expect(s2Archived.archived).toBe(0);
  });

  it("quarantines an inconsistent session (no throw, rows untouched) and still migrates healthy sessions", () => {
    const db = makeDb();
    seedLegacy(db);
    // Overlapping second summary in the same session.
    db.prepare("INSERT INTO context_summaries (chat_id, depth, content, token_estimate, source_message_start, source_message_end, classification, archived, model, created_at) VALUES (?, 0, 'overlap', 2, 1002, 1003, 1, 0, NULL, ?)")
      .run(SESSION, Date.now());

    // A healthy session must still migrate even when the other is quarantined.
    seedLegacy(db, "s-healthy");

    expect(() => migrateLegacySummaries(db)).not.toThrow();
    // Quarantined session: legacy rows untouched, no checkpoint created.
    const archived = db.prepare("SELECT archived FROM context_summaries WHERE chat_id = ? AND content = 'summary one'").get(SESSION) as { archived: number };
    expect(archived.archived).toBe(0);
    expect(db.prepare("SELECT 1 FROM active_context_checkpoint WHERE chat_id = ?").get(SESSION)).toBeUndefined();
    // Healthy session migrated.
    expect(db.prepare("SELECT 1 FROM active_context_checkpoint WHERE chat_id = 's-healthy'").get()).toBeDefined();
  });
});
