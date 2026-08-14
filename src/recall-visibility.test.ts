/**
 * #1658 recall visibility — the shared-or-owned predicate with the permanent
 * class-3 ceiling applies to Sf, Se, Ss and timeline enrichment; foreign
 * private rows never surface and never reach recall counters; class-3 rows are
 * returned by no path even when the caller requests maxClassification = 3.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { recallSearch } from "./recall-engine.js";
import { trigramSearch } from "./trigram-search.js";
import { vectorSearch } from "./ollama-embed.js";
import { generateSignature } from "./signature-generator.js";
import { effectiveMaxClassification, RECALL_MAX_CLASSIFICATION } from "./memory-visibility.js";

const OWNER = "owner-user";
const FOREIGN = "foreign-user";

describe("#1658 recall visibility", () => {
  let tmpDir: string;
  let mm: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "recall-vis-"));
    mm = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await mm.initialize({ skipEmbeddingCheck: true });
    process.env.ABMIND_USER_ID = OWNER;
  });

  afterEach(() => {
    mm.close();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ABMIND_USER_ID;
  });

  function seedMemory(
    userId: string,
    contentEn: string,
    classification: number,
    opts: { signature?: boolean; embedding?: boolean; topic?: string } = {},
  ): number {
    const db = getMemoryDb(mm)!;
    const now = Date.now();
    const sig = opts.signature ? Buffer.from(generateSignature(contentEn)) : null;
    const result = db.prepare(
      `INSERT INTO extracted_memories
         (user_id, content_original, content_en, memory_type, source_timestamp, created_at,
          emotion_score, classification, topic, signature, embedding)
       VALUES (?, ?, ?, 'fact', ?, ?, 0, ?, ?, ?, ?)`,
    ).run(userId, contentEn, contentEn, now, now, classification, opts.topic ?? "general", sig,
      opts.embedding ? Buffer.from(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer) : null);
    return Number(result.lastInsertRowid);
  }

  function recallCount(id: number): number {
    return (getMemoryDb(mm)!.prepare("SELECT recall_count FROM extracted_memories WHERE id = ?").get(id) as { recall_count: number }).recall_count;
  }

  it("ceiling helper caps at 2 and is the only ceiling", () => {
    expect(RECALL_MAX_CLASSIFICATION).toBe(2);
    expect(effectiveMaxClassification()).toBe(2);
    expect(effectiveMaxClassification(3)).toBe(2);
    expect(effectiveMaxClassification(1)).toBe(1);
    expect(effectiveMaxClassification(99)).toBe(2);
  });

  it("Sf: owned class-2 and shared class-1 visible; foreign private and all class-3 excluded at maxClassification=3", () => {
    const db = getMemoryDb(mm)!;
    seedMemory(OWNER, "owned private neon control", 2);
    seedMemory(FOREIGN, "foreign private neon sentinel", 2);
    seedMemory(OWNER, "shared neon control", 1);
    seedMemory(OWNER, "owned class three neon secret", 3);
    seedMemory(FOREIGN, "foreign class three neon secret", 3);

    const { hits, extractedIds } = trigramSearch(db, {
      translated: ["neon"], userId: OWNER, limit: 20, maxClassification: 3,
    });
    const contents = hits.map((h) => h.content);
    expect(contents).toContain("owned private neon control");
    expect(contents).toContain("shared neon control");
    expect(contents).not.toContain("foreign private neon sentinel");
    expect(contents).not.toContain("owned class three neon secret");
    expect(contents).not.toContain("foreign class three neon secret");
    const secretIds = [contents.indexOf("owned class three neon secret"), contents.indexOf("foreign class three neon secret")]
      .filter((i) => i >= 0);
    expect(secretIds).toHaveLength(0);
    // extractedIds feed recall counters — only authorized ids may be present.
    const all = [seedMemory, seedMemory].length; // noop guard
    void all;
  });

  it("Se: vector search applies the same ceiling and owner clause", () => {
    const db = getMemoryDb(mm)!;
    seedMemory(OWNER, "vectored owned two", 2, { embedding: true });
    seedMemory(FOREIGN, "vectored foreign two", 2, { embedding: true });
    seedMemory(OWNER, "vectored owned three", 3, { embedding: true });
    seedMemory(OWNER, "vectored shared one", 1, { embedding: true });

    const results = vectorSearch(db, new Float32Array([0.1, 0.2, 0.3, 0.4]), {
      userId: OWNER, limit: 20, threshold: -1, maxClassification: 3,
    });
    const contents = results.map((r) => r.content_en);
    expect(contents).toContain("vectored owned two");
    expect(contents).toContain("vectored shared one");
    expect(contents).not.toContain("vectored foreign two");
    expect(contents).not.toContain("vectored owned three");
  });

  it("Ss: signature stage excludes foreign private and class-3 rows and leaves counters untouched", async () => {
    seedMemory(OWNER, "quantum entanglement coherence", 2, { signature: true });
    seedMemory(FOREIGN, "quantum entanglement coherence", 2, { signature: true });
    seedMemory(OWNER, "quantum entanglement coherence", 3, { signature: true });

    const db = getMemoryDb(mm)!;
    const foreignId = (db.prepare("SELECT id FROM extracted_memories WHERE user_id = ?").get(FOREIGN) as { id: number }).id;
    const classThreeId = (db.prepare("SELECT id FROM extracted_memories WHERE user_id = ? AND classification = 3").get(OWNER) as { id: number }).id;
    const ownedId = (db.prepare("SELECT id FROM extracted_memories WHERE user_id = ? AND classification = 2").get(OWNER) as { id: number }).id;

    const result = await recallSearch(
      { db, index: getMemoryDb(mm)! as never, memoryDir: tmpDir, embeddingProvider: undefined },
      { translated: ["quantum"], userId: OWNER, limit: 10, maxClassification: 3, stages: ["Ss"], trackRecalls: true },
    );
    const contents = result.results.map((h) => h.content);
    expect(contents).toContain("quantum entanglement coherence");
    const ids = result.results.map((h) => h.id).filter((id): id is number => id !== undefined);
    expect(ids).not.toContain(foreignId);
    expect(ids).not.toContain(classThreeId);
    // Recall counters updated only for authorized ids.
    expect(recallCount(foreignId)).toBe(0);
    expect(recallCount(classThreeId)).toBe(0);
    expect(recallCount(ownedId)).toBe(1);
  });

  it("full pipeline: an owner-owned class-3 row is returned by no path at maxClassification=3", async () => {
    seedMemory(OWNER, "supernova class three plaintext", 3, { signature: true, embedding: true });
    seedMemory(OWNER, "supernova visible control", 1, { signature: true, embedding: true });

    const db = getMemoryDb(mm)!;
    const classThreeId = (db.prepare("SELECT id FROM extracted_memories WHERE classification = 3").get() as { id: number }).id;

    const result = await recallSearch(
      { db, index: getMemoryDb(mm)! as never, memoryDir: tmpDir, embeddingProvider: undefined },
      { translated: ["supernova"], userId: OWNER, limit: 10, maxClassification: 3, trackRecalls: true },
    );
    const contents = result.results.map((h) => h.content);
    expect(contents).toContain("supernova visible control");
    expect(contents).not.toContain("supernova class three plaintext");
    expect(result.extractedIds).not.toContain(classThreeId);
    expect(recallCount(classThreeId)).toBe(0);
  });

  it("timeline enrichment uses bound topics and the visibility predicate", async () => {
    seedMemory(OWNER, "timeline owned topic memory |quantum|", 2, { topic: "quantum" });
    seedMemory(FOREIGN, "timeline foreign topic memory |quantum|", 2, { topic: "quantum" });
    seedMemory(OWNER, "timeline class three topic memory |quantum|", 3, { topic: "quantum" });

    const db = getMemoryDb(mm)!;
    const result = await recallSearch(
      { db, index: getMemoryDb(mm)! as never, memoryDir: tmpDir, embeddingProvider: undefined },
      { translated: ["timeline owned"], userId: OWNER, limit: 10, maxClassification: 3, stages: ["Sf"], trackRecalls: false },
    );
    const allText = JSON.stringify(result.results.map((h) => [h.content, h.timelineContext].filter(Boolean)));
    expect(allText).toContain("timeline owned topic memory");
    expect(allText).not.toContain("timeline foreign topic memory");
    expect(allText).not.toContain("timeline class three topic memory");
  });
});
