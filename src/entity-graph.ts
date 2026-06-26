/**
 * entity-graph.ts — Entity relationship store + query for S8 recall layer.
 */

import type Database from "better-sqlite3";
import { logTrace } from "./mem-logger.js";

export type EntityEdge = {
  id: number;
  entity_a: string;
  entity_b: string;
  relation: string;
  source_memory_id: number | null;
  created_at: number;
  last_seen_at: number;
};

/** Insert or update an entity relationship edge. */
export function upsertEdge(
  db: Database.Database,
  edge: { entity_a: string; entity_b: string; relation: string; source_memory_id?: number },
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO entity_graph (entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at)
    VALUES (lower(?), lower(?), ?, ?, ?, ?)
    ON CONFLICT(entity_a, entity_b, relation) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      source_memory_id = excluded.source_memory_id
  `).run(edge.entity_a, edge.entity_b, edge.relation, edge.source_memory_id ?? null, now, now);
}

/**
 * S8 recall: find relationships for a given entity.
 * Respects BLP (classification) — SECRET edges only visible when caller allows.
 *
 * Historical note: this used to also filter `credibility <= 3` under the
 * comment "skip contradicted sources". That was wrong: contradictions never
 * decrement credibility (only 7-day aging does, 6→3), so the filter silently
 * hid all fresh edges. Removed in #361.
 */
export function queryEntityRelationships(
  db: Database.Database,
  entity: string,
  maxClassification: number,
): EntityEdge[] {
  const normalized = entity.toLowerCase();
  const results = db.prepare(`
    SELECT eg.*
    FROM entity_graph eg
    LEFT JOIN extracted_memories em ON eg.source_memory_id = em.id
    WHERE (eg.entity_a = ? OR eg.entity_b = ?)
      AND (em.id IS NULL OR em.classification <= ?)
    ORDER BY eg.last_seen_at DESC
    LIMIT 10
  `).all(normalized, normalized, maxClassification) as EntityEdge[];
  logTrace("entity-graph", `query "${entity}" → ${results.length} edges`);
  return results;
}

/** Check if an entity exists in the graph. */
export function isKnownEntity(db: Database.Database, entity: string): boolean {
  const normalized = entity.toLowerCase();
  const row = db.prepare(
    `SELECT 1 FROM entity_graph WHERE entity_a = ? OR entity_b = ? LIMIT 1`,
  ).get(normalized, normalized);
  return row !== undefined;
}

export interface PathResult {
  hops: 1 | 2;
  edges: EntityEdge[];
  description: string; // "A —[rel]→ B" or "A —[rel]→ X —[rel]→ B"
}

/**
 * #831: Multi-hop traversal — find path between two entities (max 2 hops).
 * Returns direct edges (1-hop) and paths via intermediates (2-hop).
 */
export function queryPath(
  db: Database.Database,
  entityA: string,
  entityB: string,
  maxClassification: number,
): PathResult[] {
  const a = entityA.toLowerCase();
  const b = entityB.toLowerCase();
  const results: PathResult[] = [];

  // 1-hop: direct edge between A and B
  const direct = db.prepare(`
    SELECT eg.* FROM entity_graph eg
    LEFT JOIN extracted_memories em ON eg.source_memory_id = em.id
    WHERE ((eg.entity_a = ? AND eg.entity_b = ?) OR (eg.entity_a = ? AND eg.entity_b = ?))
      AND (em.id IS NULL OR em.classification <= ?)
    ORDER BY eg.last_seen_at DESC LIMIT 5
  `).all(a, b, b, a, maxClassification) as EntityEdge[];

  for (const edge of direct) {
    results.push({ hops: 1, edges: [edge], description: `${edge.entity_a} —[${edge.relation}]→ ${edge.entity_b}` });
  }

  // 2-hop: A→X→B via intermediate
  const twoHop = db.prepare(`
    SELECT eg1.id as id1, eg1.entity_a as a1, eg1.entity_b as b1, eg1.relation as r1, eg1.last_seen_at as ls1,
           eg2.id as id2, eg2.entity_a as a2, eg2.entity_b as b2, eg2.relation as r2, eg2.last_seen_at as ls2
    FROM entity_graph eg1
    JOIN entity_graph eg2 ON (eg1.entity_b = eg2.entity_a OR eg1.entity_b = eg2.entity_b)
    LEFT JOIN extracted_memories em1 ON eg1.source_memory_id = em1.id
    LEFT JOIN extracted_memories em2 ON eg2.source_memory_id = em2.id
    WHERE eg1.entity_a = ?
      AND (eg2.entity_a = ? OR eg2.entity_b = ?)
      AND eg1.entity_b != ?
      AND (em1.id IS NULL OR em1.classification <= ?)
      AND (em2.id IS NULL OR em2.classification <= ?)
    LIMIT 15
  `).all(a, b, b, b, maxClassification, maxClassification) as Array<Record<string, any>>;

  for (const row of twoHop) {
    const mid = row.b1 as string;
    const desc = `${row.a1} —[${row.r1}]→ ${mid} —[${row.r2}]→ ${row.b2}`;
    results.push({
      hops: 2,
      edges: [
        { id: row.id1, entity_a: row.a1, entity_b: row.b1, relation: row.r1, source_memory_id: null, created_at: 0, last_seen_at: row.ls1 },
        { id: row.id2, entity_a: row.a2, entity_b: row.b2, relation: row.r2, source_memory_id: null, created_at: 0, last_seen_at: row.ls2 },
      ],
      description: desc,
    });
  }

  // Also try with A and B swapped (undirected graph)
  if (results.length === 0) {
    const twoHopRev = db.prepare(`
      SELECT eg1.id as id1, eg1.entity_a as a1, eg1.entity_b as b1, eg1.relation as r1, eg1.last_seen_at as ls1,
             eg2.id as id2, eg2.entity_a as a2, eg2.entity_b as b2, eg2.relation as r2, eg2.last_seen_at as ls2
      FROM entity_graph eg1
      JOIN entity_graph eg2 ON (eg1.entity_b = eg2.entity_a OR eg1.entity_b = eg2.entity_b)
      LEFT JOIN extracted_memories em1 ON eg1.source_memory_id = em1.id
      LEFT JOIN extracted_memories em2 ON eg2.source_memory_id = em2.id
      WHERE eg1.entity_a = ?
        AND (eg2.entity_a = ? OR eg2.entity_b = ?)
        AND eg1.entity_b != ?
        AND (em1.id IS NULL OR em1.classification <= ?)
        AND (em2.id IS NULL OR em2.classification <= ?)
      LIMIT 15
    `).all(b, a, a, a, maxClassification, maxClassification) as Array<Record<string, any>>;

    for (const row of twoHopRev) {
      const mid = row.b1 as string;
      const desc = `${row.a1} —[${row.r1}]→ ${mid} —[${row.r2}]→ ${row.b2}`;
      results.push({
        hops: 2,
        edges: [
          { id: row.id1, entity_a: row.a1, entity_b: row.b1, relation: row.r1, source_memory_id: null, created_at: 0, last_seen_at: row.ls1 },
          { id: row.id2, entity_a: row.a2, entity_b: row.b2, relation: row.r2, source_memory_id: null, created_at: 0, last_seen_at: row.ls2 },
        ],
        description: desc,
      });
    }
  }

  logTrace("entity-graph", `queryPath "${entityA}" → "${entityB}": ${results.length} paths`);
  return results.slice(0, 20);
}
