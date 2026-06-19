import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { queryPath, queryEntityRelationships, isKnownEntity, upsertEdge } from "./entity-graph.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE entity_graph (
    id INTEGER PRIMARY KEY,
    entity_a TEXT NOT NULL,
    entity_b TEXT NOT NULL,
    relation TEXT NOT NULL,
    source_memory_id INTEGER,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    UNIQUE(entity_a, entity_b, relation)
  )`);
  db.exec(`CREATE TABLE extracted_memories (
    id INTEGER PRIMARY KEY, classification INTEGER DEFAULT 1
  )`);
  db.exec(`CREATE INDEX idx_eg_a ON entity_graph(entity_a)`);
  db.exec(`CREATE INDEX idx_eg_b ON entity_graph(entity_b)`);
  return db;
}

describe("entity-graph multi-hop (#831)", () => {
  let db: Database.Database;

  beforeAll(() => {
    db = createTestDb();
    // alice → acme (works-at), acme → budapest (located-in), alice → bob (friends)
    upsertEdge(db, { entity_a: "alice", entity_b: "acme", relation: "works-at" });
    upsertEdge(db, { entity_a: "acme", entity_b: "budapest", relation: "located-in" });
    upsertEdge(db, { entity_a: "alice", entity_b: "bob", relation: "friends" });
    // SECRET edge: bob → cia (works-at), source_memory classification=3
    db.exec("INSERT INTO extracted_memories (id, classification) VALUES (99, 3)");
    db.prepare("INSERT INTO entity_graph (entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES ('bob', 'cia', 'works-at', 99, 1, 1)").run();
  });

  it("finds direct edge (1-hop)", () => {
    const paths = queryPath(db, "alice", "acme", 2);
    expect(paths.length).toBeGreaterThanOrEqual(1);
    expect(paths[0]!.hops).toBe(1);
    expect(paths[0]!.description).toContain("works-at");
  });

  it("finds 2-hop path via intermediate", () => {
    const paths = queryPath(db, "alice", "budapest", 2);
    expect(paths.length).toBeGreaterThanOrEqual(1);
    const twoHop = paths.find(p => p.hops === 2);
    expect(twoHop).toBeDefined();
    expect(twoHop!.description).toContain("acme");
    expect(twoHop!.description).toContain("budapest");
  });

  it("returns empty when no path exists", () => {
    const paths = queryPath(db, "alice", "mars", 2);
    expect(paths.length).toBe(0);
  });

  it("BLP filtering hides SECRET edges", () => {
    // classification=3 edge (bob→cia) should be hidden at maxClassification=2
    const paths = queryPath(db, "bob", "cia", 2);
    expect(paths.length).toBe(0);

    // visible at maxClassification=3
    const visible = queryPath(db, "bob", "cia", 3);
    expect(visible.length).toBeGreaterThanOrEqual(1);
  });

  it("isKnownEntity works", () => {
    expect(isKnownEntity(db, "alice")).toBe(true);
    expect(isKnownEntity(db, "nobody")).toBe(false);
  });

  it("single-hop queryEntityRelationships still works", () => {
    const edges = queryEntityRelationships(db, "alice", 2);
    expect(edges.length).toBeGreaterThanOrEqual(2); // acme + bob
  });
});
