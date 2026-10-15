/**
 * Regression test for #180: advanceExtractionWatermarks must use the
 * per-row user_id from the DISTINCT loop, not a hardcoded string.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./memory-db.js";
import { ensureInitialized } from "./ensure-initialized.js";
import { setPersonalState } from "./personal-schema.js";
import { createEpisode } from "./personal-episodes.js";
import { SleepDataAccess } from "./sleep-data-access.js";
import type Database from "better-sqlite3";
import { _resetAbmindEnv } from "./env-schema.js";

let tmpDir: string;
let db: Database.Database;
let sleep: SleepDataAccess;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sda-180-"));
  db = initializeDatabase(join(tmpDir, "memory.db"));
  ensureInitialized(db, tmpDir);
  setPersonalState(db, "ready", { reason: "test ready" });
  sleep = new SleepDataAccess(db);
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("#1860 advanceExtractionWatermarks is primary-only", () => {
  it("advances only the supplied principal; other principals keep their watermark", () => {
    const now = Date.now();
    const insert = db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 'test-session', 'user', ?, ?)",
    );
    insert.run("alice", "hi from alice", now - 3000);
    insert.run("bob", "hi from bob", now - 2000);
    insert.run("alice", "another from alice", now - 1000);

    const count = sleep.advanceExtractionWatermarks(now, "alice");
    expect(count).toBe(1);

    const rows = db
      .prepare("SELECT user_id, last_processed_timestamp FROM extraction_watermarks ORDER BY user_id")
      .all() as { user_id: string; last_processed_timestamp: number }[];

    const alice = rows.find(r => r.user_id === "alice");
    expect(alice?.last_processed_timestamp).toBe(now);
    // Bob was never read: no watermark row is created for him, and a later
    // flush must not treat his messages as processed.
    expect(rows.find(r => r.user_id === "bob")).toBeUndefined();
  });

  it("never moves another principal's existing watermark", () => {
    const now = Date.now();
    db.prepare("INSERT INTO extraction_watermarks (user_id, last_processed_timestamp) VALUES (?, ?)")
      .run("bob", now - 60_000);
    sleep.advanceExtractionWatermarks(now, "alice");
    const bob = db
      .prepare("SELECT last_processed_timestamp FROM extraction_watermarks WHERE user_id = 'bob'")
      .get() as { last_processed_timestamp: number };
    expect(bob.last_processed_timestamp).toBe(now - 60_000);
  });
});

describe("#1603 watermark integrity", () => {
  it("never lowers an existing watermark when a lower throughTs is passed", () => {
    const now = Date.now();
    sleep.advanceExtractionWatermarks(now, "alice");
    sleep.advanceExtractionWatermarks(now, "bob");
    sleep.advanceExtractionWatermarks(now - 10_000, "alice");
    sleep.advanceExtractionWatermarks(now - 10_000, "bob");

    const rows = db
      .prepare("SELECT user_id, last_processed_timestamp FROM extraction_watermarks ORDER BY user_id")
      .all() as { user_id: string; last_processed_timestamp: number }[];

    for (const r of rows) expect(r.last_processed_timestamp).toBe(now);
  });

  it("flushOldMessages leaves every message above its user's watermark in place", () => {
    // #1930 C3: retention is exchange-aware. Complete exchanges (user +
    // assistant in the same session) with settled coverage and preserved
    // episode evidence are prunable; unfinished rows stay retained.
    const insert = db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 'test-session', ?, ?, ?)",
    );
    const now = Date.now();
    const old = now - 30 * 86400000; // 30 days ago — past maxAgeDays=7
    const id1u = Number(insert.run("carol", "user", "old extracted", old).lastInsertRowid);
    const id1a = Number(insert.run("carol", "assistant", "old reply", old + 500).lastInsertRowid);
    const id2u = Number(insert.run("carol", "user", "recent unextracted", now - 1000).lastInsertRowid);
    const id2a = Number(insert.run("carol", "assistant", "recent reply", now - 500).lastInsertRowid);
    createEpisode(db, {
      userId: "carol", topic: "t", startTs: old, endTs: old + 500, sessionIds: ["test-session"],
      sourceMessageIds: [id1u, id1a],
      evidenceExcerpts: [
        { messageId: id1u, excerpt: "old extracted", classification: 1 },
        { messageId: id1a, excerpt: "old reply", classification: 1 },
      ],
      actorId: "test",
    });

    // carol's watermark sits between the two exchanges: the old one is below
    // it (deletable when over target), the recent one is above it.
    sleep.advanceExtractionWatermarks(old + 1000, "carol");

    const result = sleep.flushOldMessages({ maxAgeDays: 7, maxCount: 500, userId: "carol", coveredThroughTs: old + 1000, targetExchanges: 1 });
    expect(result.agedOut).toBeGreaterThanOrEqual(1);

    const remaining = db
      .prepare("SELECT id FROM messages WHERE user_id = 'carol' ORDER BY id")
      .all() as { id: number }[];
    expect(remaining).toContainEqual({ id: id2u });
    expect(remaining).toContainEqual({ id: id2a });
    expect(remaining).not.toContainEqual({ id: id1u });
  });

  it("the count cap deletes only messages at or below the watermark", () => {
    // #1930 C3: the exchange budget replaces the row-count cap. Five complete
    // exchanges with settled coverage and episode evidence; the target keeps
    // the newest back, deleting only eligible exchanges at/below the watermark.
    const insert = db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 'test-session', ?, ?, ?)",
    );
    const now = Date.now();
    const daveIds: number[] = [];
    for (let i = 0; i < 5; i++) {
      const u = Number(insert.run("dave", "user", `msg ${i}`, now - (10 - i) * 60_000).lastInsertRowid);
      const a = Number(insert.run("dave", "assistant", `reply ${i}`, now - (10 - i) * 60_000 + 1000).lastInsertRowid);
      daveIds.push(u, a);
      createEpisode(db, {
        userId: "dave", topic: `t${i}`, startTs: now - (10 - i) * 60_000, endTs: now - (10 - i) * 60_000 + 1000,
        sessionIds: ["test-session"], sourceMessageIds: [u, a],
        evidenceExcerpts: [
          { messageId: u, excerpt: `msg ${i}`, classification: 1 },
          { messageId: a, excerpt: `reply ${i}`, classification: 1 },
        ],
        actorId: "test",
      });
    }
    sleep.advanceExtractionWatermarks(now, "dave");

    const result = sleep.flushOldMessages({ maxAgeDays: 0, maxCount: 100000, userId: "dave", coveredThroughTs: now, targetExchanges: 3 });
    expect(result.capped + result.agedOut).toBeGreaterThanOrEqual(2);

    const remaining = db
      .prepare("SELECT COUNT(*) as c FROM messages WHERE user_id = 'dave'")
      .get() as { c: number };
    expect(remaining.c).toBeLessThan(10);

    // The invariant is one-directional: pruning respects the exchange budget
    // (newest 3 exchanges retained) and never deletes above the watermark
    // without coverage. The two oldest eligible exchanges prune.
    expect(remaining.c).toBe(6);
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

  it("resolves the saved manifest identity when ABMIND_USER_ID is absent", () => {
    const savedHome = process.env.ABMIND_HOME;
    const savedUserId = process.env.ABMIND_USER_ID;
    try {
      process.env.ABMIND_HOME = tmpDir;
      writeFileSync(join(tmpDir, "manifest.json"), JSON.stringify({ encryptionUser: "manifest-user" }));
      delete process.env.ABMIND_USER_ID;
      _resetAbmindEnv();

      expect(sleep.getPrimaryUserId()).toBe("manifest-user");
      expect(process.env.ABMIND_USER_ID).toBe("manifest-user");
    } finally {
      rmSync(join(tmpDir, "manifest.json"), { force: true });
      if (savedHome === undefined) delete process.env.ABMIND_HOME;
      else process.env.ABMIND_HOME = savedHome;
      if (savedUserId === undefined) delete process.env.ABMIND_USER_ID;
      else process.env.ABMIND_USER_ID = savedUserId;
      _resetAbmindEnv();
    }
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

describe("#1658 strict-owner Dreamy seam — foreign rows never leak", () => {
  const PRIMARY = "aksika";
  const FOREIGN = "adrika";

  function insertMemory(owner: string, content: string, overrides: Partial<Record<string, unknown>> = {}): number {
    const now = Date.now();
    const result = db.prepare(
      `INSERT INTO extracted_memories
         (user_id, content_original, content_en, memory_type, source_timestamp, created_at,
          emotion_score, classification, trust, emotion_tags, recall_count, confidence, tier, valid_to)
       VALUES (?, ?, ?, 'fact', ?, ?, 0, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      owner, content, content, now, now,
      overrides.classification ?? 1,
      overrides.trust ?? 0,
      overrides.emotion_tags ?? null,
      overrides.recall_count ?? 0,
      overrides.confidence ?? 3,
      overrides.tier ?? "general",
    );
    return Number(result.lastInsertRowid);
  }

  it("candidate lists and REM sample contain only the owner's rows", () => {
    insertMemory(PRIMARY, "owner flagship memory", { trust: 3, emotion_tags: "joy", recall_count: 3 });
    insertMemory(FOREIGN, "foreign sentinel memory", { trust: 3, emotion_tags: "joy", recall_count: 3 });
    insertMemory(PRIMARY, "legacy-secret-plaintext", { classification: 3, trust: 3, emotion_tags: "joy", recall_count: 3 });

    const lists = sleep.buildSleepCandidates("model-x", PRIMARY);
    expect(lists.promotionCandidates).toContain("owner flagship");
    expect(lists.promotionCandidates).not.toContain("foreign sentinel");
    expect(lists.untaggedMemories).not.toContain("foreign sentinel");
    expect(JSON.stringify(lists)).not.toContain("legacy-secret-plaintext");

    const rem = sleep.getRemSample(PRIMARY, 20);
    expect(rem.map(r => r.content_en)).toContain("owner flagship memory");
    expect(rem.map(r => r.content_en)).not.toContain("foreign sentinel");
    expect(rem.map(r => r.content_en)).not.toContain("legacy-secret-plaintext");

    const profile = sleep.getEmotionalProfileData(PRIMARY);
    expect(profile.flatMap(e => [e.topic])).not.toContain("general");
    expect(JSON.stringify(profile)).not.toContain("foreign sentinel");
  });

  it("contradiction evidence and candidates are owner-scoped", () => {
    const foreignId = insertMemory(FOREIGN, "foreign contradiction evidence", { trust: 2 });
    insertMemory(PRIMARY, "owner evidence row", { trust: 2 });

    const evidence = sleep.getContradictionEvidence(PRIMARY, 0);
    expect(evidence.map(r => r.id)).not.toContain(foreignId);

    // An FTS candidate search for a shared keyword must not surface the
    // foreign row even though it matches.
    const candidates = sleep.getContradictionCandidates(PRIMARY, "contradiction OR evidence", 0, 1, 20);
    expect(candidates.map(r => r.id)).not.toContain(foreignId);
  });

  it("foreign contradiction and decay targets are invisible and ineligible", () => {    const foreignId = insertMemory(FOREIGN, "foreign target memory", { memory_type: "event" });

    const contradictionTarget = sleep.getContradictionTarget(PRIMARY, foreignId);
    expect(contradictionTarget).toBeUndefined();

    const decayCandidates = sleep.getDecayCandidates(PRIMARY, Date.now() + 1);
    expect(decayCandidates.map(r => r.id)).not.toContain(foreignId);

    // Eligibility stays atomic on (id, user_id, semantic_revision): an
    // invalidation attempt under the primary owner must not touch the row.
    const before = db.prepare("SELECT valid_to FROM extracted_memories WHERE id = ?").get(foreignId) as { valid_to: string | null };
    const result = sleep.invalidateMemory(PRIMARY, foreignId, 1, "2026-08-14", "sleep:test");
    expect(result.ok).toBe(false);
    const after = db.prepare("SELECT valid_to FROM extracted_memories WHERE id = ?").get(foreignId) as { valid_to: string | null };
    expect(after.valid_to).toBe(before.valid_to);
  });
});

describe("#1860 prune gating: claims authorize deletion", () => {
  it("never deletes non-consumed session types, even below the watermark", () => {
    // #1930 C3: complete exchanges only. Worker sessions stay outside the
    // eligible budget; consumed exchanges with episode evidence prune.
    const now = Date.now();
    const old = now - 30 * 86400000;
    const insert = db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    );
    // A worker/orc session type sleep does not consume (>= 2 underscores,
    // no _A_/_C_ marker) plus a consumed control exchange, both old/covered.
    const workerU = Number(insert.run("erin", "sess_W_1", "user", "worker turn never read by sleep", old).lastInsertRowid);
    const workerA = Number(insert.run("erin", "sess_W_1", "assistant", "worker reply", old + 500).lastInsertRowid);
    const controlU = Number(insert.run("erin", "plain", "user", "consumed control row", old).lastInsertRowid);
    const controlA = Number(insert.run("erin", "plain", "assistant", "control reply", old + 500).lastInsertRowid);
    // Second consumed exchange keeps the target from retaining everything.
    const keepU = Number(insert.run("erin", "plain", "user", "keep row", now - 1000).lastInsertRowid);
    const keepA = Number(insert.run("erin", "plain", "assistant", "keep reply", now - 500).lastInsertRowid);
    createEpisode(db, {
      userId: "erin", topic: "control", startTs: old, endTs: old + 500, sessionIds: ["plain"],
      sourceMessageIds: [controlU, controlA],
      evidenceExcerpts: [
        { messageId: controlU, excerpt: "consumed control row", classification: 1 },
        { messageId: controlA, excerpt: "control reply", classification: 1 },
      ],
      actorId: "test",
    });
    createEpisode(db, {
      userId: "erin", topic: "keep", startTs: now - 1000, endTs: now - 500, sessionIds: ["plain"],
      sourceMessageIds: [keepU, keepA],
      evidenceExcerpts: [
        { messageId: keepU, excerpt: "keep row", classification: 1 },
        { messageId: keepA, excerpt: "keep reply", classification: 1 },
      ],
      actorId: "test",
    });
    sleep.advanceExtractionWatermarks(now, "erin");

    const result = sleep.flushOldMessages({ maxAgeDays: 7, maxCount: 100000, userId: "erin", coveredThroughTs: now, targetExchanges: 1 });
    expect(result.agedOut).toBeGreaterThanOrEqual(1);

    const remaining = db.prepare("SELECT id FROM messages WHERE user_id = 'erin'").all() as { id: number }[];
    expect(remaining).toContainEqual({ id: workerU });
    expect(remaining).toContainEqual({ id: workerA });
    expect(remaining).not.toContainEqual({ id: controlU });
  });

  it("deletes [SYSTEM rows below the watermark through the explicit exclusion", () => {
    const now = Date.now();
    const old = now - 30 * 86400000;
    // A non-consumed session type that the scope guard alone would retain:
    // the [SYSTEM prefix is what makes it deletable.
    const id = db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 'sess_W_2', 'user', ?, ?)",
    ).run("frank", "[SYSTEM notice] transient state", old).lastInsertRowid;
    sleep.advanceExtractionWatermarks(now, "frank");

    const result = sleep.flushOldMessages({ maxAgeDays: 7, maxCount: 500, userId: "frank", coveredThroughTs: null });
    expect(result.agedOut).toBeGreaterThanOrEqual(1);
    const remaining = db.prepare("SELECT id FROM messages WHERE id = ?").get(Number(id));
    expect(remaining).toBeUndefined();
  });

  it("a secondary principal's rows survive the age and cap sweeps after a primary-only advance", () => {
    // #1930 C3: pruning never crosses principal ownership. Complete
    // exchanges per principal with episode evidence; only harry prunes.
    const now = Date.now();
    const old = now - 30 * 86400000;
    const insert = db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 'plain', ?, ?, ?)",
    );
    const foreignU = Number(insert.run("gail", "user", "foreign old message", old).lastInsertRowid);
    const foreignA = Number(insert.run("gail", "assistant", "foreign reply", old + 500).lastInsertRowid);
    const harryU = Number(insert.run("harry", "user", "primary old message", old).lastInsertRowid);
    const harryA = Number(insert.run("harry", "assistant", "primary reply", old + 500).lastInsertRowid);
    const harryKeepU = Number(insert.run("harry", "user", "primary keep", now - 1000).lastInsertRowid);
    const harryKeepA = Number(insert.run("harry", "assistant", "primary keep reply", now - 500).lastInsertRowid);
    createEpisode(db, {
      userId: "harry", topic: "old", startTs: old, endTs: old + 500, sessionIds: ["plain"],
      sourceMessageIds: [harryU, harryA],
      evidenceExcerpts: [
        { messageId: harryU, excerpt: "primary old message", classification: 1 },
        { messageId: harryA, excerpt: "primary reply", classification: 1 },
      ],
      actorId: "test",
    });
    createEpisode(db, {
      userId: "harry", topic: "keep", startTs: now - 1000, endTs: now - 500, sessionIds: ["plain"],
      sourceMessageIds: [harryKeepU, harryKeepA],
      evidenceExcerpts: [
        { messageId: harryKeepU, excerpt: "primary keep", classification: 1 },
        { messageId: harryKeepA, excerpt: "primary keep reply", classification: 1 },
      ],
      actorId: "test",
    });
    // A watermark left by the old cross-principal fan-out is not proof that
    // this run read gail's messages.
    sleep.advanceExtractionWatermarks(now, "gail");
    // This run advances only harry; gail keeps the stale historical watermark.
    sleep.advanceExtractionWatermarks(now, "harry");

    const result = sleep.flushOldMessages({ maxAgeDays: 7, maxCount: 100000, userId: "harry", coveredThroughTs: now, targetExchanges: 1 });
    expect(result.agedOut).toBeGreaterThanOrEqual(1);
    const remaining = db.prepare("SELECT id FROM messages WHERE id = ?").get(foreignU);
    expect(remaining).toBeDefined();
    const foreignStill = db.prepare("SELECT id FROM messages WHERE id = ?").get(foreignA);
    expect(foreignStill).toBeDefined();
  });
});
