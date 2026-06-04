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
