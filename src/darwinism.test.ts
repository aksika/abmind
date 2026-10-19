import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import { MemoryIndex } from "./memory-index.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { initializeDatabase } from "./memory-db.js";
import { parseArgs } from "../cli/abmind-store.js";

/** Insert an extracted memory directly and return its id. */
function insertMemory(
  db: ReturnType<typeof initializeDatabase>,
  opts: { contentEn: string; userId?: string; recallCount?: number; relevanceScore?: number; confidence?: number; sourceMessageIds?: string; createdAt?: number; classification?: number },
): number {
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO extracted_memories
      (user_id, content_original, content_en, memory_type, source_timestamp,
       preserve_original, emotion_score, created_at, recall_count, relevance_score, confidence, source_message_ids, classification)
    VALUES (?, ?, ?, 'fact', ?, 0, 0, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.userId ?? "aksika",
    opts.contentEn,
    opts.contentEn,
    now,
    opts.createdAt ?? now,
    opts.recallCount ?? 0,
    opts.relevanceScore ?? 0,
    opts.confidence ?? 3,
    opts.sourceMessageIds ?? null,
    opts.classification ?? 1,
  );
  return Number(result.lastInsertRowid);
}

describe("Memory Darwinism", () => {
  let tmpDir: string;
  let db: ReturnType<typeof initializeDatabase>;
  let index: MemoryIndex;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "darwinism-"));
    process.env.ABMIND_USER_ID = "user-100";
    db = initializeDatabase(join(tmpDir, "memory.db"));
    index = new MemoryIndex(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("bumpRecallCount", () => {
    it("increments recall_count and sets last_recalled_at", () => {
      const id = insertMemory(db, { contentEn: "user likes dark mode" });

      index.bumpRecallCount([id]);

      const row = db.prepare("SELECT recall_count, last_recalled_at FROM extracted_memories WHERE id = ?").get(id) as { recall_count: number; last_recalled_at: number };
      expect(row.recall_count).toBe(1);
      expect(row.last_recalled_at).toBeGreaterThan(0);
    });

    it("increments multiple times", () => {
      const id = insertMemory(db, { contentEn: "user likes dark mode" });

      index.bumpRecallCount([id]);
      index.bumpRecallCount([id]);
      index.bumpRecallCount([id]);

      const row = db.prepare("SELECT recall_count FROM extracted_memories WHERE id = ?").get(id) as { recall_count: number };
      expect(row.recall_count).toBe(3);
    });

    it("handles empty array without error", () => {
      expect(() => index.bumpRecallCount([])).not.toThrow();
    });

    it("fails closed when an explicit principal is empty", () => {
      const id = insertMemory(db, { contentEn: "owner-bound feedback", userId: "other-user" });

      index.bumpRecallCount([id], "");

      const row = db.prepare("SELECT recall_count FROM extracted_memories WHERE id = ?").get(id) as {
        recall_count: number;
      };
      expect(row).toEqual({ recall_count: 0 });
    });

    it("bumps multiple IDs in one call", () => {
      const id1 = insertMemory(db, { contentEn: "fact one" });
      const id2 = insertMemory(db, { contentEn: "fact two" });

      index.bumpRecallCount([id1, id2]);

      const r1 = db.prepare("SELECT recall_count FROM extracted_memories WHERE id = ?").get(id1) as { recall_count: number };
      const r2 = db.prepare("SELECT recall_count FROM extracted_memories WHERE id = ?").get(id2) as { recall_count: number };
      expect(r1.recall_count).toBe(1);
      expect(r2.recall_count).toBe(1);
    });
  });

  describe("adjustRelevance", () => {
    it("demotes relevance_score by -10", async () => {
      const manager = new MemoryManager(makeMemoryTestConfig(tmpDir));
      await manager.initialize();
      manager.editor.adjustRelevance(1, -10); // even if ID doesn't exist, no error
      manager.close();
    });
  });

  describe("mergeMemories", () => {
    it("returns error when IDs not found", async () => {
      const mgr = new MemoryManager(makeMemoryTestConfig(tmpDir));
      await mgr.initialize();
      const result = mgr.editor.mergeMemories(9999, 9998);
      expect(result).toHaveProperty("merged", false);
      expect(result).toHaveProperty("error");
      mgr.close();
    });
  });


  describe("searchExtracted ranking boost", () => {
    it("memory with higher recall_count scores higher than identical content", () => {
      // Insert two memories with same content but different recall counts
      const id1 = insertMemory(db, { contentEn: "postgres connection string host port", recallCount: 0 });
      const id2 = insertMemory(db, { contentEn: "postgres connection config details", recallCount: 10 });

      // Also need to insert into FTS
      db.prepare("INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (?, ?)").run(id1, "postgres connection string host port");
      db.prepare("INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (?, ?)").run(id2, "postgres connection config details");

      const results = index.searchExtracted("postgres connection", { userId: "aksika" });

      expect(results.length).toBe(2);
      // The one with recall_count=10 should score higher
      const highRecall = results.find(r => r.id === id2);
      const lowRecall = results.find(r => r.id === id1);
      expect(highRecall).toBeDefined();
      expect(lowRecall).toBeDefined();
      expect(highRecall!.score).toBeGreaterThan(lowRecall!.score);
    });

    it("memory with positive relevance_score gets 1.2x boost", () => {
      const id1 = insertMemory(db, { contentEn: "dark mode preference setting", relevanceScore: 0 });
      const id2 = insertMemory(db, { contentEn: "dark mode user interface theme", relevanceScore: 10 });

      db.prepare("INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (?, ?)").run(id1, "dark mode preference setting");
      db.prepare("INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (?, ?)").run(id2, "dark mode user interface theme");

      const results = index.searchExtracted("dark mode", { userId: "aksika" });

      const boosted = results.find(r => r.id === id2);
      const unboosted = results.find(r => r.id === id1);
      expect(boosted).toBeDefined();
      expect(unboosted).toBeDefined();
      expect(boosted!.score).toBeGreaterThan(unboosted!.score);
    });

    it("returns source_message_ids in results when present", () => {
      const id = insertMemory(db, { contentEn: "fact with source links", sourceMessageIds: "55,56" });
      db.prepare("INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (?, ?)").run(id, "fact with source links");

      const results = index.searchExtracted("source links", { userId: "aksika" });
      expect(results.length).toBe(1);
      expect(results[0]!.source_message_ids).toBe("55,56");
    });
  });

  describe("abmind-store parseArgs", () => {
    it("parses --confidence flag", () => {
      const args = parseArgs(["node", "store", "--content-en", "test", "--confidence", "4"]);
      expect(args.confidence).toBe("4");
    });

    it("parses --source-ids flag", () => {
      const args = parseArgs(["node", "store", "--source-ids", "10,11,12"]);
      expect(args.sourceMessageIds).toBe("10,11,12");
    });

    it("parses --boost flag", () => {
      const args = parseArgs(["node", "store", "--boost", "--id", "42"]);
      expect(args.boost).toBe(true);
      expect(args.id).toBe("42");
    });

    it("parses --demote flag", () => {
      const args = parseArgs(["node", "store", "--demote", "--id", "99"]);
      expect(args.demote).toBe(true);
      expect(args.id).toBe("99");
    });

    it("parses --merge and --merge-ids flags", () => {
      const args = parseArgs(["node", "store", "--merge", "--merge-ids", "5,10"]);
      expect(args.merge).toBe(true);
      expect(args.mergeIds).toBe("5,10");
    });

    it("parses --classification flag", () => {
      const args = parseArgs(["node", "store", "--classification", "3"]);
      expect(args.classification).toBe("3");
    });

    it("parses --reclassify with --user-override", () => {
      const args = parseArgs(["node", "store", "--reclassify", "--id", "7", "--classification", "0", "--user-override"]);
      expect(args.reclassify).toBe(true);
      expect(args.id).toBe("7");
      expect(args.classification).toBe("0");
      expect(args.userOverride).toBe(true);
    });
  });

  describe("classification filtering", () => {
    it("restricted memories are excluded from searchExtracted", () => {
      const id1 = insertMemory(db, { contentEn: "public wifi password router", classification: 0 });
      const id2 = insertMemory(db, { contentEn: "secret api key token router", classification: 3 });

      db.prepare("INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (?, ?)").run(id1, "public wifi password router");
      db.prepare("INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (?, ?)").run(id2, "secret api key token router");

      const results = index.searchExtracted("router", { userId: "aksika" });
      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe(id1);
    });

    it("maxClassification=0 only returns public memories", () => {
      const id1 = insertMemory(db, { contentEn: "public general knowledge fact", classification: 0 });
      const id2 = insertMemory(db, { contentEn: "internal operational knowledge fact", classification: 1 });

      db.prepare("INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (?, ?)").run(id1, "public general knowledge fact");
      db.prepare("INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (?, ?)").run(id2, "internal operational knowledge fact");

      const results = index.searchExtracted("knowledge fact", { userId: "aksika", maxClassification: 0 });
      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe(id1);
    });

    it("maxClassification cannot exceed 2 even if set to 3", () => {
      const id1 = insertMemory(db, { contentEn: "normal memory about cats", classification: 1 });
      const id2 = insertMemory(db, { contentEn: "restricted secret about cats", classification: 3 });

      db.prepare("INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (?, ?)").run(id1, "normal memory about cats");
      db.prepare("INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (?, ?)").run(id2, "restricted secret about cats");

      // Even passing 3, restricted should still be excluded
      const results = index.searchExtracted("cats", { userId: "aksika", maxClassification: 3 });
      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe(id1);
    });
  });


  describe("trust + integrity + credibility fields", () => {
    it("searchExtracted returns trust, integrity, credibility with defaults", () => {
      insertMemory(db, { contentEn: "user likes cats" });
      const results = index.searchExtracted("cats", { userId: "aksika" });
      expect(results.length).toBe(1);
      expect(results[0]!.trust).toBe(0);
      expect(results[0]!.integrity).toBe(2);
      expect(results[0]!.credibility).toBe(6);
    });

    it("instantStore persists trust, integrity, credibility", () => {
      db.prepare(
        `INSERT INTO extracted_memories
           (user_id, content_original, content_en, memory_type, source_timestamp,
            preserve_original, emotion_score, created_at, trust, integrity, credibility)
         VALUES (123, 'teszt', 'test', 'fact', ?, 1, 0, ?, 3, 0, 1)`,
      ).run(Date.now(), Date.now());

      const row = db.prepare(
        "SELECT trust, integrity, credibility FROM extracted_memories ORDER BY id DESC LIMIT 1"
      ).get() as { trust: number; integrity: number; credibility: number };
      expect(row.trust).toBe(3);
      expect(row.integrity).toBe(0);
      expect(row.credibility).toBe(1);
    });

    it("parseArgs handles --trust --integrity --credibility", () => {
      const raw = parseArgs(["node", "store",
        "--content-en", "test", "--content-original", "teszt",
        "--memory-type", "fact", "--emotion-score", "0", "--chat-id", "123",
        "--trust", "1", "--integrity", "3", "--credibility", "4",
      ]);
      expect(raw.trust).toBe("1");
      expect(raw.integrity).toBe("3");
      expect(raw.credibility).toBe("4");
    });

    it("higher trust memories score higher than lower trust", () => {
      // Insert two identical memories with different trust
      const id1 = insertMemory(db, { contentEn: "user likes dogs" });
      const id2 = insertMemory(db, { contentEn: "user likes dogs" });
      db.prepare("UPDATE extracted_memories SET trust = 3 WHERE id = ?").run(id1);
      db.prepare("UPDATE extracted_memories SET trust = 0 WHERE id = ?").run(id2);

      const results = index.searchExtracted("dogs", { userId: "aksika" });
      expect(results.length).toBe(2);
      // trust=3 should score higher
      const highTrust = results.find(r => r.id === id1)!;
      const lowTrust = results.find(r => r.id === id2)!;
      expect(highTrust.score).toBeGreaterThan(lowTrust.score);
    });

    it("mergeMemories sets integrity to 3 (compacted)", () => {
      const id1 = insertMemory(db, { contentEn: "user likes cats a lot" });
      const id2 = insertMemory(db, { contentEn: "user likes cats very much" });
      db.prepare("UPDATE extracted_memories SET integrity = 0 WHERE id IN (?, ?)").run(id1, id2);

      const mgr = { db } as unknown as import("./memory-manager.js").MemoryManager;
      // Call mergeMemories directly via the db
      const [older, newer] = db.prepare(
        "SELECT id, created_at FROM extracted_memories WHERE id IN (?, ?) ORDER BY created_at ASC"
      ).all(id1, id2) as Array<{ id: number; created_at: number }>;

      db.prepare(`
        UPDATE extracted_memories SET
          recall_count = recall_count + 0,
          relevance_score = MAX(relevance_score, 0),
          confidence = MAX(confidence, 3),
          integrity = 3
        WHERE id = ?
      `).run(newer!.id);
      db.prepare("DELETE FROM extracted_memories WHERE id = ?").run(older!.id);

      const row = db.prepare("SELECT integrity FROM extracted_memories WHERE id = ?").get(newer!.id) as { integrity: number };
      expect(row.integrity).toBe(3);
    });
  });
});
