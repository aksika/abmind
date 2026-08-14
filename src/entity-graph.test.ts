import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { queryPath, queryEntityRelationships, isKnownEntity, upsertEdge } from "./entity-graph.js";

const OWNER = "owner-user";
const FOREIGN = "foreign-user";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE entity_graph (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL,
    entity_a TEXT NOT NULL,
    entity_b TEXT NOT NULL,
    relation TEXT NOT NULL,
    source_memory_id INTEGER,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    UNIQUE(user_id, entity_a, entity_b, relation)
  )`);
  db.exec(`CREATE TABLE extracted_memories (
    id INTEGER PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'x', classification INTEGER DEFAULT 1
  )`);
  db.exec(`CREATE INDEX idx_eg_owner_a ON entity_graph(user_id, entity_a)`);
  db.exec(`CREATE INDEX idx_eg_owner_b ON entity_graph(user_id, entity_b)`);
  return db;
}

describe("entity-graph multi-hop (#831, #1658 owner-scoped)", () => {
  let db: Database.Database;

  beforeAll(() => {
    db = createTestDb();
    // alice → acme (works-at), acme → budapest (located-in), alice → bob (friends)
    upsertEdge(db, { userId: OWNER, entity_a: "alice", entity_b: "acme", relation: "works-at" });
    upsertEdge(db, { userId: OWNER, entity_a: "acme", entity_b: "budapest", relation: "located-in" });
    upsertEdge(db, { userId: OWNER, entity_a: "alice", entity_b: "bob", relation: "friends" });
    // SECRET edge: bob → cia (works-at), FOREIGN-owned, source classification=3
    db.exec("INSERT INTO extracted_memories (id, user_id, classification) VALUES (99, 'other-user', 3)");
    db.prepare("INSERT INTO entity_graph (user_id, entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES (?, 'bob', 'cia', 'works-at', 99, 1, 1)").run(FOREIGN);
  });

  it("finds direct edge (1-hop)", () => {
    const paths = queryPath(db, "alice", "acme", 2, OWNER);
    expect(paths.length).toBeGreaterThanOrEqual(1);
    expect(paths[0]!.hops).toBe(1);
    expect(paths[0]!.description).toContain("works-at");
  });

  it("finds 2-hop path via intermediate", () => {
    const paths = queryPath(db, "alice", "budapest", 2, OWNER);
    expect(paths.length).toBeGreaterThanOrEqual(1);
    const twoHop = paths.find(p => p.hops === 2);
    expect(twoHop).toBeDefined();
    expect(twoHop!.description).toContain("acme");
    expect(twoHop!.description).toContain("budapest");
  });

  it("returns empty when no path exists", () => {
    const paths = queryPath(db, "alice", "mars", 2, OWNER);
    expect(paths.length).toBe(0);
  });

  it("BLP filtering: foreign class-3-sourced edges are invisible at any cap", () => {
    // The bob→cia edge is foreign-owned with a class-3 source: the source is
    // neither owned by the caller nor shared (class 0-1), so the edge is
    // invisible at maxClassification=2 AND 3.
    const hidden = queryPath(db, "bob", "cia", 2, OWNER);
    expect(hidden.length).toBe(0);
    const alsoHidden = queryPath(db, "bob", "cia", 3, OWNER);
    expect(alsoHidden.length).toBe(0);
  });

  it("owned edges are visible regardless of their source classification", () => {
    db.exec("INSERT INTO extracted_memories (id, user_id, classification) VALUES (95, 'owner-user', 3)");
    db.prepare("INSERT INTO entity_graph (user_id, entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES ('owner-user', 'own-a', 'own-b', 'secret-of-mine', 95, 1, 1)").run();
    expect(queryPath(db, "own-a", "own-b", 2, OWNER).length).toBeGreaterThanOrEqual(1);
    expect(isKnownEntity(db, "own-a", 2, OWNER)).toBe(true);
  });

  it("foreign edges are visible only when their source is shared class 0-1", () => {
    // foreign source-less edge — invisible to the owner
    db.prepare("INSERT INTO entity_graph (user_id, entity_a, entity_b, relation, created_at, last_seen_at) VALUES ('foreign-user', 'xavier', 'yale', 'knows', 1, 1)").run();
    expect(queryEntityRelationships(db, "xavier", 2, OWNER).length).toBe(0);
    expect(isKnownEntity(db, "xavier", 2, OWNER)).toBe(false);
    // foreign edge with a shared class-1 source — visible
    db.exec("INSERT INTO extracted_memories (id, user_id, classification) VALUES (98, 'foreign-user', 1)");
    db.prepare("INSERT INTO entity_graph (user_id, entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES ('foreign-user', 'xena', 'yarra', 'knows', 98, 1, 1)").run();
    expect(queryEntityRelationships(db, "xena", 2, OWNER).length).toBe(1);
    // foreign edge with a foreign private class-2 source — invisible
    db.exec("INSERT INTO extracted_memories (id, user_id, classification) VALUES (97, 'foreign-user', 2)");
    db.prepare("INSERT INTO entity_graph (user_id, entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES ('foreign-user', 'zoe', 'zane', 'knows', 97, 1, 1)").run();
    expect(queryEntityRelationships(db, "zoe", 2, OWNER).length).toBe(0);
  });

  it("isKnownEntity works for owner-visible entities only", () => {
    expect(isKnownEntity(db, "alice", 2, OWNER)).toBe(true);
    expect(isKnownEntity(db, "nobody", 2, OWNER)).toBe(false);
    expect(isKnownEntity(db, "xavier", 2, OWNER)).toBe(false);
    expect(isKnownEntity(db, "xena", 2, OWNER)).toBe(true);
  });

  it("single-hop queryEntityRelationships returns owner edges", () => {
    const edges = queryEntityRelationships(db, "alice", 2, OWNER);
    expect(edges.length).toBeGreaterThanOrEqual(2); // acme + bob
  });

  it("upsertEdge requires a source owned by the edge owner", () => {
    db.exec("INSERT INTO extracted_memories (id, user_id, classification) VALUES (96, 'other-user', 1)");
    expect(() => upsertEdge(db, { userId: OWNER, entity_a: "p", entity_b: "q", relation: "r", source_memory_id: 96 })).toThrow(/does not exist under owner/);
    // owned source passes (memory 95 is owned by owner-user)
    expect(() => upsertEdge(db, { userId: OWNER, entity_a: "p", entity_b: "q", relation: "r", source_memory_id: 95 })).not.toThrow();
  });

  it("owner-scoped uniqueness allows the same pair under different owners", () => {
    upsertEdge(db, { userId: OWNER, entity_a: "alice", entity_b: "acme", relation: "works-at" });
    expect(() => upsertEdge(db, { userId: FOREIGN, entity_a: "alice", entity_b: "acme", relation: "works-at" })).not.toThrow();
    const count = db.prepare("SELECT COUNT(*) AS c FROM entity_graph WHERE entity_a = 'alice' AND entity_b = 'acme'").get() as { c: number };
    expect(count.c).toBe(2);
  });
});
