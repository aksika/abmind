/**
 * recall-projection-build.test.ts — #1928 M2 retrieval projections.
 *
 * Pins the generation barrier: empty DDL, verified-backup gate, build →
 * verify → publish, idempotent resume, writer maintenance, forget
 * suppression, restore invalidation, and the authenticated status surface.
 * All databases are ephemeral; no live apply is exercised here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
import { dispatchGetRuntimeStatus } from "./abmind-memory-dispatch.js";
import {
  RECALL_PROJECTION_VERSION,
  getProjectionState,
  servingGeneration,
  inspectRecallProjection,
  verifyRecallProjection,
  buildRecallProjection,
  invalidateRecallProjections,
  indexDurableDocument,
  recallProjectionStatus,
  deriveDurableGraphEdges,
  normalizeGraphEntity,
  parseGraphEntities,
  parseGraphRelations,
  validateGraphProposal,
} from "./recall-projection-build.js";

const OWNER = "projection-owner";

let tmpDir: string;
let db: Database.Database;

function insertMessage(userId: string, sessionId: string, content: string): number {
  return Number(db.prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, 1000)",
  ).run(userId, sessionId, content).lastInsertRowid);
}

function seedDurable(content: string): { id: number; messageId: number } {
  const messageId = insertMessage(OWNER, "s1", content);
  const d = storeDurable(db, {
    userId: OWNER, memoryType: "fact", content, authority: "user_statement",
    authorityBasis: "test", applicabilityScope: { scope: "general" }, provenance: {},
    evidence: [{ kind: "user_message", ref: String(messageId), excerpt: content, classification: 1 }],
    actorId: "test",
  });
  return { id: d.id, messageId };
}

function seedEpisode(topic: string): number {
  const u = insertMessage(OWNER, "s2", `${topic} user turn`);
  const a = insertMessage(OWNER, "s2", `${topic} assistant turn`);
  const excerpt = `${topic} user turn`;
  const e = createEpisode(db, {
    userId: OWNER, topic, startTs: 1000, endTs: 2000, sessionIds: ["s2"],
    sourceMessageIds: [u, a],
    evidenceExcerpts: [{ messageId: u, excerpt, classification: 1 }],
    actorId: "test",
  });
  return e.id;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "recall-proj-"));
  db = initializeDatabase(join(tmpDir, "memory.db"));
  ensureInitialized(db, tmpDir);
  setPersonalState(db, "ready", { reason: "projection test ready" });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("DDL and initial state", () => {
  it("creates empty projection surfaces that never assert readiness", () => {
    for (const table of ["recall_documents", "recall_fts", "recall_trigram_en", "recall_trigram_orig", "recall_vectors", "recall_graph_edges", "recall_projection_state"]) {
      const found = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual') AND name = ?").get(table);
      expect(found, table).toBeTruthy();
    }
    expect(getProjectionState(db).state).toBe("not_built");
    expect(servingGeneration(db)).toBeNull();
  });

  it("refuses a build without a verified backup", () => {
    seedDurable("backups guard the build");
    const outcome = buildRecallProjection(db, OWNER, { verifiedBackup: false });
    expect(outcome.ok).toBe(false);
    expect(getProjectionState(db).state).toBe("not_built");
  });
});

describe("inspect, build, verify, publish", () => {
  it("indexes eligible rows, finds them through FTS and trigrams, and publishes only after verification", () => {
    const d = seedDurable("the harbor ferry departs at nine");
    const e = seedEpisode("harbor logistics");
    const before = inspectRecallProjection(db, OWNER);
    expect(before.state).toBe("not_built");
    expect(before.eligibleDurables.map((x) => x.id)).toContain(d.id);
    expect(before.eligibleEpisodes.map((x) => x.id)).toContain(e);
    expect(before.missing.length).toBeGreaterThan(0);

    const built = buildRecallProjection(db, OWNER, { verifiedBackup: true });
    expect(built.ok).toBe(true);
    expect(built.generation).toBe(1);
    expect(built.indexedDurables).toBe(1);
    expect(built.indexedEpisodes).toBe(1);

    const snap = getProjectionState(db);
    expect(snap.state).toBe("ready");
    expect(snap.servingGeneration).toBe(1);
    expect(snap.projectionVersion).toBe(RECALL_PROJECTION_VERSION);
    expect(servingGeneration(db)).toBe(1);

    // Porter FTS over safe text.
    const fts = db.prepare("SELECT rowid FROM recall_fts WHERE recall_fts MATCH 'ferry'").all() as Array<{ rowid: number }>;
    expect(fts.length).toBe(1);
    // Trigram fuzzy retrieval over English and original surfaces.
    const triEn = db.prepare("SELECT rowid FROM recall_trigram_en WHERE content LIKE '%ferr%'").all() as Array<{ rowid: number }>;
    expect(triEn.length).toBe(1);
    const triOrig = db.prepare("SELECT count(*) AS c FROM recall_trigram_orig").get() as { c: number };
    expect(triOrig.c).toBe(2);
    // Every published document carries a local signature.
    const sigless = db.prepare("SELECT COUNT(*) AS c FROM recall_documents WHERE generation = 1 AND signature IS NULL").get() as { c: number };
    expect(sigless.c).toBe(0);

    const verified = verifyRecallProjection(db, OWNER, 1);
    expect(verified).toEqual({ ok: true, reasons: [] });
    const after = inspectRecallProjection(db, OWNER);
    expect(after.missing).toEqual([]);
    expect(after.stale).toEqual([]);
  });

  it("excludes sealed, encrypted, superseded, and foreign rows from every surface", () => {
    const d = seedDurable("ordinary eligible fact");
    const now = Date.now();
    db.prepare(
      `INSERT INTO long_term_memories (user_id, memory_type, content, authority, applicability_scope, evidence, classification, encrypted, created_at, updated_at)
       VALUES (?, 'fact', 'sealed sentinel value', 'inference', '{"scope":"general"}', '[]', 3, 1, ?, ?)`,
    ).run(OWNER, now, now);
    db.prepare(
      `INSERT INTO long_term_memories (user_id, memory_type, content, authority, applicability_scope, evidence, classification, encrypted, created_at, updated_at)
       VALUES ('intruder', 'fact', 'foreign fact', 'inference', '{"scope":"general"}', '[]', 1, 0, ?, ?)`,
    ).run(now, now);
    const built = buildRecallProjection(db, OWNER, { verifiedBackup: true });
    expect(built.ok).toBe(true);
    expect(built.indexedDurables).toBe(1);
    const docs = db.prepare("SELECT record_id, owner, safe_text FROM recall_documents WHERE generation = 1").all() as Array<{ record_id: number; owner: string; safe_text: string }>;
    expect(docs.map((r) => r.record_id)).toEqual([d.id]);
    expect(docs.every((r) => r.owner === OWNER)).toBe(true);
    expect(docs.some((r) => r.safe_text.includes("sealed sentinel"))).toBe(false);
  });

  it("resumes after an interrupted build without serving mixed generations", () => {
    seedDurable("resumable fact");
    const first = buildRecallProjection(db, OWNER, { verifiedBackup: true });
    expect(first.ok).toBe(true);
    // Simulate an interrupted next generation: partial rows, stale pointer.
    db.prepare("INSERT INTO recall_projection_state (singleton, state, serving_generation, building_generation, projection_version, reason, progress, updated_at) VALUES (1, 'interrupted', 1, 2, 1, 'crash', '{}', ?) ON CONFLICT(singleton) DO UPDATE SET state='interrupted', building_generation=2, reason='crash'").run(Date.now());
    db.prepare(
      "INSERT INTO recall_documents (layer, record_id, owner, source_version, generation, safe_text, scope, authority, classification, source_refs) VALUES ('durable', 999, ?, 'stale', 2, 'orphan', '{\"scope\":\"general\"}', 'inference', 1, '[]')",
    ).run(OWNER);
    const resumed = buildRecallProjection(db, OWNER, { verifiedBackup: true });
    expect(resumed.ok).toBe(true);
    expect(resumed.generation).toBe(2);
    const orphans = db.prepare("SELECT COUNT(*) AS c FROM recall_documents WHERE generation != 2").get() as { c: number };
    expect(orphans.c).toBe(0);
    expect(getProjectionState(db)).toMatchObject({ state: "ready", servingGeneration: 2 });
  });
});

describe("single-writer maintenance and forgetting", () => {
  it("indexes new and corrected rows behind the serving generation", () => {
    const first = buildRecallProjection(db, OWNER, { verifiedBackup: true });
    expect(first.ok).toBe(true);
    const d = seedDurable("freshly stored fact");
    const row = db.prepare("SELECT source_version FROM recall_documents WHERE generation = 1 AND layer = 'durable' AND record_id = ?").get(d.id) as { source_version: string } | undefined;
    expect(row?.source_version).toBe("1");
    const next = supersedeDurable(db, {
      userId: OWNER, memoryId: d.id, expectedRevision: 1, content: "corrected fact",
      authority: "user_statement", authorityBasis: "test correction",
      evidence: [{ kind: "user_message", ref: String(d.messageId), excerpt: "freshly stored fact", classification: 1 }],
      actorId: "test",
    });
    expect(next.revision).toBe(2);
    const versions = db.prepare("SELECT source_version FROM recall_documents WHERE generation = 1 AND layer = 'durable' AND record_id = ?").all(d.id) as Array<{ source_version: string }>;
    expect(versions.map((v) => v.source_version)).toEqual(["2"]);
    expect(verifyRecallProjection(db, OWNER, 1).ok).toBe(true);
  });

  it("forgetting suppresses serving rows in the same barrier and never resurrects them", () => {
    const d = seedDurable("forgettable fact");
    const e = seedEpisode("forgettable topic");
    expect(buildRecallProjection(db, OWNER, { verifiedBackup: true }).ok).toBe(true);
    const op = forgetPersonal(db, { owner: OWNER, callerOwner: OWNER, targets: [{ kind: "durable", id: d.id }], memoryDir: tmpDir, actorId: "test" });
    expect(op.state).toBe("complete");
    const remaining = db.prepare("SELECT COUNT(*) AS c FROM recall_documents WHERE generation = 1").get() as { c: number };
    // Only the episode document survives; the forgotten durable is gone.
    expect(remaining.c).toBe(1);
    const survivor = db.prepare("SELECT layer, record_id FROM recall_documents WHERE generation = 1").get() as { layer: string; record_id: number };
    expect(survivor).toMatchObject({ layer: "episode", record_id: e });
    // A rebuild after forgetting stays clean: nothing resurrects.
    const rebuilt = buildRecallProjection(db, OWNER, { verifiedBackup: true });
    expect(rebuilt.ok).toBe(true);
    expect(verifyRecallProjection(db, OWNER, rebuilt.generation ?? -1).ok).toBe(true);
    const after = db.prepare("SELECT COUNT(*) AS c FROM recall_documents WHERE generation = ?").get(rebuilt.generation) as { c: number };
    expect(after.c).toBe(1);
  });
});

describe("restore invalidation and status", () => {
  it("clears every projection surface and returns to not_built", () => {
    seedDurable("pre-restore fact");
    expect(buildRecallProjection(db, OWNER, { verifiedBackup: true }).ok).toBe(true);
    expect(servingGeneration(db)).toBe(1);
    invalidateRecallProjections(db);
    expect(getProjectionState(db).state).toBe("not_built");
    expect(servingGeneration(db)).toBeNull();
    const count = db.prepare("SELECT COUNT(*) AS c FROM recall_documents").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("does nothing to in-flight maintenance when no generation serves", () => {
    const d = seedDurable("pre-activation fact");
    // No serving generation: writer maintenance is a silent no-op.
    expect(() => indexDurableDocument(db, OWNER, d.id)).not.toThrow();
    expect(getProjectionState(db).state).toBe("not_built");
  });

  it("reports ready personal content and a not_built projection on an initialized manager", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-proj-mm-"));
    const mm = new MemoryManager(makeMemoryTestConfig(dir), { ownerSnapshot: OWNER });
    await mm.initialize({ skipEmbeddingCheck: true });
    try {
      const handle = getMemoryDb(mm);
      if (!handle) throw new Error("manager database missing");
      const { setPersonalState: setReady } = await import("./personal-schema.js");
      setReady(handle, "ready", { reason: "status test ready" });
      const receipt = dispatchGetRuntimeStatus(mm, {}) as unknown as {
        personal: { state: string } | null;
        projection: { state: string; servingGeneration: number | null; indexedDocuments: number } | null;
      } | null;
      expect(receipt?.personal?.state).toBe("ready");
      // No generation was built in this database: distinct from ready content.
      expect(receipt?.projection?.state).toBe("not_built");
      expect(receipt?.projection?.servingGeneration).toBeNull();
      const status = recallProjectionStatus(handle);
      expect(status.state).toBe("not_built");
    } finally {
      mm.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("C8 derived graph edges (option C)", () => {
  function seedWithGraph(content: string, entities: string[], relations: Array<{ a: string; rel: string; b: string }>): { id: number; messageId: number } {
    const messageId = insertMessage(OWNER, "s1", content);
    const d = storeDurable(db, {
      userId: OWNER, memoryType: "fact", content, authority: "user_statement",
      authorityBasis: "test", applicabilityScope: { scope: "general" },
      provenance: { graph: { entities, relations } },
      evidence: [{ kind: "user_message", ref: String(messageId), excerpt: content, classification: 1 }],
      actorId: "test",
    });
    return { id: d.id, messageId };
  }

  it("derives source-bound edges on store without a rebuild, and drops invalid endpoints", () => {
    expect(buildRecallProjection(db, OWNER, { verifiedBackup: true }).ok).toBe(true);
    const gen = servingGeneration(db);
    expect(gen).toBe(1);
    const { id } = seedWithGraph("Alice knows Bob in Paris", ["Alice", "Bob", "Nowhere"], [
      { a: "Alice", rel: "knows", b: "Bob" },
      { a: "Alice", rel: "works-at", b: "Nowhere" },
    ]);
    // Only the fully-stated relation survives; Nowhere never appears.
    const edges = db.prepare("SELECT entity_a, entity_b, relation, src_record_id, src_version, generation FROM recall_graph_edges WHERE owner = ? AND generation = ?").all(OWNER, gen) as Array<{ entity_a: string; entity_b: string; relation: string; src_record_id: number; src_version: string; generation: number }>;
    const ours = edges.filter((e) => e.src_record_id === id);
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ entity_a: "alice", entity_b: "bob", relation: "knows", src_version: "1" });
    expect(verifyRecallProjection(db, OWNER, gen!).ok).toBe(true);
  });

  it("re-derives on revision, removes on forget, and rebuilds idempotently", () => {
    const { id, messageId } = seedWithGraph("Alice knows Bob", ["Alice", "Bob"], [{ a: "Alice", rel: "knows", b: "Bob" }]);
    expect(buildRecallProjection(db, OWNER, { verifiedBackup: true }).ok).toBe(true);
    const gen = servingGeneration(db)!;
    expect(db.prepare("SELECT COUNT(*) AS c FROM recall_graph_edges WHERE owner = ? AND generation = ? AND src_record_id = ?").get(OWNER, gen, id) as { c: number }).toEqual({ c: 1 });
    // Revise with a new relationship: old edge leaves (via drop), new edge arrives.
    const carolMsg = insertMessage(OWNER, "s1", "Alice works with Carol");
    const next = supersedeDurable(db, {
      userId: OWNER, memoryId: id, expectedRevision: 1, content: "Alice works with Carol",
      authority: "user_statement", authorityBasis: "test correction",
      evidence: [{ kind: "user_message", ref: String(carolMsg), excerpt: "Alice works with Carol", classification: 1 }],
      actorId: "test",
      graph: { entities: ["Alice", "Carol"], relations: [{ a: "Alice", rel: "works-at", b: "Carol" }] },
    });
    expect(next.revision).toBe(2);
    const after = db.prepare("SELECT entity_a, entity_b, relation, src_version FROM recall_graph_edges WHERE owner = ? AND generation = ? AND src_record_id = ?").all(OWNER, gen, id) as Array<{ entity_a: string; entity_b: string; relation: string; src_version: string }>;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ entity_a: "alice", entity_b: "carol", relation: "works-at", src_version: "2" });
    // Rebuild reproduces the same edge set.
    const rebuilt = buildRecallProjection(db, OWNER, { verifiedBackup: true });
    expect(rebuilt.ok).toBe(true);
    const gen2 = rebuilt.generation!;
    const rebuiltEdges = db.prepare("SELECT entity_a, entity_b, relation, src_record_id, src_version FROM recall_graph_edges WHERE owner = ? AND generation = ? AND src_record_id = ?").all(OWNER, gen2, id) as Array<unknown>;
    expect(rebuiltEdges).toHaveLength(1);
    expect(verifyRecallProjection(db, OWNER, gen2).ok).toBe(true);
    // Forget removes serving edges.
    const op = forgetPersonal(db, { owner: OWNER, callerOwner: OWNER, targets: [{ kind: "durable", id }], memoryDir: tmpDir, actorId: "test" });
    expect(op.state).toBe("complete");
    expect(db.prepare("SELECT COUNT(*) AS c FROM recall_graph_edges WHERE owner = ? AND src_record_id = ?").get(OWNER, id) as { c: number }).toEqual({ c: 0 });
  });

  it("yields no edge for sealed, foreign, or unproven sources", () => {
    expect(buildRecallProjection(db, OWNER, { verifiedBackup: true }).ok).toBe(true);
    const gen = servingGeneration(db)!;
    // Missing id (or a foreign owner's id) derives nothing for OWNER.
    expect(deriveDurableGraphEdges(db, OWNER, 999999, gen)).toBe(0);
    // Sealed/class-3 writes are refused upstream; a class-2 durable with an
    // unknown label coerces to related rather than dropping the edge.
    const { id } = seedWithGraph("Alice knows Bob", ["Alice", "Bob"], [{ a: "Alice", rel: "not-a-real-label", b: "Bob" }]);
    const edge = db.prepare("SELECT relation FROM recall_graph_edges WHERE owner = ? AND generation = ? AND src_record_id = ?").get(OWNER, gen, id) as { relation: string } | undefined;
    expect(edge?.relation).toBe("related");
    // Normalization is diacritic-aware and lower-cases.
    expect(normalizeGraphEntity("  BÉLA  ")).toBe("bela");
    expect(parseGraphEntities(undefined)).toBeNull();
    expect(parseGraphRelations("Alice|knows|Bob")).toEqual([{ a: "Alice", rel: "knows", b: "Bob" }]);
    expect(validateGraphProposal("nothing relevant", [], ["Alice"], [{ a: "Alice", rel: "knows", b: "Bob" }]).relations).toEqual([]);
  });

  it("derives nothing from a sealed, class-3, or foreign durable that carries a graph", () => {
    expect(buildRecallProjection(db, OWNER, { verifiedBackup: true }).ok).toBe(true);
    const gen = servingGeneration(db)!;
    const now = Date.now();
    const graph = JSON.stringify({ graph: { entities: ["Alice", "Bob"], relations: [{ a: "Alice", rel: "knows", b: "Bob" }] } });
    const sealedId = Number(db.prepare(
      `INSERT INTO long_term_memories (user_id, memory_type, content, authority, applicability_scope, provenance, evidence, classification, encrypted, created_at, updated_at)
       VALUES (?, 'fact', 'Alice knows Bob', 'inference', '{"scope":"general"}', ?, '[]', 3, 1, ?, ?)`,
    ).run(OWNER, graph, now, now).lastInsertRowid);
    const foreignId = Number(db.prepare(
      `INSERT INTO long_term_memories (user_id, memory_type, content, authority, applicability_scope, provenance, evidence, classification, encrypted, created_at, updated_at)
       VALUES ('intruder', 'fact', 'Alice knows Bob', 'inference', '{"scope":"general"}', ?, '[]', 1, 0, ?, ?)`,
    ).run(graph, now, now).lastInsertRowid);
    expect(deriveDurableGraphEdges(db, OWNER, sealedId, gen)).toBe(0);
    expect(deriveDurableGraphEdges(db, OWNER, foreignId, gen)).toBe(0);
    const count = db.prepare("SELECT COUNT(*) AS c FROM recall_graph_edges WHERE owner = ? AND generation = ?").get(OWNER, gen) as { c: number };
    expect(count.c).toBe(0);
  });

  it("serves a derived edge for a durable with a stored graph (no legacy remap)", () => {
    // #1939 stage 3: entity_graph and the legacy remap are gone. Derived
    // edges come only from the durable's stored proposal graph.
    const now = Date.now();
    const convertedId = Number(db.prepare(
      `INSERT INTO long_term_memories (user_id, memory_type, content, authority, applicability_scope, provenance, evidence, classification, encrypted, created_at, updated_at)
       VALUES (?, 'fact', 'Alice knows Bob', 'inference', '{"scope":"general"}', ?, '[]', 1, 0, ?, ?)`,
    ).run(OWNER, JSON.stringify({ graph: { entities: ["Alice", "Bob"], relations: [{ a: "Alice", rel: "knows", b: "Bob" }] } }), now, now).lastInsertRowid);
    const built = buildRecallProjection(db, OWNER, { verifiedBackup: true });
    expect(built.ok).toBe(true);
    const gen = built.generation!;
    const edges = db.prepare("SELECT entity_a, entity_b, src_record_id FROM recall_graph_edges WHERE owner = ? AND generation = ? AND src_record_id = ?").all(OWNER, gen, convertedId) as Array<{ entity_a: string; entity_b: string; src_record_id: number }>;
    expect(edges.some((e) => e.entity_a === "alice" && e.entity_b === "bob")).toBe(true);
    expect(edges.some((e) => e.entity_a === "buda" && e.entity_b === "pest")).toBe(false);
    expect(verifyRecallProjection(db, OWNER, gen).ok).toBe(true);
  });
});

