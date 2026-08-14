/**
 * entity-graph.ts — Entity relationship store + query for S8 recall layer.
 *
 * #1658/#1660: entity_graph is owner-scoped — every row carries a non-null
 * user_id that participates in uniqueness. All reads apply the shared-or-owned
 * visibility predicate and the permanent class-2 ceiling; class-3 edges are
 * never ordinary recall context, including when owned by the caller.
 */

import type Database from "better-sqlite3";
import { logTrace } from "./mem-logger.js";
import { effectiveMaxClassification } from "./memory-visibility.js";

export type EntityEdge = {
  id: number;
  user_id: string;
  entity_a: string;
  entity_b: string;
  relation: string;
  source_memory_id: number | null;
  created_at: number;
  last_seen_at: number;
};

/**
 * Visibility predicate for one edge/source alias pair.
 *
 *   an owner-owned source-less edge remains visible, or
 *   em.id IS NOT NULL
 *   AND em.user_id = eg.user_id
 *   AND em.classification <= :ceiling
 *   AND (em.classification <= 1 OR eg.user_id = :principal)
 */

/** Insert or update an entity relationship edge, owner-required (#1658). */
export function upsertEdge(
  db: Database.Database,
  edge: { userId: string; entity_a: string; entity_b: string; relation: string; source_memory_id?: number },
): void {
  const now = Date.now();
  if (edge.source_memory_id !== undefined) {
    const source = db.prepare(
      "SELECT id FROM extracted_memories WHERE id = ? AND user_id = ?",
    ).get(edge.source_memory_id, edge.userId);
    if (!source) {
      throw new Error(`graph edge source memory ${edge.source_memory_id} does not exist under owner ${edge.userId}`);
    }
  }
  db.prepare(`
    INSERT INTO entity_graph (user_id, entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at)
    VALUES (?, lower(?), lower(?), ?, ?, ?, ?)
    ON CONFLICT(user_id, entity_a, entity_b, relation) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      source_memory_id = excluded.source_memory_id
  `).run(edge.userId, edge.entity_a, edge.entity_b, edge.relation, edge.source_memory_id ?? null, now, now);
}

/**
 * S8 recall: find relationships for a given entity.
 * Shared-or-owned visibility: a foreign edge is visible only when its source
 * exists, belongs to the edge owner, is class 0-1 and within the caller's cap.
 */
export function queryEntityRelationships(
  db: Database.Database,
  entity: string,
  maxClassification: number,
  userId: string,
): EntityEdge[] {
  const normalized = entity.toLowerCase();
  const ceiling = effectiveMaxClassification(maxClassification);
  const results = db.prepare(`
    SELECT eg.*
    FROM entity_graph eg
    LEFT JOIN extracted_memories em ON eg.source_memory_id = em.id
    WHERE (eg.entity_a = ? OR eg.entity_b = ?)
      AND (${EDGE_VISIBILITY})
    ORDER BY eg.last_seen_at DESC
    LIMIT 10
  `).all(normalized, normalized, userId, ceiling, userId) as EntityEdge[];
  logTrace("entity-graph", `query "${entity}" → ${results.length} edges`);
  return results;
}

/** Check if an entity exists in the graph (owner-visible only). */
export function isKnownEntity(db: Database.Database, entity: string, maxClassification: number, userId: string): boolean {
  const normalized = entity.toLowerCase();
  const ceiling = effectiveMaxClassification(maxClassification);
  const row = db.prepare(
    `SELECT 1 FROM entity_graph eg
     LEFT JOIN extracted_memories em ON eg.source_memory_id = em.id
     WHERE (eg.entity_a = ? OR eg.entity_b = ?)
       AND (${EDGE_VISIBILITY})
     LIMIT 1`,
  ).get(normalized, normalized, userId, ceiling, userId);
  return row !== undefined;
}

export interface PathResult {
  hops: 1 | 2;
  edges: EntityEdge[];
  description: string; // "A —[rel]→ B" or "A —[rel]→ X —[rel]→ B"
}

const EDGE_VISIBILITY = `(
  (em.id IS NULL AND eg.user_id = ?)
  OR (
    em.id IS NOT NULL
    AND em.user_id = eg.user_id
    AND COALESCE(em.classification, 0) <= ?
    AND (COALESCE(em.classification, 0) <= 1 OR eg.user_id = ?)
  )
)`;

/**
 * #831: Multi-hop traversal — find path between two entities (max 2 hops).
 * Both one-hop and both directions of two-hop traversal apply the shared
 * visibility predicate per edge/source pair. Real source IDs are preserved.
 */
export function queryPath(
  db: Database.Database,
  entityA: string,
  entityB: string,
  maxClassification: number,
  userId: string,
): PathResult[] {
  const a = entityA.toLowerCase();
  const b = entityB.toLowerCase();
  const ceiling = effectiveMaxClassification(maxClassification);
  const results: PathResult[] = [];

  const oneHop = db.prepare(`
    SELECT eg.* FROM entity_graph eg
    LEFT JOIN extracted_memories em ON eg.source_memory_id = em.id
    WHERE ((eg.entity_a = ? AND eg.entity_b = ?) OR (eg.entity_a = ? AND eg.entity_b = ?))
      AND (${EDGE_VISIBILITY})
    ORDER BY eg.last_seen_at DESC LIMIT 5
  `).all(a, b, b, a, userId, ceiling, userId) as EntityEdge[];

  for (const edge of oneHop) {
    results.push({ hops: 1, edges: [edge], description: `${edge.entity_a} —[${edge.relation}]→ ${edge.entity_b}` });
  }

  const twoHopQuery = (start: string, end: string, skip: string): Array<Record<string, unknown>> => {
    return db.prepare(`
      SELECT eg1.id as id1, eg1.user_id as u1, eg1.entity_a as a1, eg1.entity_b as b1, eg1.relation as r1, eg1.last_seen_at as ls1, eg1.source_memory_id as src1,
             eg2.id as id2, eg2.user_id as u2, eg2.entity_a as a2, eg2.entity_b as b2, eg2.relation as r2, eg2.last_seen_at as ls2, eg2.source_memory_id as src2
      FROM entity_graph eg1
      JOIN entity_graph eg2 ON (eg1.entity_b = eg2.entity_a OR eg1.entity_b = eg2.entity_b)
      LEFT JOIN extracted_memories em1 ON eg1.source_memory_id = em1.id
      LEFT JOIN extracted_memories em2 ON eg2.source_memory_id = em2.id
      WHERE eg1.entity_a = ?
        AND (eg2.entity_a = ? OR eg2.entity_b = ?)
        AND eg1.entity_b != ?
        AND (${EDGE_VISIBILITY.replaceAll("eg.", "eg1.").replaceAll("em.", "em1.")})
        AND (${EDGE_VISIBILITY.replaceAll("eg.", "eg2.").replaceAll("em.", "em2.")})
      LIMIT 15
    `).all(start, end, end, skip, userId, ceiling, userId, userId, ceiling, userId) as Array<Record<string, unknown>>;
  };

  const twoHop = twoHopQuery(a, b, b);
  for (const row of twoHop) {
    const mid = row.b1 as string;
    const desc = `${row.a1} —[${row.r1}]→ ${mid} —[${row.r2}]→ ${row.b2}`;
    results.push({
      hops: 2,
      edges: [
        { id: row.id1 as number, user_id: row.u1 as string, entity_a: row.a1 as string, entity_b: row.b1 as string, relation: row.r1 as string, source_memory_id: (row.src1 as number | null) ?? null, created_at: 0, last_seen_at: row.ls1 as number },
        { id: row.id2 as number, user_id: row.u2 as string, entity_a: row.a2 as string, entity_b: row.b2 as string, relation: row.r2 as string, source_memory_id: (row.src2 as number | null) ?? null, created_at: 0, last_seen_at: row.ls2 as number },
      ],
      description: desc,
    });
  }

  // Also try with A and B swapped (undirected graph)
  if (results.length === 0) {
    const twoHopRev = twoHopQuery(b, a, a);
    for (const row of twoHopRev) {
      const mid = row.b1 as string;
      const desc = `${row.a1} —[${row.r1}]→ ${mid} —[${row.r2}]→ ${row.b2}`;
      results.push({
        hops: 2,
        edges: [
          { id: row.id1 as number, user_id: row.u1 as string, entity_a: row.a1 as string, entity_b: row.b1 as string, relation: row.r1 as string, source_memory_id: (row.src1 as number | null) ?? null, created_at: 0, last_seen_at: row.ls1 as number },
          { id: row.id2 as number, user_id: row.u2 as string, entity_a: row.a2 as string, entity_b: row.b2 as string, relation: row.r2 as string, source_memory_id: (row.src2 as number | null) ?? null, created_at: 0, last_seen_at: row.ls2 as number },
        ],
        description: desc,
      });
    }
  }

  logTrace("entity-graph", `queryPath "${entityA}" → "${entityB}": ${results.length} paths`);
  return results.slice(0, 20);
}
