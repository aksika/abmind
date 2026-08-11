/**
 * context-projector.test.ts — #1527 daemon-owned read-only projection:
 * strict cursor exclusivity, user/session ownership, mixed-owner denial,
 * tool pruning, and role mapping.
 */
import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { ContextProjector, ContextProjectionError } from "./context-projector.js";
import { CheckpointStore } from "./context-checkpoint-store.js";

const USER = "user-a";
const SESSION = "s1";

function makeProjector(): { db: Database.Database; projector: ContextProjector } {
  const db = initializeDatabase(":memory:");
  return { db, projector: new ContextProjector(db) };
}

function insert(db: Database.Database, opts: { user?: string; session?: string; role: string; content: string; ts?: number }): number {
  return Number(db.prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
  ).run(opts.user ?? USER, opts.session ?? SESSION, opts.role, opts.content, opts.ts ?? Date.now()).lastInsertRowid);
}

afterEach(() => {
  delete process.env.CONTEXT_TIER_ENABLED;
});

describe("ContextProjector #1527", () => {
  it("returns only prior turns strictly before the cursor, in order", () => {
    const { db, projector } = makeProjector();
    insert(db, { role: "user", content: "turn 1 user" });
    insert(db, { role: "assistant", content: "turn 1 assistant" });
    const current = insert(db, { role: "user", content: "turn 2 user" });

    const result = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: current, maxContext: 100_000 });

    expect(result.messages.map(m => m.content)).toEqual(["turn 1 user", "turn 1 assistant"]);
    expect(result.sourceMessageCount).toBe(2);
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.version).toBe(1);
  });

  it("beforeMessageId is exclusive: the cursor row itself is never returned", () => {
    const { db, projector } = makeProjector();
    insert(db, { role: "user", content: "old1" });
    insert(db, { role: "assistant", content: "old2" });
    const cursor = insert(db, { role: "user", content: "current row" });

    const result = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 100_000 });
    expect(result.messages.map(m => m.content)).toEqual(["old1", "old2"]);
    expect(result.messages.some(m => m.content === "current row")).toBe(false);
  });

  it("rejects a non-user cursor row with cursor_invalid (#1527 binding)", () => {
    const { db, projector } = makeProjector();
    insert(db, { role: "user", content: "history" });
    const assistantCursor = insert(db, { role: "assistant", content: "assistant row used as cursor" });

    expect(() => projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: assistantCursor, maxContext: 100_000 }))
      .toThrowError(new ContextProjectionError("cursor_invalid"));
  });

  it("maps roles to the wire contract set; unknown roles degrade to user", () => {
    const { db, projector } = makeProjector();
    insert(db, { role: "user", content: "u" });
    insert(db, { role: "assistant", content: "a" });
    insert(db, { role: "tool", content: "t" });
    const cursor = insert(db, { role: "user", content: "current" });

    const result = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 100_000 });
    expect(result.messages.map(m => [m.role, m.content])).toEqual([
      ["user", "u"],
      ["assistant", "a"],
      ["tool", "t"],
    ]);
  });

  it("missing cursor row fails closed with cursor_not_found", () => {
    const { db, projector } = makeProjector();
    insert(db, { role: "user", content: "x" });
    expect(() => projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: 9999, maxContext: 100_000 }))
      .toThrowError(new ContextProjectionError("cursor_not_found"));
  });

  it("cursor owned by another user fails closed with cursor_owner_mismatch", () => {
    const { db, projector } = makeProjector();
    insert(db, { role: "user", content: "mine" });
    const other = insert(db, { user: "user-b", role: "user", content: "theirs" });

    expect(() => projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: other, maxContext: 100_000 }))
      .toThrowError(new ContextProjectionError("cursor_owner_mismatch"));
  });

  it("cursor in another session fails closed with cursor_owner_mismatch", () => {
    const { db, projector } = makeProjector();
    const otherSession = insert(db, { session: "s2", role: "user", content: "other session" });

    expect(() => projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: otherSession, maxContext: 100_000 }))
      .toThrowError(new ContextProjectionError("cursor_owner_mismatch"));
  });

  it("mixed-owner session fails closed even when the cursor itself matches", () => {
    const { db, projector } = makeProjector();
    insert(db, { role: "user", content: "mine" });
    insert(db, { user: "user-b", role: "user", content: "foreign row in same session" });
    const cursor = insert(db, { role: "user", content: "current" });

    expect(() => projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 100_000 }))
      .toThrowError(new ContextProjectionError("mixed_owner"));
  });

  it("prunes oversized tool results when the budget is exceeded", () => {
    const { db, projector } = makeProjector();
    insert(db, { role: "user", content: "hello" });
    insert(db, { role: "tool", content: "T".repeat(5000) });
    const cursor = insert(db, { role: "user", content: "ok" });

    const tight = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 100 });
    expect(tight.prunedToolResults).toBeGreaterThan(0);

    const roomy = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 1_000_000 });
    expect(roomy.prunedToolResults).toBe(0);
  });
});

describe("ContextProjector — checkpoint lineage (#1406)", () => {
  it("renders the active checkpoint once plus the append-only suffix below it", () => {
    const { db, projector } = makeProjector();
    insert(db, { role: "user", content: "old turn user" });
    insert(db, { role: "assistant", content: "old turn assistant" });
    const firstKept = insert(db, { role: "user", content: "kept user" });
    insert(db, { role: "assistant", content: "kept assistant" });
    const cursor = insert(db, { role: "user", content: "current" });

    const store = new CheckpointStore(db);
    const id = store.commitCheckpoint(SESSION, {
      previousCheckpointId: null,
      sourceMessageStart: 1,
      sourceMessageEnd: 2,
      firstKeptMessageId: firstKept,
      content: "checkpoint of the old prefix",
      sourceTokenCount: 100,
      checkpointTokenCount: 8,
      sourceDigest: "source-digest",
      checkpointDigest: "cp-digest",
      summarizerModel: null,
      summarizerProvider: null,
      activeRequestModel: "test",
      reason: "manual",
      budgetJson: "{}",
      classification: 1,
      promptVersion: "test",
      schemaVersion: 1,
      serializerVersion: "test",
    }, 0);

    expect(id).toBeGreaterThan(0);
    const result = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 100_000 });
    const contents = result.messages.map(m => m.content);
    // Old prefix appears exactly once, represented by the checkpoint frame.
    expect(contents.filter(c => c.includes("checkpoint of the old prefix")).length).toBe(1);
    expect(contents).toEqual(expect.arrayContaining(["kept user", "kept assistant"]));
    expect(contents.some(c => c.includes("old turn user"))).toBe(false);
    expect(contents.some(c => c === "current")).toBe(false);
    // The current-turn cursor stays exclusive.
    expect(contents.some(c => c === "current")).toBe(false);
  });

  it("without a checkpoint the projection is unchanged (no checkpoint frame)", () => {
    const { db, projector } = makeProjector();
    insert(db, { role: "user", content: "one" });
    insert(db, { role: "assistant", content: "two" });
    const cursor = insert(db, { role: "user", content: "current" });

    const result = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 100_000 });
    expect(result.messages.map(m => m.content)).toEqual(["one", "two"]);
    expect(result.messages.some(m => m.content.includes("[Checkpoint"))).toBe(false);
  });
});
