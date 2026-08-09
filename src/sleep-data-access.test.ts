/**
 * Regression test for #180: advanceExtractionWatermarks must use the
 * per-row user_id from the DISTINCT loop, not a hardcoded string.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./memory-db.js";
import { SleepDataAccess } from "./sleep-data-access.js";
import type Database from "better-sqlite3";

let tmpDir: string;
let db: Database.Database;
let sleep: SleepDataAccess;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sda-180-"));
  db = initializeDatabase(join(tmpDir, "memory.db"));
  sleep = new SleepDataAccess(db);
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("#180 advanceExtractionWatermarks uses per-user id", () => {
  it("writes a row keyed on each distinct user_id from messages", () => {
    const now = Date.now();
    const insert = db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 'test-session', 'user', ?, ?)",
    );
    insert.run("alice", "hi from alice", now - 3000);
    insert.run("bob", "hi from bob", now - 2000);
    insert.run("alice", "another from alice", now - 1000);

    const count = sleep.advanceExtractionWatermarks(now);
    expect(count).toBe(2);

    const rows = db
      .prepare("SELECT user_id, last_processed_timestamp FROM extraction_watermarks ORDER BY user_id")
      .all() as { user_id: string; last_processed_timestamp: number }[];

    expect(rows).toHaveLength(2);
    expect(rows[0]!.user_id).toBe("alice");
    expect(rows[1]!.user_id).toBe("bob");
    expect(rows[0]!.last_processed_timestamp).toBe(now);
    expect(rows[1]!.last_processed_timestamp).toBe(now);
  });
});

describe("#1603 watermark integrity", () => {
  it("never lowers an existing watermark when a lower throughTs is passed", () => {
    const now = Date.now();
    sleep.advanceExtractionWatermarks(now);
    sleep.advanceExtractionWatermarks(now - 10_000);

    const rows = db
      .prepare("SELECT user_id, last_processed_timestamp FROM extraction_watermarks ORDER BY user_id")
      .all() as { user_id: string; last_processed_timestamp: number }[];

    for (const r of rows) expect(r.last_processed_timestamp).toBe(now);
  });

  it("flushOldMessages leaves every message above its user's watermark in place", () => {
    const insert = db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 'test-session', 'user', ?, ?)",
    );
    const now = Date.now();
    const old = now - 30 * 86400000; // 30 days ago — past maxAgeDays=7
    const id1 = insert.run("carol", "old extracted", old).lastInsertRowid;
    const id2 = insert.run("carol", "recent unextracted", now - 1000).lastInsertRowid;

    // carol's watermark sits between the two messages: the old one is below it
    // (deletable), the recent one is above it (protected).
    sleep.advanceExtractionWatermarks(old + 1);

    const result = sleep.flushOldMessages({ maxAgeDays: 7, maxCount: 500 });
    expect(result.agedOut).toBeGreaterThanOrEqual(1);

    const remaining = db
      .prepare("SELECT id FROM messages ORDER BY id")
      .all() as { id: number }[];
    expect(remaining).toContainEqual({ id: Number(id2) });
    expect(remaining).not.toContainEqual({ id: Number(id1) });
  });

  it("the count cap deletes only messages at or below the watermark", () => {
    const insert = db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 'test-session', 'user', ?, ?)",
    );
    const now = Date.now();
    const existing = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c;
    // Ten messages, only the oldest four are below the watermark.
    for (let i = 0; i < 10; i++) insert.run("dave", `msg ${i}`, now - (10 - i) * 60_000);
    sleep.advanceExtractionWatermarks(now - 6 * 60_000);

    const result = sleep.flushOldMessages({ maxAgeDays: 7, maxCount: existing + 8 });
    expect(result.capped).toBe(2);

    const remaining = db
      .prepare("SELECT COUNT(*) as c FROM messages WHERE user_id = 'dave'")
      .get() as { c: number };
    expect(remaining.c).toBe(8);

    // The invariant is one-directional: no message ABOVE the watermark was
    // deleted. All five newest dave messages must survive.
    const above = db
      .prepare("SELECT COUNT(*) as c FROM messages m WHERE m.user_id = 'dave' AND m.timestamp > (SELECT w.last_processed_timestamp FROM extraction_watermarks w WHERE w.user_id = 'dave')")
      .get() as { c: number };
    expect(above.c).toBe(5);
  });
});

describe("#1608 getPrimaryUserId — canonical identity only", () => {
  const savedUserId = process.env.ABMIND_USER_ID;

  afterAll(() => {
    if (savedUserId === undefined) delete process.env.ABMIND_USER_ID;
    else process.env.ABMIND_USER_ID = savedUserId;
  });

  it("returns the canonical ABMIND_USER_ID even when another user's row comes first in the DB", () => {
    // adrika's row sits alongside many other users' rows (alice/bob/carol/
    // dave from earlier tests) — the old `SELECT DISTINCT user_id LIMIT 1`
    // fallback would have picked whichever row happened to come first while
    // aksika's messages went unread.
    db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 's', 'user', ?, ?)")
      .run("adrika", "old adrika row", Date.now() - 5000);
    process.env.ABMIND_USER_ID = "aksika";
    expect(sleep.getPrimaryUserId()).toBe("aksika");
  });

  it("throws a clear configuration error when ABMIND_USER_ID is missing, even with message rows present", () => {
    delete process.env.ABMIND_USER_ID;
    expect(() => sleep.getPrimaryUserId()).toThrow(/ABMIND_USER_ID/);
  });

  it("never falls back to the first user row in the database", () => {
    // Messages exist from other users — the pre-#1608 LIMIT-1 fallback would
    // have silently selected one of them. Missing identity must fail loudly.
    delete process.env.ABMIND_USER_ID;
    const anyRow = db.prepare("SELECT user_id FROM messages LIMIT 1").get() as { user_id: string } | undefined;
    expect(anyRow).toBeDefined();
    expect(() => sleep.getPrimaryUserId()).toThrow();
  });
});

describe("#1608 getMessagesAfter — primary-user scope", () => {
  it("excludes another user's messages when a user id is supplied", () => {
    const boundary = Date.now() - 1_000;
    const insert = db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 'scope-test', 'user', ?, ?)",
    );
    insert.run("aksika", "primary-user message", boundary + 100);
    insert.run("adrika", "other-user message", boundary + 200);

    const messages = sleep.getMessagesAfter(boundary, "aksika");
    expect(messages.map(m => m.content)).toContain("primary-user message");
    expect(messages.map(m => m.content)).not.toContain("other-user message");
  });
});
