/**
 * Regression test for #177 — recall extractedIds[i] alignment bug.
 *
 * Before fix: enrichResults used extractedIds[i] to look up the ID for enriched[i].
 * After MMR reorders finalResults, the positional index desyncs — a hit at
 * position i could get the wrong timeline (belonging to another memory).
 *
 * After fix: each RecallHit carries its own .id, enrichment matches by identity.
 *
 * This test forces MMR to reorder by constructing hits with different scores
 * AND different content similarity (so diversity picks a non-first-place result
 * early), AND includes an S6 hit (id=undefined) to exercise the guard.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { recallSearch, type RecallDeps } from "./recall-engine.js";
import type Database from "better-sqlite3";

let tmpDir: string;
let db: Database.Database;
let deps: RecallDeps;

const USER = "alignment-test";

/** Insert a memory with explicit topic, entity mark, and recall_count for score control. */
function insertMemory(opts: {
  contentEn: string; topic: string; recallCount?: number;
}): number {
  const now = Date.now();
  const result = db.prepare(
    `INSERT INTO extracted_memories
       (user_id, content_original, content_en, memory_type, source_timestamp, created_at,
        preserve_original, classification, trust, credibility, integrity,
        topic, tier, recall_count, confidence)
     VALUES (?, ?, ?, 'fact', ?, ?, 0, 1, 2, 3, 2, ?, 'general', ?, 3)`,
  ).run(
    USER, opts.contentEn, opts.contentEn, now, now, opts.topic, opts.recallCount ?? 0,
  );
  return Number(result.lastInsertRowid);
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "recall-alignment-"));
  db = initializeDatabase(join(tmpDir, "memory.db"));
  const index = new MemoryIndex(db);
  deps = { db, index, memoryDir: tmpDir };

  // Timeline "foo": 3 memories in topic=alpha, entity=@foo
  // content uses |alpha| marker so enrichResults regex picks up the topic
  insertMemory({ contentEn: "Decision |alpha| about @foo config keyword", topic: "alpha", recallCount: 10 });
  insertMemory({ contentEn: "Update |alpha| to @foo setup keyword", topic: "alpha", recallCount: 5 });
  insertMemory({ contentEn: "Final |alpha| @foo choice keyword", topic: "alpha", recallCount: 1 });

  // Timeline "bar": 3 memories in topic=beta, entity=@bar — use different words to avoid Jaccard similarity
  insertMemory({ contentEn: "Start |beta| pursue @bar approach keyword", topic: "beta", recallCount: 8 });
  insertMemory({ contentEn: "Extend |beta| hobby @bar daily keyword", topic: "beta", recallCount: 4 });
  insertMemory({ contentEn: "Finish |beta| target @bar milestone keyword", topic: "beta", recallCount: 2 });

  // S6 consolidation file — gives us an S6 hit with id=undefined
  const dailyDir = join(tmpDir, "daily");
  mkdirSync(dailyDir, { recursive: true });
  writeFileSync(join(dailyDir, "daily_2026-04-17.md"), "# Daily Summary\n\nDiscussed keyword choices across @foo and @bar topics.");
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("#177 — recall extractedIds alignment", () => {
  it("each hit's timelineContext matches its own ID (not position)", async () => {
    const result = await recallSearch(deps, {
      translated: ["keyword"], userId: USER, limit: 10,
    });

    // Must have results from multiple topics AND S6 to exercise the bug
    const dbHits = result.results.filter(r => r.id !== undefined);
    const s6Hits = result.results.filter(r => r.id === undefined);

    expect(dbHits.length).toBeGreaterThanOrEqual(4); // at least 2 from each topic
    expect(s6Hits.length).toBeGreaterThanOrEqual(1); // at least one S6

    // For each DB hit with a timelineContext, the topic in its timeline
    // must match the topic of its own content — not a different hit's topic.
    for (const hit of dbHits) {
      if (!hit.timelineContext) continue;
      const hitTopic = hit.content.match(/\|([a-z]+)\|/)?.[1];
      expect(hitTopic).toBeDefined();
      // Timeline rendering format: [TL|topic|entity] ... — topic must match
      expect(hit.timelineContext).toMatch(new RegExp(`\\[TL\\|${hitTopic}\\|`));
    }

    // S6 hits must never receive a timeline (no id → guard clause skips them)
    for (const hit of s6Hits) {
      expect(hit.timelineContext).toBeUndefined();
    }
  });

  it("MMR reorder does not break enrichment", async () => {
    // Recall twice with different limits to exercise different MMR-pick paths
    for (const limit of [3, 6, 10]) {
      const result = await recallSearch(deps, {
        translated: ["keyword"], userId: USER, limit,
      });

      for (const hit of result.results) {
        if (!hit.timelineContext || hit.id === undefined) continue;
        const hitTopic = hit.content.match(/\|([a-z]+)\|/)?.[1];
        const timelineTopic = hit.timelineContext.match(/\[TL\|([a-z]+)\|/)?.[1];
        expect(timelineTopic, `hit #${hit.id} at limit=${limit}: own topic "${hitTopic}" vs timeline topic "${timelineTopic}"`).toBe(hitTopic);
      }
    }
  });

  it("hits carry their DB id (regression guard for RecallHit.id field)", async () => {
    const result = await recallSearch(deps, {
      translated: ["keyword"], userId: USER, limit: 10,
    });

    const dbHits = result.results.filter(r => r.source.startsWith("Sf") || r.source.startsWith("Ss") || r.source.startsWith("Se"));
    expect(dbHits.length).toBeGreaterThan(0);
    for (const hit of dbHits) {
      expect(hit.id, `DB-sourced hit must have id (source: ${hit.source})`).toBeTypeOf("number");
    }
  });
});
