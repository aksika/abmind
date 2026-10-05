/**
 * #1908 M2 — raw/context retrieval integration. Real SQLite over a temp
 * store, lexical stages only (no embedding provider, no judgments): proves
 * the second plan rescues follow-ups that raw recall misses, that fencing
 * excludes foreign context, that explicit recall never skips, and that
 * tracking finalizes once per turn.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { recallSearch, type RecallDeps, type RecallResult } from "./recall-engine.js";
import { initAbmindEnv, _resetAbmindEnv } from "./env-schema.js";

const ENV_KEYS = ["SYSTEM1", "SYSTEM1_RECALL", "EMBEDDING_ENABLED"];

const USER = "user-123";
const IDENTITY = { host: "test-host", conversation: "conv-1", executionId: "turn-2" };

function row(db: Database.Database, id: number, content: string): void {
  const now = Date.now();
  db.prepare(`INSERT INTO extracted_memories
    (id, content_en, content_original, memory_type, created_at, source_timestamp, user_id, confidence, emotion_score, recall_count, relevance_score, semantic_revision)
    VALUES (?, ?, ?, 'fact', ?, ?, 'user-123', 3, 0, 0, 0, 0)`).run(
    id, content, content, now, now,
  );
}

function seed(db: Database.Database): void {
  row(db, 1, "Deploy production with the standard pipeline after CI passes.");
  row(db, 2, "Deploy rollbacks restore the previous production release.");
  row(db, 3, "Akkor meg hogy van ez mostanában a csapatban.");
  row(db, 4, "Akkor meg hogy lesz ez holnap is a megbeszélésen.");
  row(db, 5, "Tegnap akkor meg hogy döntöttünk a határidőről.");
  row(db, 6, "A telepítési útmutató a wiki oldalán van.");
}

function deps(db: Database.Database): RecallDeps {
  return { db, index: new MemoryIndex(db), memoryDir: "/tmp/test-memory" };
}

function snapshot(text: string, overrides = {}) {
  return {
    text,
    principal: USER,
    host: IDENTITY.host,
    conversation: IDENTITY.conversation,
    executionId: "turn-1",
    complete: true,
    recencyRank: 0,
    ...overrides,
  };
}

async function ambient(db: Database.Database, extra = {}): Promise<RecallResult> {
  return recallSearch(deps(db), {
    translated: [],
    original: "akkor meg hogy",
    intent: "ambient",
    userId: USER,
    limit: 5,
    stages: ["Sf"],
    contextIdentity: { ...IDENTITY },
    ...extra,
  });
}

describe("#1908 raw/context retrieval", () => {
  let saved: Record<string, string | undefined>;
  let db: Database.Database;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    _resetAbmindEnv();
    initAbmindEnv();
    db = initializeDatabase(":memory:");
    seed(db);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetAbmindEnv();
    db.close();
  });

  it("context rescues a common-word follow-up that raw recall misses", async () => {
    const res = await ambient(db, {
      contextOptions: [snapshot("hol találom a telepítési útmutató oldalt")],
    });
    expect(res.searchSkipped).not.toBe(true);
    expect(res.results.map((h) => h.id)).toContain(6);
    expect(res.ambient?.plans).toBe("raw+context");
    expect(res.ambient?.semanticSource).toBe("context");
    // Diagnostics stay content-free: no memory text leaks into them.
    expect(JSON.stringify(res.ambient)).not.toContain("telepítési");
  });

  it("raw-only control skips the same common-word turn", async () => {
    const res = await ambient(db);
    expect(res.searchSkipped).toBe(true);
    expect(res.results).toHaveLength(0);
    expect(res.ambient?.plans).toBe("raw");
  });

  it("foreign context is excluded and cannot rescue", async () => {
    const res = await ambient(db, {
      contextOptions: [snapshot("hol találom a telepítési útmutató oldalt", { principal: "mallory" })],
    });
    expect(res.searchSkipped).toBe(true);
    expect(res.results).toHaveLength(0);
    expect(res.ambient?.plans).toBe("raw");
    expect(res.ambient?.contextRejected["foreign-principal"]).toBe(1);
  });

  it("explicit recall never skips and never plans context", async () => {
    const res = await recallSearch(deps(db), {
      translated: ["akkor", "meg", "hogy"],
      intent: "explicit",
      userId: USER,
      limit: 5,
      stages: ["Sf"],
    });
    expect(res.searchSkipped).not.toBe(true);
    expect(res.ambient).toBeUndefined();
  });

  it("self-contained raw turns keep their required evidence", async () => {
    const res = await recallSearch(deps(db), {
      translated: [],
      original: "deploy pipeline",
      intent: "ambient",
      userId: USER,
      limit: 5,
      stages: ["Sf"],
      contextIdentity: { ...IDENTITY },
      contextOptions: [snapshot("hol találom a telepítési útmutató oldalt")],
    });
    expect(res.searchSkipped).not.toBe(true);
    // Informative raw text keeps the semantic input; the topic is not diluted.
    expect(res.ambient?.semanticSource).toBe("raw");
    expect(res.results.map((h) => h.id)).toContain(1);
  });

  it("embeds the current question when its whole-turn measurement is incomplete", async () => {
    const prompts = [
      "What is the deployment pipeline we selected?",
      "Please explain which deployment plan follows our earlier discussion after checking project status again",
    ];
    for (const prompt of prompts) {
      let embeddedText: string | undefined;
      const result = await recallSearch({
        ...deps(db),
        embeddingProvider: {
          name: "test-provider",
          dimensions: 2,
          embedText: async (text) => { embeddedText = text; return new Float32Array([1, 0]); },
          batchEmbed: async () => [],
        },
      }, {
        translated: [],
        original: prompt,
        intent: "ambient",
        userId: USER,
        limit: 5,
        stages: ["Sf", "Se"],
        contextIdentity: { ...IDENTITY },
        contextOptions: [snapshot("Earlier we discussed rollbacks and release recovery.")],
        trackRecalls: false,
      });

      expect(result.ambient?.semanticSource).toBe("raw");
      expect(embeddedText).toBe(prompt);
      expect(result.results.map((hit) => hit.id)).toContain(1);
    }
  });

  it("contextual-only candidates track exactly once per turn", async () => {
    const before = (db.prepare("SELECT recall_count AS c FROM extracted_memories WHERE id = 6").get() as { c: number }).c;
    expect(before).toBe(0);
    await ambient(db, {
      contextOptions: [snapshot("hol találom a telepítési útmutató oldalt")],
    });
    const after = (db.prepare("SELECT recall_count AS c FROM extracted_memories WHERE id = 6").get() as { c: number }).c;
    expect(after).toBe(1);
  });

  it("context or embedding failure preserves the raw baseline", async () => {
    // A failed context probe (unmeasurable option text) leaves raw retrieval intact.
    const res = await ambient(db, {
      original: "deploy pipeline",
      contextOptions: [snapshot("")],
    });
    expect(res.searchSkipped).not.toBe(true);
    expect(res.results.map((h) => h.id)).toContain(1);
    expect(res.ambient?.plans).toBe("raw");
  });

  it("issues at most one query embedding per ambient turn", async () => {
    let calls = 0;
    const provider = {
      dimensions: 2,
      name: "counting-test-provider",
      embedText: async (_text: string): Promise<Float32Array | null> => {
        calls++;
        return new Float32Array([1, 0]);
      },
      batchEmbed: async (_texts: string[]): Promise<Array<Float32Array | null>> => [new Float32Array([1, 0])],
    };
    const res = await recallSearch({ ...deps(db), embeddingProvider: provider }, {
      translated: [],
      original: "akkor meg hogy",
      intent: "ambient",
      userId: USER,
      limit: 5,
      stages: ["Sf", "Se"],
      contextIdentity: { ...IDENTITY },
      contextOptions: [snapshot("hol találom a telepítési útmutató oldalt")],
    });
    expect(calls).toBe(1);
    expect(res.searchSkipped).not.toBe(true);
  });
});
