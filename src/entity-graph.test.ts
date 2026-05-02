/**
 * #351 — entity-graph.ts test coverage.
 *
 * Covers:
 * - upsertEdge: insert + conflict update
 * - isKnownEntity: case-insensitive exact match (whole-entity, not substring)
 * - queryEntityRelationships: classification (BLP) filter, credibility filter
 *   (contradicted edges hidden at credibility > 3), ordering, LIMIT
 * - S8 integration surface: the query path recall-engine.ts relies on
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeDatabase } from "./memory-db.js";
import { upsertEdge, queryEntityRelationships, isKnownEntity } from "./entity-graph.js";
import type Database from "better-sqlite3";

describe("#351 — entity-graph", () => {
  let tmpDir: string;
  let db: Database.Database;

  /** Insert a minimal extracted_memory and return its id. Uses schema default
   * credibility=6 — since #361 removed the credibility filter from entity-graph,
   * fresh memories surface in S8 results without special setup. */
  function insertMemory(opts: { classification?: number; credibility?: number; content?: string } = {}): number {
    const result = db.prepare(`
      INSERT INTO extracted_memories
        (user_id, content_original, content_en, memory_type, source_timestamp, created_at,
         classification, credibility, trust, integrity)
      VALUES ('u1', ?, ?, 'fact', 1000, 1000, ?, ?, 0, 2)
    `).run(
      opts.content ?? "seed",
      opts.content ?? "seed",
      opts.classification ?? 1,
      opts.credibility ?? 6,  // schema default; #361 no longer filters on this
    );
    return result.lastInsertRowid as number;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "entity-graph-test-"));
    mkdirSync(tmpDir, { recursive: true });
    db = initializeDatabase(join(tmpDir, "memory.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── upsertEdge ───────────────────────────────────────────────────────────

  describe("upsertEdge", () => {
    it("inserts a new edge with lowercased entity names", () => {
      const memId = insertMemory();
      upsertEdge(db, { entity_a: "Alice", entity_b: "BOB", relation: "friend_of", source_memory_id: memId });

      const row = db.prepare("SELECT entity_a, entity_b, relation FROM entity_graph").get() as
        { entity_a: string; entity_b: string; relation: string };
      expect(row.entity_a).toBe("alice");
      expect(row.entity_b).toBe("bob");
      expect(row.relation).toBe("friend_of");
    });

    it("updates last_seen_at and source_memory_id on conflict (same a/b/relation)", async () => {
      const mem1 = insertMemory({ content: "first" });
      const mem2 = insertMemory({ content: "second" });

      upsertEdge(db, { entity_a: "alice", entity_b: "bob", relation: "friend_of", source_memory_id: mem1 });
      const before = db.prepare("SELECT last_seen_at, source_memory_id FROM entity_graph").get() as
        { last_seen_at: number; source_memory_id: number };

      // Ensure the clock actually ticks
      await new Promise(r => setTimeout(r, 2));
      upsertEdge(db, { entity_a: "alice", entity_b: "bob", relation: "friend_of", source_memory_id: mem2 });

      const after = db.prepare("SELECT last_seen_at, source_memory_id FROM entity_graph").get() as
        { last_seen_at: number; source_memory_id: number };
      expect(after.last_seen_at).toBeGreaterThan(before.last_seen_at);
      expect(after.source_memory_id).toBe(mem2);
      // Still only one row — UNIQUE constraint held
      const count = db.prepare("SELECT COUNT(*) as c FROM entity_graph").get() as { c: number };
      expect(count.c).toBe(1);
    });

    it("allows two edges with same a/b but different relation", () => {
      upsertEdge(db, { entity_a: "alice", entity_b: "bob", relation: "friend_of" });
      upsertEdge(db, { entity_a: "alice", entity_b: "bob", relation: "colleague_of" });

      const count = db.prepare("SELECT COUNT(*) as c FROM entity_graph").get() as { c: number };
      expect(count.c).toBe(2);
    });

    it("accepts null source_memory_id (orphan edges allowed)", () => {
      expect(() => upsertEdge(db, { entity_a: "x", entity_b: "y", relation: "r" })).not.toThrow();
      const row = db.prepare("SELECT source_memory_id FROM entity_graph").get() as { source_memory_id: number | null };
      expect(row.source_memory_id).toBeNull();
    });
  });

  // ── isKnownEntity ────────────────────────────────────────────────────────

  describe("isKnownEntity", () => {
    beforeEach(() => {
      upsertEdge(db, { entity_a: "alice", entity_b: "bob", relation: "friend_of" });
    });

    it("returns true for a known entity_a", () => {
      expect(isKnownEntity(db, "alice")).toBe(true);
    });

    it("returns true for a known entity_b", () => {
      expect(isKnownEntity(db, "bob")).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(isKnownEntity(db, "ALICE")).toBe(true);
      expect(isKnownEntity(db, "Bob")).toBe(true);
    });

    it("returns false for an unknown entity", () => {
      expect(isKnownEntity(db, "charlie")).toBe(false);
    });

    it("does NOT match substrings (the query is whole-entity equality)", () => {
      // Per caller contract in recall-engine.ts:314 — tokens split by whitespace
      // and queried whole. Confirm the function doesn't do substring matching.
      expect(isKnownEntity(db, "ali")).toBe(false);
      expect(isKnownEntity(db, "alicesmith")).toBe(false);
    });

    it("returns false on empty string (no entity with empty name)", () => {
      expect(isKnownEntity(db, "")).toBe(false);
    });
  });

  // ── queryEntityRelationships ─────────────────────────────────────────────

  describe("queryEntityRelationships", () => {
    it("returns edges for either side of the relationship", () => {
      const memId = insertMemory();
      upsertEdge(db, { entity_a: "alice", entity_b: "bob", relation: "friend_of", source_memory_id: memId });

      const byA = queryEntityRelationships(db, "alice", 2);
      const byB = queryEntityRelationships(db, "bob", 2);
      expect(byA).toHaveLength(1);
      expect(byB).toHaveLength(1);
      expect(byA[0]!.relation).toBe("friend_of");
    });

    it("is case-insensitive on the query", () => {
      upsertEdge(db, { entity_a: "alice", entity_b: "bob", relation: "friend_of" });
      expect(queryEntityRelationships(db, "ALICE", 2)).toHaveLength(1);
    });

    it("filters by maxClassification (BLP gate)", () => {
      const publicMem = insertMemory({ classification: 1 });
      const secretMem = insertMemory({ classification: 3, content: "secret" });
      upsertEdge(db, { entity_a: "alice", entity_b: "bob", relation: "public_friend", source_memory_id: publicMem });
      upsertEdge(db, { entity_a: "alice", entity_b: "charlie", relation: "secret_lover", source_memory_id: secretMem });

      // maxClassification=2 excludes the class=3 edge
      const filtered = queryEntityRelationships(db, "alice", 2);
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.relation).toBe("public_friend");

      // maxClassification=3 includes both
      const all = queryEntityRelationships(db, "alice", 3);
      expect(all).toHaveLength(2);
    });

    it("surfaces edges regardless of credibility after #361 fix", () => {
      // Before #361: credibility filter hid all edges for memories <7 days old.
      // After #361: only classification gate (BLP) remains; credibility is ignored.
      const freshMem = insertMemory({ credibility: 6 });  // brand new
      const agedMem = insertMemory({ credibility: 3, content: "aged" });  // 7+ days old
      upsertEdge(db, { entity_a: "alice", entity_b: "bob", relation: "fresh_rel", source_memory_id: freshMem });
      upsertEdge(db, { entity_a: "alice", entity_b: "dave", relation: "aged_rel", source_memory_id: agedMem });

      const results = queryEntityRelationships(db, "alice", 3);
      expect(results).toHaveLength(2);
      const relations = results.map(r => r.relation).sort();
      expect(relations).toEqual(["aged_rel", "fresh_rel"]);
    });

    it("includes edges with null source_memory_id (no source memory to check)", () => {
      upsertEdge(db, { entity_a: "alice", entity_b: "bob", relation: "orphan_rel" });
      const results = queryEntityRelationships(db, "alice", 2);
      expect(results).toHaveLength(1);
      expect(results[0]!.source_memory_id).toBeNull();
    });

    it("orders by last_seen_at DESC (most recent first)", async () => {
      upsertEdge(db, { entity_a: "alice", entity_b: "bob", relation: "old_rel" });
      await new Promise(r => setTimeout(r, 2));
      upsertEdge(db, { entity_a: "alice", entity_b: "charlie", relation: "new_rel" });

      const results = queryEntityRelationships(db, "alice", 2);
      expect(results).toHaveLength(2);
      expect(results[0]!.relation).toBe("new_rel");
      expect(results[1]!.relation).toBe("old_rel");
    });

    it("caps at LIMIT 10", async () => {
      for (let i = 0; i < 15; i++) {
        upsertEdge(db, { entity_a: "alice", entity_b: `person${i}`, relation: `rel${i}` });
      }
      const results = queryEntityRelationships(db, "alice", 2);
      expect(results).toHaveLength(10);
    });

    it("returns empty array for unknown entity", () => {
      expect(queryEntityRelationships(db, "nobody", 2)).toEqual([]);
    });
  });

  // ── S8 integration surface ───────────────────────────────────────────────

  describe("S8 recall-engine integration surface", () => {
    it("supports the recall-engine S8 path: tokenize query, check isKnownEntity, fetch edges", () => {
      // Simulates what recall-engine.ts:312-320 does (post-#362 with word-run extraction)
      const memId = insertMemory();
      upsertEdge(db, { entity_a: "alice", entity_b: "bob", relation: "friend_of", source_memory_id: memId });

      const query = "tell me about alice's and her friends";
      const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter(w => w.length > 2);
      let foundHits = 0;
      for (const word of words) {
        if (!isKnownEntity(db, word)) continue;
        const edges = queryEntityRelationships(db, word, 2);
        foundHits += edges.length;
        break; // recall-engine breaks after first entity match
      }
      // With #362 fix, "alice's" → ["alice", "s"], "alice" IS the known entity
      expect(foundHits).toBe(1);
    });

    it("recall-engine token filter (word.length > 2) correctly skips short tokens that happen to be entities", () => {
      // If someone stores "jo" as an entity, recall-engine's w.length > 2 filter will skip it —
      // verify the filter contract. This is what the caller does, not the module, so we document
      // it as a guard against future regressions if the caller loosens the filter.
      upsertEdge(db, { entity_a: "jo", entity_b: "alice", relation: "friend_of" });
      const query = "jo knows alice well";
      const words = query.split(/\s+/).filter(w => w.length > 2);
      expect(words).not.toContain("jo"); // filtered out by caller (too short)
      expect(words).toContain("alice");  // passes filter
    });

    it("S8 tokenizer (after #362 fix) extracts word runs so possessives match", () => {
      // recall-engine.ts:313 now uses match(/[\p{L}\p{N}]+/gu) after lowercase.
      // "alice's" → ["alice", "s"]; "bob," → ["bob"]; plain "carol" → ["carol"].
      const query = "alice's friend bob, meet carol";
      const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter(w => w.length > 2);
      expect(words).toContain("alice");
      expect(words).toContain("friend");
      expect(words).toContain("bob");
      expect(words).toContain("meet");
      expect(words).toContain("carol");
      expect(words).not.toContain("alice's");
      expect(words).not.toContain("s"); // too short, filtered
    });

    it("S8 tokenizer handles unicode (Hungarian characters) without data loss", () => {
      const query = "Ákos's kutyája, Péter";
      const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter(w => w.length > 2);
      expect(words).toContain("ákos");   // possessive split off, accent preserved
      expect(words).toContain("kutyája"); // trailing comma stripped
      expect(words).toContain("péter");
    });

    it("S8 tokenizer returns empty array on pure-punctuation query (no crash)", () => {
      const words = ("!!! ??? ,,,".toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter(w => w.length > 2);
      expect(words).toEqual([]);
    });
  });
});
