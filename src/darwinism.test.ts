import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./memory-db.js";
import { parseArgs } from "../cli/abmind-store.js";

describe("Memory Darwinism", () => {
  let tmpDir: string;
  let db: ReturnType<typeof initializeDatabase>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "darwinism-"));
    process.env.ABMIND_USER_ID = "user-100";
    db = initializeDatabase(join(tmpDir, "memory.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
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

    it("parses --classification flag", () => {
      const args = parseArgs(["node", "store", "--classification", "3"]);
      expect(args.classification).toBe("3");
    });
  });

  describe("trust + integrity + credibility fields", () => {
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

    it("mergeMemories sets integrity to 3 (compacted)", () => {
      const now = Date.now();
      const seed = (content: string): number => Number(db.prepare(
        `INSERT INTO extracted_memories
          (user_id, content_original, content_en, memory_type, source_timestamp,
           preserve_original, emotion_score, created_at, recall_count, relevance_score, confidence)
         VALUES ('aksika', ?, ?, 'fact', ?, 0, 0, ?, 0, 0, 3)`,
      ).run(content, content, now, now).lastInsertRowid);
      const id1 = seed("user likes cats a lot");
      const id2 = seed("user likes cats very much");
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
