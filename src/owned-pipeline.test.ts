/**
 * owned-pipeline.test.ts — #1928 M3 indexed retrieval acceptance.
 *
 * Exercises the owned pipeline over real SQLite/owner composition:
 * mapped database stages, profile budgets, prominence protection,
 * provider-off behavior, full-only S6, continuation, grounding/history,
 * and bounded failure. Fixture-only external embeddings.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { ensureInitialized } from "./ensure-initialized.js";
import { setPersonalState } from "./personal-schema.js";
import { storeDurable, supersedeDurable } from "./personal-durable.js";
import { createEpisode } from "./personal-episodes.js";
import { forgetPersonal } from "./personal-forget.js";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { buildRecallProjection, backfillRecallVectors } from "./recall-projection-build.js";
import { runOwnedPipeline, OWNED_STAGE_BUDGETS } from "./owned-pipeline.js";
import type { OwnedPipelineRequest } from "./owned-pipeline.js";
import { ownedRecall } from "./owned-recall.js";
import { OWNED_RECALL_CONTRACT } from "./owned-recall-contract.js";
import { resetEmbedGateForTests, embedGateStatus } from "./owned-embedding-gate.js";
import { resetContinuationsForTests } from "./owned-continuation.js";
import type { IEmbeddingProvider } from "./embedding-provider.js";

const OWNER = "pipeline-owner";

let tmpDir: string;
let db: Database.Database;
let mm: MemoryManager;

function handle(): Database.Database {
  const h = getMemoryDb(mm);
  if (!h) throw new Error("test database missing");
  return h;
}

function insertMessage(content: string, session = "s1"): number {
  return Number(db.prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, 1000)",
  ).run(OWNER, session, content).lastInsertRowid);
}

function seedDurable(content: string, opts?: { original?: string; memoryType?: string; authority?: "user_statement" | "inference" }): { id: number; messageId: number } {
  const messageId = insertMessage(content);
  const d = storeDurable(db, {
    userId: OWNER, memoryType: opts?.memoryType ?? "fact", content,
    authority: opts?.authority ?? "user_statement", authorityBasis: "test",
    applicabilityScope: { scope: "general" }, provenance: {},
    contentOriginal: opts?.original,
    evidence: [{ kind: "user_message", ref: String(messageId), excerpt: content, classification: 1 }],
    actorId: "test",
  });
  return { id: d.id, messageId };
}

function seedEpisode(topic: string, session: string, excerptSeed: string): number {
  const u = Number(db.prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, 1000)",
  ).run(OWNER, session, `${excerptSeed} user turn`).lastInsertRowid);
  const a = Number(db.prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, 'assistant', ?, 1000)",
  ).run(OWNER, session, `${excerptSeed} assistant turn`).lastInsertRowid);
  const excerpt = `${excerptSeed} user turn`;
  return createEpisode(db, {
    userId: OWNER, topic, startTs: 1000, endTs: 2000, sessionIds: [session],
    sourceMessageIds: [u, a], evidenceExcerpts: [{ messageId: u, excerpt, classification: 1 }], actorId: "test",
  }).id;
}

function build(): void {
  const outcome = buildRecallProjection(db, OWNER, { verifiedBackup: true });
  expect(outcome.ok).toBe(true);
}

function pipelineReq(overrides?: Partial<OwnedPipelineRequest>): OwnedPipelineRequest {
  return {
    db,
    owner: OWNER,
    profile: "recall_normal",
    anchorText: "harbor ferry",
    keywords: [],
    contextTerms: [],
    filters: {},
    generation: 1,
    maxItems: 15,
    deadlineAt: Date.now() + 10_000,
    memoryDir: null,
    embeddingProvider: null,
    ...overrides,
  };
}

const fakeEmbed = (vector: Float32Array) => async (_text: string): Promise<Float32Array | null> => vector;
const unitVector = (dim: number, at: number): Float32Array => {
  const v = new Float32Array(dim);
  v[at % dim] = 1;
  return v;
};
const fakeProvider = (vector: Float32Array): IEmbeddingProvider => ({
  embedText: async (_text: string) => vector,
  batchEmbed: async (texts: string[]) => texts.map(() => vector),
  dimensions: vector.length,
  name: "fake-test-provider",
});

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "owned-pipe-"));
  db = initializeDatabase(join(tmpDir, "memory.db"));
  ensureInitialized(db, tmpDir);
  setPersonalState(db, "ready", { reason: "pipeline test ready" });
  mm = new MemoryManager(makeMemoryTestConfig(tmpDir), { ownerSnapshot: OWNER });
  await mm.initialize({ skipEmbeddingCheck: true });
});

afterEach(() => {
  resetEmbedGateForTests();
  resetContinuationsForTests();
  mm.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("mapped database stages", () => {
  it("finds Porter, English-trigram, and source-language matches over projections", async () => {
    seedDurable("the harbor ferry departs at nine");
    seedDurable("valtokezelo hid a Dunán", { original: "a valtokezelo hid a Dunán" });
    build();
    const out = await runOwnedPipeline(pipelineReq({ anchorText: "harbor ferry", keywords: ["ferry"] }));
    expect(out.stageOutcomes.Sf?.status).toBe("completed");
    expect(out.items.some((i) => i.excerpt.includes("harbor ferry"))).toBe(true);
    const hu = await runOwnedPipeline(pipelineReq({ anchorText: "valtokezelo", keywords: ["valtokezelo"] }));
    expect(hu.items.some((i) => i.excerpt.includes("valtokezelo"))).toBe(true);
  });

  it("exercises signature and graph stages within profile budgets", async () => {
    seedDurable("the harbor ferry departs at nine");
    seedDurable("completely unrelated filler about gardening tools");
    build();
    const out = await runOwnedPipeline(pipelineReq({ anchorText: "harbor ferry" }));
    expect(out.stageOutcomes.Ss?.status).toBe("completed");
    expect(out.stageOutcomes.S8?.status).toBe("completed");
    expect(out.items.length).toBeLessThanOrEqual(15);
  });

  it("serves newly derived edges without a rebuild (C8 A14)", async () => {
    seedDurable("the harbor ferry departs at nine");
    build();
    // New durable stating a relationship lands via the single writer into the
    // serving generation; S8 serves it on the next recall with no rebuild.
    const content = "Alice knows Bob in Paris";
    const messageId = insertMessage(content);
    storeDurable(db, {
      userId: OWNER, memoryType: "fact", content,
      authority: "user_statement", authorityBasis: "test",
      applicabilityScope: { scope: "general" },
      provenance: { graph: { entities: ["Alice", "Bob"], relations: [{ a: "Alice", rel: "knows", b: "Bob" }] } },
      evidence: [{ kind: "user_message", ref: String(messageId), excerpt: content, classification: 1 }],
      actorId: "test",
    });
    const out = await runOwnedPipeline(pipelineReq({ anchorText: "Alice Bob", keywords: ["Alice", "Bob"], profile: "recall_full", maxItems: 40 }));
    expect(out.stageOutcomes.S8?.status).toBe("completed");
    const graphItems = out.items.filter((i) => i.ref.kind === "graph");
    expect(graphItems.length).toBeGreaterThan(0);
    expect(graphItems.some((i) => i.excerpt.includes("alice") && i.excerpt.includes("bob"))).toBe(true);
  });

  it("seeds accented entities through diacritic-normalized graph keys (C8)", async () => {
    const content = "Béla knows Duna";
    const messageId = insertMessage(content);
    storeDurable(db, {
      userId: OWNER, memoryType: "fact", content,
      authority: "user_statement", authorityBasis: "test",
      applicabilityScope: { scope: "general" },
      provenance: { graph: { entities: ["Béla", "Duna"], relations: [{ a: "Béla", rel: "knows", b: "Duna" }] } },
      evidence: [{ kind: "user_message", ref: String(messageId), excerpt: content, classification: 1 }],
      actorId: "test",
    });
    build();
    // Stored endpoints are diacritic-normalized; the accented anchor must
    // still seed its own edge instead of missing the adjacency keys.
    const out = await runOwnedPipeline(pipelineReq({ anchorText: "Béla", keywords: ["Béla"], profile: "recall_full", maxItems: 40 }));
    const graphItems = out.items.filter((i) => i.ref.kind === "graph");
    expect(graphItems.length).toBeGreaterThan(0);
    expect(graphItems.some((i) => i.excerpt.includes("bela") && i.excerpt.includes("duna"))).toBe(true);
  });

  it("serves Se cosine matches when vectors exist, and honest outcomes when they do not", async () => {
    seedDurable("the harbor ferry departs at nine");
    build();
    const noVec = await runOwnedPipeline(pipelineReq({ anchorText: "harbor ferry" }));
    expect(noVec.stageOutcomes.Se?.status).toBe("no-provider");
    const withProvider = await runOwnedPipeline(pipelineReq({ anchorText: "harbor ferry", embeddingProvider: fakeProvider(unitVector(8, 1)) }));
    // Provider works but no doc vectors exist yet: completed with zero hits,
    // not a masqueraded negative.
    expect(withProvider.stageOutcomes.Se?.status).toBe("completed");
    expect(withProvider.stageOutcomes.Se?.hitCount).toBe(0);
    // Backfill with a fake embedder, then Se admits on cosine.
    const filled = await backfillRecallVectors(db, OWNER, fakeEmbed(unitVector(8, 1)));
    expect(filled.ok).toBe(true);
    expect(filled.computed).toBe(1);
    const admitted = await runOwnedPipeline(pipelineReq({ anchorText: "harbor ferry", embeddingProvider: fakeProvider(unitVector(8, 1)) }));
    expect(admitted.stageOutcomes.Se?.status).toBe("completed");
  });
});

describe("profiles, prominence, and required evidence", () => {
  it("keeps an old precise zero-prominence episode ahead of a recent weaker one", async () => {
    const oldId = seedEpisode("harbor ferry exact schedule", "s-old", "harbor ferry exact schedule");
    db.prepare("UPDATE short_term_memories SET prominence = 0, start_ts = 1000 WHERE id = ?").run(oldId);
    const newId = seedEpisode("harbor gossip and rumors", "s-new", "harbor gossip and rumors");
    db.prepare("UPDATE short_term_memories SET prominence = 5, start_ts = 9999999 WHERE id = ?").run(newId);
    build();
    const out = await runOwnedPipeline(pipelineReq({ anchorText: "harbor ferry exact schedule", profile: "recall_full", maxItems: 40 }));
    const order = out.items.map((i) => i.docId);
    const oldDoc = db.prepare("SELECT id FROM recall_documents WHERE layer = 'episode' AND record_id = ?").get(oldId) as { id: number };
    const newDoc = db.prepare("SELECT id FROM recall_documents WHERE layer = 'episode' AND record_id = ?").get(newId) as { id: number };
    expect(order).toContain(oldDoc.id);
    expect(order.indexOf(oldDoc.id)).toBeLessThan(order.indexOf(newDoc.id));
  });

  it("attaches unresolved competing claims and scoped exceptions as required evidence", async () => {
    seedDurable("prefers tea");
    seedDurable("prefers juice");
    build();
    const out = await runOwnedPipeline(pipelineReq({ anchorText: "prefers tea", keywords: ["prefers", "tea"], profile: "recall_full", maxItems: 40 }));
    const excerpts = out.items.map((i) => i.excerpt);
    expect(excerpts.some((e) => e.includes("prefers tea"))).toBe(true);
    const required = out.items.filter((i) => i.required);
    expect(required.length).toBeGreaterThan(0);
    expect(required.every((i) => i.rationale.startsWith("required"))).toBe(true);
  });

  it("finds multi-hop paths per profile hop budgets", async () => {
    // Legacy graph with a verified lineage: alpha—beta—gamma—delta—epsilon.
    // Fast sees seed-incident edges only (1 hop); normal reaches the second
    // hop; full reaches the third, proving breadth is work, not result count.
    // #1939 stage 3: entity_graph and the legacy remap are gone. The chain
    // is carried by stored proposal graphs, derived at build time.
    const now = Date.now();
    const mkGraphed = (content: string, a: string, b: string): number => Number(db.prepare(
      `INSERT INTO long_term_memories (user_id, memory_type, content, authority, applicability_scope, provenance, evidence, classification, encrypted, created_at, updated_at)
       VALUES (?, 'fact', ?, 'inference', '{"scope":"general"}', ?, '[]', 1, 0, ?, ?)`,
    ).run(OWNER, content, JSON.stringify({ graph: { entities: [a, b], relations: [{ a, rel: "links", b }] } }), now, now).lastInsertRowid);
    mkGraphed("alpha beta link", "alpha", "beta");
    mkGraphed("beta gamma link", "beta", "gamma");
    mkGraphed("gamma delta link", "gamma", "delta");
    mkGraphed("delta epsilon link", "delta", "epsilon");
    build();
    const graphOnly = (items: Awaited<ReturnType<typeof runOwnedPipeline>>["items"]) =>
      items.filter((i) => i.ref.kind === "graph");
    const fast = await runOwnedPipeline(pipelineReq({ anchorText: "alpha", keywords: ["alpha"], profile: "recall_fast", maxItems: 5 }));
    const normal = await runOwnedPipeline(pipelineReq({ anchorText: "alpha", keywords: ["alpha"], profile: "recall_normal" }));
    const full = await runOwnedPipeline(pipelineReq({ anchorText: "alpha", keywords: ["alpha"], profile: "recall_full", maxItems: 40 }));
    expect(graphOnly(fast.items)).toHaveLength(1);
    expect(graphOnly(normal.items).length).toBeGreaterThan(graphOnly(fast.items).length);
    expect(graphOnly(full.items).length).toBeGreaterThan(graphOnly(normal.items).length);
  });

  it("keeps a required competitor visible under tight capacity", async () => {
    seedDurable("prefers tea");
    seedDurable("prefers juice");
    build();
    const out = await runOwnedPipeline(pipelineReq({
      anchorText: "prefers tea", keywords: ["prefers", "tea"], profile: "recall_full", maxItems: 1,
    }));
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.required).toBe(true);
    expect(out.items[0]?.rationale.startsWith("required")).toBe(true);
  });

  it("resolves as-of history to the then-applicable revision and labels it", async () => {
    const newMsg = insertMessage("prefers herbal tea");
    const { id } = seedDurable("prefers tea");
    const next = supersedeDurable(db, {
      userId: OWNER, memoryId: id, expectedRevision: 1, content: "prefers herbal tea",
      authority: "user_statement", authorityBasis: "correction",
      evidence: [{ kind: "user_message", ref: String(newMsg), excerpt: "prefers herbal tea", classification: 1 }],
      actorId: "test",
    });
    expect(next.revision).toBe(2);
    build();
    const out = await runOwnedPipeline(pipelineReq({
      anchorText: "prefers tea", keywords: ["prefers", "tea"],
      filters: { historyIntent: "as_of", asOf: "2000-01-01" },
    }));
    expect(out.items.length).toBe(0);
    expect(out.omissionReasons.some((r) => r.includes("no-applicable-revision"))).toBe(true);
    // As-of dates are local calendar days (`todayLocal` on write); deriving
    // the test date from UTC would mismatch across a midnight boundary.
    const today = new Date().toLocaleDateString("en-CA");
    const current = await runOwnedPipeline(pipelineReq({
      anchorText: "prefers tea", keywords: ["prefers", "tea"],
      filters: { historyIntent: "as_of", asOf: today },
    }));
    const herbal = current.items.find((i) => i.excerpt.includes("prefers herbal tea"));
    expect(herbal?.currentness).toContain("historical (as of");
  });
});

describe("grounding and neighbors", () => {
  it("grounds normal selections and expands neighbors only for full", async () => {
    const m1 = Number(db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 'chain', 'user', 'first unrelated note', 900)",
    ).run(OWNER).lastInsertRowid);
    const m2 = Number(db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 'chain', 'user', 'the harbor ferry manifest', 1000)",
    ).run(OWNER).lastInsertRowid);
    const m3 = Number(db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 'chain', 'user', 'closing unrelated note', 1100)",
    ).run(OWNER).lastInsertRowid);
    void m1;
    const d = storeDurable(db, {
      userId: OWNER, memoryType: "fact", content: "harbor ferry records",
      authority: "user_statement", authorityBasis: "test", applicabilityScope: { scope: "general" }, provenance: {},
      evidence: [{ kind: "user_message", ref: String(m2), excerpt: "the harbor ferry manifest", classification: 1 }],
      actorId: "test",
    });
    void d;
    void m3;
    build();
    const normal = await runOwnedPipeline(pipelineReq({ anchorText: "harbor ferry records", keywords: ["harbor", "ferry"], profile: "recall_normal" }));
    const normalHit = normal.items.find((i) => i.excerpt.includes("harbor ferry records"));
    expect(normalHit?.excerpt).toContain("Grounded sources:");
    expect(normalHit?.excerpt).not.toContain("closing unrelated note");
    const full = await runOwnedPipeline(pipelineReq({
      anchorText: "harbor ferry records", keywords: ["harbor", "ferry"], profile: "recall_full", maxItems: 40,
    }));
    const fullHit = full.items.find((i) => i.excerpt.includes("harbor ferry records"));
    expect(fullHit?.excerpt).toContain("closing unrelated note");
  });
});

describe("full-only S6 summaries", () => {
  function writeSummary(tier: string, file: string, ownerLine: string, body: string): void {
    mkdirSync(join(tmpDir, tier), { recursive: true });
    writeFileSync(join(tmpDir, tier, file), `${ownerLine}\n\n${body}\n`, "utf-8");
  }
  it("serves authorized summaries for full only, with provenance and dedup", async () => {
    seedDurable("harbor ferry operations");
    build();
    writeSummary("daily", "daily_2026-10-18.md", "Owner: pipeline-owner", "The harbor ferry ran twice today without incident.");
    writeSummary("daily", "daily_2026-10-17.md", "Owner: someone-else", "The harbor ferry ran twice today without incident.");
    const full = await runOwnedPipeline(pipelineReq({
      anchorText: "harbor ferry", profile: "recall_full", maxItems: 40, memoryDir: tmpDir,
    }));
    expect(full.stageOutcomes.S6?.status).toBe("completed");
    const summaries = full.items.filter((i) => i.ref.kind === "artifact");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.excerpt).toContain("harbor ferry");
    expect(summaries[0]?.provenance).toContain("2026-10-18");
    expect(summaries[0]?.ref.kind).toBe("artifact");
    const fast = await runOwnedPipeline(pipelineReq({ anchorText: "harbor ferry", profile: "recall_fast", memoryDir: tmpDir }));
    expect(fast.stageOutcomes.S6?.status).toBe("disabled");
    expect(fast.items.some((i) => i.ref.kind === "artifact")).toBe(false);
    const normal = await runOwnedPipeline(pipelineReq({ anchorText: "harbor ferry", profile: "recall_normal", memoryDir: tmpDir }));
    expect(normal.stageOutcomes.S6?.status).toBe("disabled");
    expect(normal.items.some((i) => i.ref.kind === "artifact")).toBe(false);
  });
});

describe("continuation and capacity", () => {
  it("pages normal results and continues strong evidence into full", async () => {
    for (let i = 0; i < 6; i++) seedDurable(`harbor ferry note number ${i} everyday`);
    build();
    const first = await ownedRecall(mm, {
      contract: OWNED_RECALL_CONTRACT,
      profile: "recall_normal",
      identity: { principal: OWNER },
      query: { text: "harbor ferry everyday" },
    });
    expect(first.status === "evidence" || first.status === "partial").toBe(true);
    expect(first.continuation).toBeDefined();
    const second = await ownedRecall(mm, {
      contract: OWNED_RECALL_CONTRACT,
      profile: "recall_normal",
      identity: { principal: OWNER },
      query: { text: "harbor ferry everyday" },
      continuation: first.continuation,
      capacity: { maxItems: 15 },
    });
    const firstKeys = new Set(first.items.map((i) => i.ref));
    for (const item of second.items) {
      expect(firstKeys.has(item.ref)).toBe(false);
    }
    const full = await ownedRecall(mm, {
      contract: OWNED_RECALL_CONTRACT,
      profile: "recall_full",
      identity: { principal: OWNER },
      query: { text: "harbor ferry everyday" },
      continuation: first.continuation,
    });
    const fullKeys = new Set(full.items.map((i) => JSON.stringify(i.ref)));
    const retained = first.items.filter((i) => fullKeys.has(JSON.stringify(i.ref)));
    expect(retained.length).toBeGreaterThan(0);
    const garbage = await ownedRecall(mm, {
      contract: OWNED_RECALL_CONTRACT,
      profile: "recall_normal",
      identity: { principal: OWNER },
      query: { text: "harbor ferry everyday" },
      continuation: "deadbeef",
    });
    expect(garbage.omissionReasons.some((r) => r.includes("continuation_expired"))).toBe(true);
  });
});

describe("bounded failure", () => {
  it("keeps deterministic recall when embeddings are off and reports stage outcomes", async () => {
    seedDurable("harbor ferry operations");
    build();
    const out = await runOwnedPipeline(pipelineReq({ anchorText: "harbor ferry" }));
    expect(["disabled", "no-provider", "failed"].includes(out.stageOutcomes.Se?.status ?? "")).toBe(true);
    expect(out.items.length).toBeGreaterThan(0);
  });

  it("survives a failed stage without taking the turn down", async () => {
    seedDurable("harbor ferry operations");
    build();
    // Corrupt every Sf surface: the stage fails honestly while Ss/Se
    // probabilities and deterministic fallbacks still serve.
    db.exec("DROP TABLE recall_fts");
    db.exec("DROP TABLE recall_trigram_en");
    db.exec("DROP TABLE recall_trigram_orig");
    const out = await runOwnedPipeline(pipelineReq({ anchorText: "harbor ferry" }));
    expect(out.stageOutcomes.Sf?.status).toBe("failed");
    expect(out.items.length).toBeGreaterThan(0);
  });

  it("cancels cleanly and never publishes late results", async () => {
    seedDurable("harbor ferry operations");
    build();
    const controller = new AbortController();
    controller.abort();
    const packet = await ownedRecall(mm, {
      contract: OWNED_RECALL_CONTRACT,
      profile: "recall_fast",
      identity: { principal: OWNER },
      rawTurn: "harbor ferry",
    }, { signal: controller.signal });
    expect(packet.status).toBe("cancelled");
    expect(packet.items).toEqual([]);
  });

  it("degrades Se under provider saturation without blocking deterministic recall", async () => {
    seedDurable("harbor ferry operations");
    build();
    const hanging = {
      embedText: (_text: string) => new Promise<Float32Array | null>(() => {}),
      batchEmbed: async (_texts: string[]) => [] as Array<Float32Array | null>,
      dimensions: 8,
      name: "hanging-test-provider",
    } satisfies IEmbeddingProvider;
    const a = runOwnedPipeline(pipelineReq({ anchorText: "harbor ferry one", embeddingProvider: hanging }));
    const b = runOwnedPipeline(pipelineReq({ anchorText: "harbor ferry two", embeddingProvider: hanging }));
    const c = runOwnedPipeline(pipelineReq({ anchorText: "harbor ferry three", embeddingProvider: hanging }));
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(embedGateStatus().total).toBeGreaterThan(0);
    for (const r of [ra, rb, rc]) {
      expect(r.items.length).toBeGreaterThan(0);
    }
    const busyCount = [ra, rb, rc].filter((r) => (r.stageOutcomes.Se?.reason ?? "").startsWith("se-busy")).length;
    expect(busyCount).toBeGreaterThanOrEqual(1);
    // A deadline on a requested stage is degradation, not complete evidence.
    const scored = [ra, rb, rc].filter((r) => r.stageOutcomes.Se?.status === "deadline");
    expect(scored.length).toBeGreaterThanOrEqual(1);
  });

  it("labels a degraded stage as partial in the owner packet", async () => {
    seedDurable("harbor ferry operations");
    build();
    const hanging = {
      embedText: (_text: string) => new Promise<Float32Array | null>(() => {}),
      batchEmbed: async (_texts: string[]) => [] as Array<Float32Array | null>,
      dimensions: 8,
      name: "hanging-packet-provider",
    } satisfies IEmbeddingProvider;
    const spy = vi.spyOn(mm, "getEmbeddingProvider").mockReturnValue(hanging);
    try {
      const packet = await ownedRecall(mm, {
        contract: OWNED_RECALL_CONTRACT,
        profile: "recall_normal",
        identity: { principal: OWNER },
        query: { text: "harbor ferry operations" },
      });
      expect(packet.items.length).toBeGreaterThan(0);
      expect(packet.status).toBe("partial");
      expect(packet.omissionReasons.some((r) => r.startsWith("stage-degraded: Se"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("profile budgets", () => {
  it("applies the frozen C3 profile bounds", () => {
    expect(OWNED_STAGE_BUDGETS.recall_fast.lexicalProbe).toBe(24);
    expect(OWNED_STAGE_BUDGETS.recall_normal.lexicalProbe).toBe(64);
    expect(OWNED_STAGE_BUDGETS.recall_full.lexicalProbe).toBe(192);
    expect(OWNED_STAGE_BUDGETS.recall_full.groundingExcerpts).toBe(32);
  });
});
