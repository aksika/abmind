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
import { _resetAbmindEnv } from "./env-schema.js";

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
  delete process.env.CONTEXT_TIER_TAIL;
  delete process.env.CONTEXT_TIER_MIDDLE;
  _resetAbmindEnv();
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

describe("ContextProjector — complete suffix (#1883, resolves #1881)", () => {
  function insertHinted(
    db: Database.Database,
    opts: { role: string; content: string; ts?: number; type?: string | null; topic?: string | null; emotion?: string | null },
  ): number {
    return Number(db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp, type_hint, topic_hint, emotion_hint) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(USER, SESSION, opts.role, opts.content, opts.ts ?? Date.now(), opts.type ?? null, opts.topic ?? null, opts.emotion ?? null).lastInsertRowid);
  }

  function commitPrefixCheckpoint(db: Database.Database, firstKept: number, content: string): void {
    const store = new CheckpointStore(db);
    const id = store.commitCheckpoint(SESSION, {
      previousCheckpointId: null,
      sourceMessageStart: 1,
      sourceMessageEnd: firstKept - 1,
      firstKeptMessageId: firstKept,
      content,
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
  }

  /** Markers alternate hint-bearing and null-hint rows across roles. */
  function insertHistory(db: Database.Database, count: number, tsBase?: number): string[] {
    const markers: string[] = [];
    for (let i = 0; i < count; i++) {
      const marker = `hist-row-${i}-m${i * 7 + 3}`;
      markers.push(marker);
      insertHinted(db, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${marker} with some prose`,
        ts: tsBase !== undefined ? tsBase - i * 1000 : Date.now(),
        type: i % 2 === 0 ? "F" : null,
        topic: i % 3 === 0 ? "coding" : null,
        emotion: null,
      });
    }
    return markers;
  }

  /** Every marker appears exactly once, in durable ID order. */
  function expectCompleteOnce(contents: string[], markers: string[]): void {
    expect(contents.length).toBe(markers.length);
    let lastIdx = -1;
    for (const marker of markers) {
      const at = contents.findIndex(c => c.includes(marker));
      expect(at).toBeGreaterThan(lastIdx);
      expect(contents.filter(c => c.includes(marker)).length).toBe(1);
      lastIdx = at;
    }
  }

  it("A1: 80 rows with default tiers are all represented once (no omission)", () => {
    const { db, projector } = makeProjector();
    const markers = insertHistory(db, 80);
    const cursor = insert(db, { role: "user", content: "current" });

    const result = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 10_000_000 });

    expect(result.sourceMessageCount).toBe(80);
    expectCompleteOnce(result.messages.map(m => m.content), markers);
    expect(result.messages.some(m => m.content === "current")).toBe(false);
  });

  it("A1: tiers off renders the whole suffix verbatim", () => {
    process.env.CONTEXT_TIER_ENABLED = "false";
    _resetAbmindEnv();
    const { db, projector } = makeProjector();
    const markers = insertHistory(db, 80);
    const cursor = insert(db, { role: "user", content: "current" });

    const result = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 10_000_000 });

    expect(result.sourceMessageCount).toBe(80);
    expect(result.messages.map(m => m.content)).toEqual(
      markers.map(marker => `message ${marker} with some prose`),
    );
  });

  it("A1: small tiers split tail/middle/older-raw without dropping rows", () => {
    process.env.CONTEXT_TIER_TAIL = "5";
    process.env.CONTEXT_TIER_MIDDLE = "10";
    _resetAbmindEnv();
    const { db, projector } = makeProjector();
    const markers = insertHistory(db, 80);
    const cursor = insert(db, { role: "user", content: "current" });

    const result = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 10_000_000 });

    expect(result.sourceMessageCount).toBe(80);
    expectCompleteOnce(result.messages.map(m => m.content), markers);
    // Newest 5 verbatim, next 10 ABM-L rendered, older 65 verbatim fallback.
    const tail = result.messages.slice(-5).map(m => m.content);
    expect(tail).toEqual(markers.slice(-5).map(marker => `message ${marker} with some prose`));
  });

  it("A1: sparse IDs and non-monotonic timestamps keep ID order", () => {
    const { db, projector } = makeProjector();
    // Decreasing timestamps as IDs grow: order must still follow IDs.
    const markers = insertHistory(db, 75, Date.now());
    db.prepare(`DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE session_id = ? AND (content LIKE 'message hist-row-10-%' OR content LIKE 'message hist-row-40-%'))`).run(SESSION);
    const remaining = markers.filter((_, i) => i !== 10 && i !== 40);
    const cursor = insert(db, { role: "user", content: "current" });

    const result = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 10_000_000 });

    expect(result.sourceMessageCount).toBe(73);
    expectCompleteOnce(result.messages.map(m => m.content), remaining);
  });

  it("A1: post-checkpoint suffix over the tier horizon is complete", () => {
    const { db, projector } = makeProjector();
    const prefixMarkers: string[] = [];
    for (let i = 0; i < 10; i++) {
      prefixMarkers.push(`prefix-row-${i}`);
      insertHinted(db, { role: "user", content: `covered ${prefixMarkers[i]}` });
    }
    const suffixMarkers = insertHistory(db, 75);
    const firstKeptRow = db.prepare("SELECT id as id FROM messages WHERE content LIKE 'message hist-row-0-%'").get() as { id: number };
    commitPrefixCheckpoint(db, firstKeptRow.id, "checkpoint of the covered prefix");
    const cursor = insert(db, { role: "user", content: "current" });

    const result = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 10_000_000 });
    const contents = result.messages.map(m => m.content);

    expect(result.sourceMessageCount).toBe(75);
    expect(contents.filter(c => c.includes("checkpoint of the covered prefix")).length).toBe(1);
    for (const marker of prefixMarkers) {
      expect(contents.some(c => c.includes(marker))).toBe(false);
    }
    expectCompleteOnce(contents.filter(c => !c.includes("checkpoint of the covered prefix")), suffixMarkers);
    expect(contents.some(c => c === "current")).toBe(false);
  });

  it("A2: 200-row suffix uses the newest 60 as the recent region", () => {
    const { db, projector } = makeProjector();
    insertHistory(db, 200);
    const cursor = insert(db, { role: "user", content: "current" });
    // Recent region = max(12, min(200, 60)) = 60 → indexes 140..199.
    // A unique large tool result just outside is cleared; one inside is trimmed.
    const outside = "OUTSIDE-TOOL-" + "x".repeat(300) + "\n" + Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    const inside = "INSIDE-TOOL-" + "y".repeat(300) + "\n" + Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    db.prepare("UPDATE messages SET role = 'tool', content = ? WHERE content LIKE ?").run(outside, "%hist-row-139-%");
    db.prepare("UPDATE messages SET role = 'tool', content = ? WHERE content LIKE ?").run(inside, "%hist-row-199-%");

    const result = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 100 });
    const contents = result.messages.map(m => m.content);

    expect(result.sourceMessageCount).toBe(200);
    expect(contents.length).toBe(200);
    expect(contents.some(c => c.includes("[tool:tool] (cleared"))).toBe(true);
    expect(contents.some(c => c.includes("OUTSIDE-TOOL-"))).toBe(false);
    expect(contents.some(c => c.includes("INSIDE-TOOL-") && c.includes("trimmed"))).toBe(true);
    expect(result.prunedToolResults).toBeGreaterThan(0);
    // Token estimate equals the final framed/rendered/pruned messages.
    const expected = contents.reduce((s, c) => s + Math.ceil(c.length / 4), 0);
    expect(result.estimatedTokens).toBe(expected);
  });

  it("A2: checkpoint content is unchanged by pruning; aggressive mode clears inside the region", () => {
    const { db, projector } = makeProjector();
    const oldTs = Date.now() - 2 * 60 * 60 * 1000; // >1h gap → aggressive
    insertHinted(db, { role: "user", content: "covered old", ts: oldTs });
    insertHistory(db, 200, oldTs);
    const firstKeptRow = db.prepare("SELECT id as id FROM messages WHERE content LIKE 'message hist-row-0-%'").get() as { id: number };
    commitPrefixCheckpoint(db, firstKeptRow.id, "stable checkpoint content");
    const cursor = insert(db, { role: "user", content: "current" });
    const big = "BIG-TOOL-" + "z".repeat(300) + "\n" + Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    db.prepare("UPDATE messages SET role = 'tool', content = ? WHERE content LIKE ?").run(big, "%hist-row-199-%");

    const result = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 10_000_000 });
    const contents = result.messages.map(m => m.content);

    expect(result.sourceMessageCount).toBe(200);
    expect(contents.filter(c => c.includes("stable checkpoint content")).length).toBe(1);
    expect(contents[0]).toContain("stable checkpoint content");
    // Aggressive: even the inside-region tool result is cleared, not trimmed.
    expect(contents.some(c => c.includes("[tool:tool] (cleared"))).toBe(true);
    expect(contents.some(c => c.includes("BIG-TOOL-"))).toBe(false);
    expect(contents.length).toBe(201); // frame + 200 suffix rows
  });

  it("A2: duplicate large tool results collapse to one surviving copy", () => {
    const { db, projector } = makeProjector();
    insertHinted(db, { role: "user", content: "hello" });
    const dup = "DUP-TOOL-" + "q".repeat(300);
    insertHinted(db, { role: "tool", content: dup });
    insertHinted(db, { role: "assistant", content: "between" });
    insertHinted(db, { role: "tool", content: dup });
    const cursor = insert(db, { role: "user", content: "current" });

    const result = projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 100 });
    const contents = result.messages.map(m => m.content);

    expect(contents.length).toBe(4);
    expect(contents.filter(c => c === "[dup]").length).toBe(1);
    expect(contents.filter(c => c.includes("DUP-TOOL-")).length).toBe(1);
  });

  it("A3: foreign row outside the selected suffix still fails closed", () => {
    const { db, projector } = makeProjector();
    insert(db, { role: "user", content: "mine" });
    const cursor = insert(db, { role: "user", content: "current" });
    // Foreign row after the cursor: outside every selectable suffix.
    insert(db, { user: "user-b", role: "user", content: "foreign later row" });

    expect(() => projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 100_000 }))
      .toThrowError(new ContextProjectionError("mixed_owner"));
  });

  it("A5: active legacy summaries without a checkpoint fail closed", () => {
    const { db, projector } = makeProjector();
    insert(db, { role: "user", content: "history" });
    const cursor = insert(db, { role: "user", content: "current" });
    db.prepare(
      "INSERT INTO context_summaries (chat_id, depth, content, token_estimate, source_message_start, source_message_end, classification, model, created_at) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)",
    ).run(SESSION, "legacy summary", 10, 1, 1, 1, null, Date.now());

    expect(() => projector.project({ userId: USER, sessionId: SESSION, beforeMessageId: cursor, maxContext: 100_000 }))
      .toThrowError(new ContextProjectionError("legacy_lineage_unavailable"));
  });
});
