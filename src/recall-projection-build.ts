/**
 * recall-projection-build — #1928 M2 new-model retrieval projections.
 *
 * Builds and maintains the derived document registry (+FTS/trigram,
 * signature, vector, graph bindings) over primary-owned eligible durable
 * revisions and episodes, behind a generation barrier. The serving
 * generation never changes until a complete build passes verification;
 * interrupted builds resume idempotently without serving mixed generations
 * or resurrecting forgotten content.
 *
 * Structural DDL lives in personal-schema.ts (empty surfaces only).
 * Backfill here requires a verified backup. Live apply on any host is a
 * separate per-host authorization; tests use ephemeral databases only.
 */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { generateSignature } from "./signature-generator.js";
import { isSuppressedByForget } from "./personal-forget.js";
import { loadEmbedConfig } from "./ollama-embed.js";

export const RECALL_PROJECTION_VERSION = 1;

export type RecallProjectionStateName = "not_built" | "building" | "ready" | "interrupted" | "failed";

export interface RecallProjectionSnapshot {
  readonly state: RecallProjectionStateName;
  readonly servingGeneration: number | null;
  readonly buildingGeneration: number | null;
  readonly projectionVersion: number;
  readonly reason: string | null;
  readonly progress: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Durable versions identify the actual retained revision. */
export function durableSourceVersion(revision: number): string {
  return String(revision);
}

/**
 * Episode/raw versions are deterministic source-content versions, so
 * redaction invalidates old refs without a database revision column.
 * Canonical definition shared with the owned recall packet (C2).
 */
export function episodeSourceVersion(topic: string, outcomes: string | null, unresolved: string | null, evidenceExcerpts: string): string {
  return createHash("sha256")
    .update([topic, outcomes ?? "", unresolved ?? "", evidenceExcerpts].join("\0"), "utf-8")
    .digest("hex");
}

function tableExists(db: Database.Database, name: string): boolean {
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','virtual') AND name = ?").get(name) !== undefined;
  } catch {
    return false;
  }
}

/** No state row (or no tables yet) means never built — never ready. */
export function getProjectionState(db: Database.Database): RecallProjectionSnapshot {
  const empty: RecallProjectionSnapshot = {
    state: "not_built", servingGeneration: null, buildingGeneration: null,
    projectionVersion: RECALL_PROJECTION_VERSION, reason: null, progress: {},
  };
  if (!tableExists(db, "recall_projection_state")) return empty;
  let row: {
    state: RecallProjectionStateName; serving_generation: number | null;
    building_generation: number | null; projection_version: number;
    reason: string | null; progress: string;
  } | undefined;
  try {
    row = db.prepare(
      "SELECT state, serving_generation, building_generation, projection_version, reason, progress FROM recall_projection_state WHERE singleton = 1",
    ).get() as typeof row;
  } catch {
    return empty;
  }
  if (!row) return empty;
  let progress: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.progress);
    if (isRecord(parsed)) progress = parsed;
  } catch {
    // Corrupt progress metadata never marks a generation ready; verify fails.
  }
  return {
    state: row.state, servingGeneration: row.serving_generation,
    buildingGeneration: row.building_generation, projectionVersion: row.projection_version,
    reason: row.reason, progress,
  };
}

/**
 * Generation currently serving recall. Set while ready; retained during a
 * rebuild so an older compatible generation can serve after every
 * candidate is revalidated (M3 enforces the revalidation). Null behind
 * every other state — partial indexes never imply full coverage.
 */
export function servingGeneration(db: Database.Database): number | null {
  const snap = getProjectionState(db);
  if ((snap.state === "ready" || snap.state === "building") && snap.servingGeneration !== null) {
    return snap.servingGeneration;
  }
  return null;
}

function writeState(db: Database.Database, snap: Omit<RecallProjectionSnapshot, "projectionVersion" | "progress"> & { progress?: Record<string, unknown> }): void {
  db.prepare(
    `INSERT INTO recall_projection_state (singleton, state, serving_generation, building_generation, projection_version, reason, progress, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET state=excluded.state, serving_generation=excluded.serving_generation,
       building_generation=excluded.building_generation, projection_version=excluded.projection_version,
       reason=excluded.reason, progress=excluded.progress, updated_at=excluded.updated_at`,
  ).run(
    snap.state, snap.servingGeneration, snap.buildingGeneration,
    RECALL_PROJECTION_VERSION, snap.reason, JSON.stringify(snap.progress ?? {}), Date.now(),
  );
}

type EligibleDurable = {
  id: number; revision: number; content: string; contentOriginal: string | null;
  authority: string; scope: string; classification: number; evidence: string;
};

type EligibleEpisode = {
  id: number; topic: string; outcomes: string | null; unresolved: string | null; evidenceExcerpts: string;
};

function eligibleDurables(db: Database.Database, owner: string): EligibleDurable[] {
  let rows: Array<{
    id: number; revision: number; content: string; content_original: string | null;
    authority: string; applicability_scope: string; classification: number; evidence: string;
  }>;
  try {
    rows = db.prepare(
      `SELECT id, revision, content, content_original, authority, applicability_scope, classification, evidence
       FROM long_term_memories WHERE user_id = ? AND superseded_by_id IS NULL AND classification <= 2 AND encrypted = 0`,
    ).all(owner) as typeof rows;
  } catch {
    return [];
  }
  return rows
    .filter((r) => {
      try {
        return !isSuppressedByForget(db, owner, { durableId: r.id });
      } catch {
        return false;
      }
    })
    .map((r) => ({
      id: r.id, revision: r.revision, content: r.content, contentOriginal: r.content_original,
      authority: r.authority, scope: r.applicability_scope, classification: r.classification, evidence: r.evidence,
    }));
}

function eligibleEpisodes(db: Database.Database, owner: string): EligibleEpisode[] {
  let rows: Array<{ id: number; topic: string; outcomes: string | null; unresolved: string | null; evidence_excerpts: string }>;
  try {
    rows = db.prepare(
      "SELECT id, topic, outcomes, unresolved, evidence_excerpts FROM short_term_memories WHERE user_id = ? AND classification <= 2 AND encrypted = 0",
    ).all(owner) as typeof rows;
  } catch {
    return [];
  }
  const filtered = rows.filter((r) => {
    try {
      return !isSuppressedByForget(db, owner, { episodeId: r.id });
    } catch {
      return false;
    }
  });
  return filtered.map((r) => ({
    id: r.id, topic: r.topic, outcomes: r.outcomes, unresolved: r.unresolved, evidenceExcerpts: r.evidence_excerpts,
  }));
}

/** Numeric message refs behind evidence entries (durables and episodes). */
export function evidenceMessageIds(evidenceRaw: string): number[] {
  let entries: unknown;
  try {
    entries = JSON.parse(evidenceRaw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const ids: number[] = [];
  for (const e of entries) {
    if (!isRecord(e)) continue;
    const raw = e.messageId !== undefined ? String(e.messageId) : String(e.ref ?? "");
    const match = /^([1-9]\d*)$/.exec(raw.trim());
    const captured = match?.[1];
    if (captured) ids.push(Number(captured));
  }
  return ids;
}

function insertDurableDoc(db: Database.Database, owner: string, generation: number, row: EligibleDurable): void {
  const version = durableSourceVersion(row.revision);
  const safeText = row.content;
  db.prepare(
    `INSERT INTO recall_documents
      (layer, record_id, owner, source_version, generation, safe_text, original_text, keywords, scope, authority, classification, source_refs, signature)
     VALUES ('durable', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)
     ON CONFLICT(layer, record_id, owner, source_version, generation) DO NOTHING`,
  ).run(
    row.id, owner, version, generation, safeText, row.contentOriginal ?? "",
    row.scope, row.authority, row.classification,
    JSON.stringify(evidenceMessageIds(row.evidence)),
    Buffer.from(generateSignature(safeText)),
  );
}

function insertEpisodeDoc(db: Database.Database, owner: string, generation: number, row: EligibleEpisode): void {
  const version = episodeSourceVersion(row.topic, row.outcomes, row.unresolved, row.evidenceExcerpts);
  const safeText = [row.topic, row.outcomes, row.unresolved].filter((s): s is string => typeof s === "string" && s.length > 0).join("\n");
  db.prepare(
    `INSERT INTO recall_documents
      (layer, record_id, owner, source_version, generation, safe_text, original_text, keywords, scope, authority, classification, source_refs, signature)
     VALUES ('episode', ?, ?, ?, ?, ?, ?, '', '{"scope":"general"}', 'inference', 1, ?, ?)
     ON CONFLICT(layer, record_id, owner, source_version, generation) DO NOTHING`,
  ).run(
    row.id, owner, version, generation, safeText, safeText,
    JSON.stringify(evidenceMessageIds(row.evidenceExcerpts)),
    Buffer.from(generateSignature(safeText)),
  );
}

function ftsIntegrityOk(db: Database.Database, table: string): boolean {
  try {
    db.prepare(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`).run();
    return true;
  } catch {
    return false;
  }
}

export interface RecallProjectionInspection {
  readonly state: RecallProjectionStateName;
  readonly servingGeneration: number | null;
  readonly indexedDurables: number;
  readonly indexedEpisodes: number;
  readonly eligibleDurables: Array<{ id: number; revision: number }>;
  readonly eligibleEpisodes: Array<{ id: number; version: string }>;
  readonly missing: Array<{ layer: string; id: number }>;
  readonly stale: Array<{ layer: string; id: number; reason: string }>;
  readonly graphRemapable: number;
  readonly graphUnverifiable: number;
  readonly ftsIntegrityOk: boolean;
}

/** Metadata-only dry run: ids/versions and coverage gaps, never content. */
export function inspectRecallProjection(db: Database.Database, owner: string): RecallProjectionInspection {
  const snap = getProjectionState(db);
  const durables = eligibleDurables(db, owner);
  const episodes = eligibleEpisodes(db, owner);
  const missing: Array<{ layer: string; id: number }> = [];
  const stale: Array<{ layer: string; id: number; reason: string }> = [];
  if (snap.servingGeneration !== null && tableExists(db, "recall_documents")) {
    try {
      const have = db.prepare(
        "SELECT layer, record_id, source_version, signature FROM recall_documents WHERE owner = ? AND generation = ?",
      ).all(owner, snap.servingGeneration) as Array<{ layer: string; record_id: number; source_version: string; signature: Buffer | null }>;
      const haveMap = new Map(have.map((h) => [`${h.layer}:${h.record_id}`, h]));
      for (const d of durables) {
        const key = `durable:${d.id}`;
        const found = haveMap.get(key);
        if (!found) missing.push({ layer: "durable", id: d.id });
        else if (found.source_version !== durableSourceVersion(d.revision)) stale.push({ layer: "durable", id: d.id, reason: "version-mismatch" });
        else if (!found.signature) stale.push({ layer: "durable", id: d.id, reason: "missing-signature" });
        haveMap.delete(key);
      }
      for (const e of episodes) {
        const key = `episode:${e.id}`;
        const found = haveMap.get(key);
        const version = episodeSourceVersion(e.topic, e.outcomes, e.unresolved, e.evidenceExcerpts);
        if (!found) missing.push({ layer: "episode", id: e.id });
        else if (found.source_version !== version) stale.push({ layer: "episode", id: e.id, reason: "version-mismatch" });
        else if (!found.signature) stale.push({ layer: "episode", id: e.id, reason: "missing-signature" });
        haveMap.delete(key);
      }
      for (const [key] of haveMap) {
        const [layer, id] = key.split(":");
        if (layer && id) stale.push({ layer, id: Number(id), reason: "no-eligible-source" });
      }
    } catch {
      // A failed inventory read is itself reported: treat everything as missing.
      for (const d of durables) missing.push({ layer: "durable", id: d.id });
      for (const e of episodes) missing.push({ layer: "episode", id: e.id });
    }
  } else {
    for (const d of durables) missing.push({ layer: "durable", id: d.id });
    for (const e of episodes) missing.push({ layer: "episode", id: e.id });
  }
  let indexedDurables = 0, indexedEpisodes = 0;
  if (snap.servingGeneration !== null && tableExists(db, "recall_documents")) {
    try {
      const counts = db.prepare(
        "SELECT layer, COUNT(*) AS c FROM recall_documents WHERE owner = ? AND generation = ? GROUP BY layer",
      ).all(owner, snap.servingGeneration) as Array<{ layer: string; c: number }>;
      for (const c of counts) {
        if (c.layer === "durable") indexedDurables = c.c;
        else if (c.layer === "episode") indexedEpisodes = c.c;
      }
    } catch {
      // Counts stay zero; the missing/stale lists carry the evidence.
    }
  }
  const graph = countRemapableGraphEdges(db, owner);
  return {
    state: snap.state, servingGeneration: snap.servingGeneration,
    indexedDurables, indexedEpisodes,
    eligibleDurables: durables.map((d) => ({ id: d.id, revision: d.revision })),
    eligibleEpisodes: episodes.map((e) => ({ id: e.id, version: episodeSourceVersion(e.topic, e.outcomes, e.unresolved, e.evidenceExcerpts) })),
    missing, stale, graphRemapable: graph.remapable, graphUnverifiable: graph.unverifiable,
    ftsIntegrityOk: ftsIntegrityOk(db, "recall_fts") && ftsIntegrityOk(db, "recall_trigram_en") && ftsIntegrityOk(db, "recall_trigram_orig"),
  };
}

function countRemapableGraphEdges(db: Database.Database, owner: string): { remapable: number; unverifiable: number } {
  let edges: Array<{ source_memory_id: number | null }>;
  try {
    edges = db.prepare("SELECT source_memory_id FROM entity_graph WHERE user_id = ?").all(owner) as typeof edges;
  } catch {
    return { remapable: 0, unverifiable: 0 };
  }
  let remapable = 0, unverifiable = 0;
  for (const edge of edges) {
    if (edge.source_memory_id === null || edge.source_memory_id === undefined) {
      unverifiable++;
      continue;
    }
    let lineage: { id: number } | undefined;
    try {
      lineage = db.prepare(
        `SELECT id FROM long_term_memories WHERE user_id = ? AND superseded_by_id IS NULL AND classification <= 2 AND encrypted = 0
         AND json_valid(provenance) AND json_extract(provenance, '$.legacyId') = ?`,
      ).get(owner, edge.source_memory_id) as typeof lineage;
    } catch {
      lineage = undefined;
    }
    if (lineage) remapable++;
    else unverifiable++;
  }
  return { remapable, unverifiable };
}

function discardUnservedGenerations(db: Database.Database): void {
  const snap = getProjectionState(db);
  const keep = snap.servingGeneration;
  const txn = db.transaction(() => {
    if (keep === null) {
      db.prepare("DELETE FROM recall_graph_edges").run();
      db.prepare("DELETE FROM recall_vectors").run();
      db.prepare("DELETE FROM recall_documents").run();
    } else {
      db.prepare("DELETE FROM recall_graph_edges WHERE generation != ?").run(keep);
      db.prepare(
        "DELETE FROM recall_vectors WHERE doc_id IN (SELECT id FROM recall_documents WHERE generation != ?)",
      ).run(keep);
      db.prepare("DELETE FROM recall_documents WHERE generation != ?").run(keep);
    }
  });
  txn();
}

/** Remap legacy graph edges through verified legacy-ID lineage only. */
function remapGraphEdges(db: Database.Database, owner: string, generation: number): { remapped: number; unverifiable: number } {
  let edges: Array<{ entity_a: string; entity_b: string; relation: string; source_memory_id: number | null }>;
  try {
    edges = db.prepare(
      "SELECT entity_a, entity_b, relation, source_memory_id FROM entity_graph WHERE user_id = ?",
    ).all(owner) as typeof edges;
  } catch {
    return { remapped: 0, unverifiable: 0 };
  }
  let remapped = 0, unverifiable = 0;
  const insert = db.prepare(
    `INSERT INTO recall_graph_edges (owner, entity_a, entity_b, relation, src_layer, src_record_id, src_version, generation)
     VALUES (?, lower(?), lower(?), ?, 'durable', ?, ?, ?)
     ON CONFLICT(owner, entity_a, entity_b, relation, src_layer, src_record_id, generation) DO NOTHING`,
  );
  for (const edge of edges) {
    if (edge.source_memory_id === null || edge.source_memory_id === undefined) {
      unverifiable++;
      continue;
    }
    let lineage: { id: number; revision: number } | undefined;
    try {
      lineage = db.prepare(
        `SELECT id, revision FROM long_term_memories WHERE user_id = ? AND superseded_by_id IS NULL AND classification <= 2 AND encrypted = 0
         AND json_valid(provenance) AND json_extract(provenance, '$.legacyId') = ?`,
      ).get(owner, edge.source_memory_id) as typeof lineage;
    } catch {
      lineage = undefined;
    }
    if (!lineage) {
      unverifiable++;
      continue;
    }
    try {
      if (isSuppressedByForget(db, owner, { durableId: lineage.id })) {
        unverifiable++;
        continue;
      }
    } catch {
      unverifiable++;
      continue;
    }
    insert.run(owner, edge.entity_a, edge.entity_b, edge.relation, lineage.id, durableSourceVersion(lineage.revision), generation);
    remapped++;
  }
  return { remapped, unverifiable };
}

export interface RecallVerifyOutcome {
  readonly ok: boolean;
  readonly reasons: string[];
}

/** Full source reconciliation + index integrity + forgetting/privacy checks. */
export function verifyRecallProjection(db: Database.Database, owner: string, generation: number): RecallVerifyOutcome {
  const reasons: string[] = [];
  try {
    const blocked = db.prepare("SELECT 1 FROM forget_operations WHERE owner = ? AND state = 'pending' LIMIT 1").get(owner);
    if (blocked) return { ok: false, reasons: ["forget-pending"] };
  } catch {
    return { ok: false, reasons: ["forget-barrier-unreadable"] };
  }
  const durables = eligibleDurables(db, owner);
  const episodes = eligibleEpisodes(db, owner);
  let docs: Array<{ layer: string; record_id: number; source_version: string; signature: Buffer | null; classification: number }>;
  try {
    docs = db.prepare(
      "SELECT layer, record_id, source_version, signature, classification FROM recall_documents WHERE owner = ? AND generation = ?",
    ).all(owner, generation) as typeof docs;
  } catch {
    return { ok: false, reasons: ["registry-unreadable"] };
  }
  const docMap = new Map(docs.map((d) => [`${d.layer}:${d.record_id}`, d]));
  for (const d of durables) {
    const found = docMap.get(`durable:${d.id}`);
    if (!found) reasons.push(`missing-doc: durable ${d.id}`);
    else if (found.source_version !== durableSourceVersion(d.revision)) reasons.push(`stale-doc: durable ${d.id}`);
    else if (!found.signature) reasons.push(`missing-signature: durable ${d.id}`);
    docMap.delete(`durable:${d.id}`);
  }
  for (const e of episodes) {
    const version = episodeSourceVersion(e.topic, e.outcomes, e.unresolved, e.evidenceExcerpts);
    const found = docMap.get(`episode:${e.id}`);
    if (!found) reasons.push(`missing-doc: episode ${e.id}`);
    else if (found.source_version !== version) reasons.push(`stale-doc: episode ${e.id}`);
    else if (!found.signature) reasons.push(`missing-signature: episode ${e.id}`);
    docMap.delete(`episode:${e.id}`);
  }
  for (const [key] of docMap) reasons.push(`no-eligible-source: ${key}`);
  if (!ftsIntegrityOk(db, "recall_fts")) reasons.push("fts-corrupt: recall_fts");
  if (!ftsIntegrityOk(db, "recall_trigram_en")) reasons.push("fts-corrupt: recall_trigram_en");
  if (!ftsIntegrityOk(db, "recall_trigram_orig")) reasons.push("fts-corrupt: recall_trigram_orig");
  try {
    const staleVectors = db.prepare(
      `SELECT v.doc_id FROM recall_vectors v JOIN recall_documents d ON d.id = v.doc_id
       WHERE d.owner = ? AND d.generation = ? AND v.source_version != d.source_version`,
    ).all(owner, generation) as Array<{ doc_id: number }>;
    for (const v of staleVectors) reasons.push(`stale-vector: doc ${v.doc_id}`);
  } catch {
    reasons.push("vectors-unreadable");
  }
  try {
    const edges = db.prepare(
      "SELECT src_record_id, src_version FROM recall_graph_edges WHERE owner = ? AND generation = ?",
    ).all(owner, generation) as Array<{ src_record_id: number; src_version: string }>;
    for (const edge of edges) {
      const source = db.prepare(
        "SELECT revision FROM long_term_memories WHERE id = ? AND user_id = ? AND superseded_by_id IS NULL AND classification <= 2 AND encrypted = 0",
      ).get(edge.src_record_id, owner) as { revision: number } | undefined;
      if (!source || durableSourceVersion(source.revision) !== edge.src_version) {
        reasons.push(`graph-source-ineligible: durable ${edge.src_record_id}`);
      }
    }
  } catch {
    reasons.push("graph-unreadable");
  }
  return { ok: reasons.length === 0, reasons };
}

export interface RecallBuildOutcome {
  readonly ok: boolean;
  readonly generation?: number;
  readonly indexedDurables?: number;
  readonly indexedEpisodes?: number;
  readonly graphRemapped?: number;
  readonly graphUnverifiable?: number;
  readonly refused?: string;
  readonly reasons?: string[];
}

/**
 * Reviewed build: requires a verified backup, discards unserved
 * generations, indexes every eligible source, remaps verifiable graph
 * edges, then publishes only after verification passes. Idempotent:
 * an interrupted build resumes by discarding its partial generation.
 * A pending forget barrier fails the build instead of publishing an
 * empty generation over blocked sources.
 */
export function buildRecallProjection(
  db: Database.Database,
  owner: string,
  opts: { verifiedBackup: boolean },
): RecallBuildOutcome {
  if (!opts.verifiedBackup) {
    return { ok: false, refused: "build requires a verified backup" };
  }
  try {
    const blocked = db.prepare("SELECT 1 FROM forget_operations WHERE owner = ? AND state = 'pending' LIMIT 1").get(owner);
    if (blocked) return { ok: false, refused: "forget pending: resolve before building" };
  } catch {
    return { ok: false, refused: "forget barrier unreadable" };
  }
  const snap = getProjectionState(db);
  // Resume reuses the serving+1 slot: the interrupted generation is
  // discarded first, so numbers stay dense and idempotent.
  const generation = (snap.servingGeneration ?? 0) + 1;
  discardUnservedGenerations(db);
  writeState(db, {
    state: "building", servingGeneration: snap.servingGeneration,
    buildingGeneration: generation, reason: "projection build in progress",
    progress: { generation },
  });
  try {
    const durables = eligibleDurables(db, owner);
    const episodes = eligibleEpisodes(db, owner);
    const buildTxn = db.transaction(() => {
      for (const d of durables) insertDurableDoc(db, owner, generation, d);
      for (const e of episodes) insertEpisodeDoc(db, owner, generation, e);
    });
    buildTxn();
    const graph = db.transaction(() => remapGraphEdges(db, owner, generation))();
    const verified = verifyRecallProjection(db, owner, generation);
    if (!verified.ok) {
      writeState(db, {
        state: "failed", servingGeneration: servingGeneration(db),
        buildingGeneration: generation, reason: verified.reasons[0] ?? "verification failed",
        progress: { generation, reasons: verified.reasons },
      });
      return { ok: false, generation, reasons: verified.reasons };
    }
    const previousServing = servingGeneration(db);
    const publishTxn = db.transaction(() => {
      if (previousServing !== null && previousServing !== generation) {
        // Retire the obsolete derived generation at publish time; the new
        // generation already passed verification, so serving never gaps.
        db.prepare("DELETE FROM recall_graph_edges WHERE owner = ? AND generation = ?").run(owner, previousServing);
        db.prepare(
          "DELETE FROM recall_vectors WHERE doc_id IN (SELECT id FROM recall_documents WHERE owner = ? AND generation = ?)",
        ).run(owner, previousServing);
        db.prepare("DELETE FROM recall_documents WHERE owner = ? AND generation = ?").run(owner, previousServing);
      }
      writeState(db, {
        state: "ready", servingGeneration: generation, buildingGeneration: null,
        reason: "projection generation published after verification",
        progress: { generation, durables: durables.length, episodes: episodes.length, graphRemapped: graph.remapped },
      });
    });
    publishTxn();
    return {
      ok: true, generation, indexedDurables: durables.length, indexedEpisodes: episodes.length,
      graphRemapped: graph.remapped, graphUnverifiable: graph.unverifiable,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "build failed";
    try {
      writeState(db, {
        state: "interrupted", servingGeneration: servingGeneration(db),
        buildingGeneration: generation, reason: detail.slice(0, 200), progress: { generation },
      });
    } catch {
      // State write failure leaves the previous state row; the next build
      // still discards this partial generation before indexing.
    }
    return { ok: false, generation, refused: detail.slice(0, 200) };
  }
}

/**
 * Drop every serving-generation document for one source record, including
 * vectors (cascade) and FTS/trigram rows (triggers) plus bound graph
 * edges. Suppression is immediate; re-adding a redacted remainder is the
 * caller's reconcile step.
 */
export function dropSourceDocuments(db: Database.Database, owner: string, layer: "durable" | "episode", recordId: number): void {
  if (servingGeneration(db) === null) return;
  const gen = servingGeneration(db);
  if (tableExists(db, "recall_graph_edges")) {
    try {
      db.prepare("DELETE FROM recall_graph_edges WHERE owner = ? AND generation = ? AND src_layer = ? AND src_record_id = ?")
        .run(owner, gen, layer, recordId);
    } catch {
      // Graph cleanup never fails the source mutation it protects.
    }
  }
  try {
    db.prepare("DELETE FROM recall_documents WHERE owner = ? AND generation = ? AND layer = ? AND record_id = ?")
      .run(owner, gen, layer, recordId);
  } catch {
    // Registry cleanup never fails the source mutation it protects.
  }
}

/**
 * Index one durable revision into the serving generation. No-op without a
 * serving generation, for ineligible sources, or for already-current rows.
 */
export function indexDurableDocument(db: Database.Database, owner: string, durableId: number): void {
  const gen = servingGeneration(db);
  if (gen === null || !tableExists(db, "recall_documents")) return;
  let row: {
    revision: number; content: string; content_original: string | null;
    authority: string; applicability_scope: string; classification: number; evidence: string;
  } | undefined;
  try {
    row = db.prepare(
      `SELECT revision, content, content_original, authority, applicability_scope, classification, evidence
       FROM long_term_memories WHERE id = ? AND user_id = ? AND superseded_by_id IS NULL AND classification <= 2 AND encrypted = 0`,
    ).get(durableId, owner) as typeof row;
  } catch {
    return;
  }
  if (!row) {
    dropSourceDocuments(db, owner, "durable", durableId);
    return;
  }
  try {
    if (isSuppressedByForget(db, owner, { durableId })) {
      dropSourceDocuments(db, owner, "durable", durableId);
      return;
    }
  } catch {
    return;
  }
  insertDurableDoc(db, owner, gen, {
    id: durableId, revision: row.revision, content: row.content, contentOriginal: row.content_original,
    authority: row.authority, scope: row.applicability_scope, classification: row.classification, evidence: row.evidence,
  });
}

/** Index one episode into the serving generation (same no-op contract). */
export function indexEpisodeDocument(db: Database.Database, owner: string, episodeId: number): void {
  const gen = servingGeneration(db);
  if (gen === null || !tableExists(db, "recall_documents")) return;
  let row: { topic: string; outcomes: string | null; unresolved: string | null; evidence_excerpts: string } | undefined;
  try {
    row = db.prepare(
      "SELECT topic, outcomes, unresolved, evidence_excerpts FROM short_term_memories WHERE id = ? AND user_id = ? AND classification <= 2 AND encrypted = 0",
    ).get(episodeId, owner) as typeof row;
  } catch {
    return;
  }
  if (!row) {
    dropSourceDocuments(db, owner, "episode", episodeId);
    return;
  }
  try {
    if (isSuppressedByForget(db, owner, { episodeId })) {
      dropSourceDocuments(db, owner, "episode", episodeId);
      return;
    }
  } catch {
    return;
  }
  insertEpisodeDoc(db, owner, gen, {
    id: episodeId, topic: row.topic, outcomes: row.outcomes, unresolved: row.unresolved, evidenceExcerpts: row.evidence_excerpts,
  });
}

/**
 * Prune stale/ineligible serving-generation rows and fill missing
 * eligible ones. Runs inside the forget enforcement transaction, so
 * suppression is synchronous with the forget barrier.
 */
export function reconcileServingDocuments(db: Database.Database, owner: string): void {
  const gen = servingGeneration(db);
  if (gen === null || !tableExists(db, "recall_documents")) return;
  let docs: Array<{ layer: string; record_id: number; source_version: string }>;
  try {
    docs = db.prepare("SELECT layer, record_id, source_version FROM recall_documents WHERE owner = ? AND generation = ?")
      .all(owner, gen) as typeof docs;
  } catch {
    return;
  }
  const durableList = eligibleDurables(db, owner);
  const episodeList = eligibleEpisodes(db, owner);
  const eligibleDurableMap = new Map(durableList.map((d) => [d.id, d]));
  const eligibleEpisodeMap = new Map(episodeList.map((e) => [e.id, e]));
  const seenDurables = new Set<number>();
  const seenEpisodes = new Set<number>();
  for (const doc of docs) {
    if (doc.layer === "durable") {
      const current = eligibleDurableMap.get(doc.record_id);
      seenDurables.add(doc.record_id);
      if (!current || durableSourceVersion(current.revision) !== doc.source_version) {
        dropSourceDocuments(db, owner, "durable", doc.record_id);
      }
    } else if (doc.layer === "episode") {
      const current = eligibleEpisodeMap.get(doc.record_id);
      seenEpisodes.add(doc.record_id);
      if (!current || episodeSourceVersion(current.topic, current.outcomes, current.unresolved, current.evidenceExcerpts) !== doc.source_version) {
        dropSourceDocuments(db, owner, "episode", doc.record_id);
      }
    } else {
      try {
        db.prepare("DELETE FROM recall_documents WHERE owner = ? AND generation = ? AND layer = ? AND record_id = ?")
          .run(owner, gen, doc.layer, doc.record_id);
      } catch {
        // Pruning never fails the enclosing forget barrier.
      }
    }
  }
  for (const d of durableList) {
    if (!seenDurables.has(d.id)) insertDurableDoc(db, owner, gen, d);
  }
  for (const e of episodeList) {
    if (!seenEpisodes.has(e.id)) insertEpisodeDoc(db, owner, gen, e);
  }
}

/**
 * Restore path: restored index metadata cannot assert readiness, and
 * pre-restore generations may hide post-backup forgetting. Clear every
 * projection surface and return to not_built; recall is
 * unavailable/index-required until a reviewed rebuild publishes again.
 */
export function invalidateRecallProjections(db: Database.Database): void {
  for (const table of ["recall_graph_edges", "recall_vectors", "recall_documents"]) {
    if (!tableExists(db, table)) continue;
    try {
      db.prepare(`DELETE FROM ${table}`).run();
    } catch {
      // Invalidation is best-effort per surface; state below still blocks serving.
    }
  }
  if (!tableExists(db, "recall_projection_state")) return;
  try {
    writeState(db, {
      state: "not_built", servingGeneration: null, buildingGeneration: null,
      reason: "projections invalidated by restore; rebuild before activation",
    });
  } catch {
    // A missing state row already reads as not_built.
  }
}

/**
 * Bounded status for the authenticated runtime-status surface. Contains no
 * memory text, raw query, secret value, or private filesystem path.
 */
export function recallProjectionStatus(db: Database.Database): {
  state: RecallProjectionStateName;
  servingGeneration: number | null;
  buildingGeneration: number | null;
  projectionVersion: number;
  reason: string | null;
  progress: Record<string, unknown>;
  indexedDocuments: number;
  vectorsIndexed: number;
  embeddingConfigured: boolean;
} {
  const snap = getProjectionState(db);
  let indexedDocuments = 0, vectorsIndexed = 0;
  if (snap.servingGeneration !== null && tableExists(db, "recall_documents")) {
    try {
      indexedDocuments = (db.prepare("SELECT COUNT(*) AS c FROM recall_documents WHERE owner IS NOT NULL AND generation = ?")
        .get(snap.servingGeneration) as { c: number }).c;
    } catch {
      indexedDocuments = 0;
    }
    try {
      vectorsIndexed = (db.prepare(
        "SELECT COUNT(*) AS c FROM recall_vectors WHERE doc_id IN (SELECT id FROM recall_documents WHERE generation = ?)",
      ).get(snap.servingGeneration) as { c: number }).c;
    } catch {
      vectorsIndexed = 0;
    }
  }
  let embeddingConfigured = false;
  try {
    embeddingConfigured = loadEmbedConfig().enabled;
  } catch {
    embeddingConfigured = false;
  }
  return {
    state: snap.state, servingGeneration: snap.servingGeneration,
    buildingGeneration: snap.buildingGeneration, projectionVersion: snap.projectionVersion,
    reason: snap.reason, progress: snap.progress,
    indexedDocuments, vectorsIndexed, embeddingConfigured,
  };
}

export interface RecallVectorBackfillOutcome {
  readonly ok: boolean;
  readonly computed: number;
  readonly skipped: number;
  readonly model: string | null;
  readonly dim: number | null;
  readonly reason?: string;
}

/**
 * Asynchronous doc-vector publication (M3 Se support). Computes embeddings
 * for serving-generation documents missing a compatible vector, then
 * CAS-publishes each against its captured source version: a changed source
 * invalidates the captured vector instead of publishing it. Never compares
 * incompatible vectors — a model/dimension mismatch rebuilds the owner's
 * vectors from scratch. Absent vectors degrade Se; they never block
 * deterministic recall. Derived-only: no backup gate, but the personal
 * route must be ready.
 */
const RECALL_VECTOR_TEXT_CHARS = 4000;

export async function backfillRecallVectors(
  db: Database.Database,
  owner: string,
  embed: (text: string) => Promise<Float32Array | null>,
): Promise<RecallVectorBackfillOutcome> {
  const config = loadEmbedConfig();
  if (!config.enabled) return { ok: false, computed: 0, skipped: 0, model: null, dim: null, reason: "embeddings-disabled" };
  const gen = servingGeneration(db);
  if (gen === null || !tableExists(db, "recall_documents")) {
    return { ok: true, computed: 0, skipped: 0, model: config.model, dim: null, reason: "no-serving-generation" };
  }
  let docs: Array<{ docId: number; text: string; sourceVersion: string }>;
  try {
    docs = db.prepare(
      `SELECT d.id AS docId, d.safe_text AS text, d.source_version AS sourceVersion
       FROM recall_documents d LEFT JOIN recall_vectors v ON v.doc_id = d.id AND v.model = ? AND v.source_version = d.source_version
       WHERE d.owner = ? AND d.generation = ? AND v.doc_id IS NULL`,
    ).all(config.model, owner, gen) as typeof docs;
  } catch {
    return { ok: false, computed: 0, skipped: 0, model: config.model, dim: null, reason: "registry-unreadable" };
  }
  if (docs.length === 0) return { ok: true, computed: 0, skipped: 0, model: config.model, dim: null, reason: "vectors-current" };
  // Probe the provider dimension from the first document before writing.
  const first = docs[0];
  if (!first) return { ok: true, computed: 0, skipped: 0, model: config.model, dim: null, reason: "vectors-current" };
  const probe = await embed(first.text.slice(0, RECALL_VECTOR_TEXT_CHARS));
  if (!probe) return { ok: false, computed: 0, skipped: docs.length, model: config.model, dim: null, reason: "provider-unavailable" };
  const dim = probe.length;
  try {
    const incompatible = db.prepare(
      `SELECT COUNT(*) AS c FROM recall_vectors WHERE doc_id IN (SELECT id FROM recall_documents WHERE owner = ? AND generation = ?) AND (model != ? OR dim != ?)`,
    ).get(owner, gen, config.model, dim) as { c: number };
    if (incompatible.c > 0) {
      db.prepare(
        "DELETE FROM recall_vectors WHERE doc_id IN (SELECT id FROM recall_documents WHERE owner = ? AND generation = ?)",
      ).run(owner, gen);
    }
  } catch {
    return { ok: false, computed: 0, skipped: docs.length, model: config.model, dim, reason: "vector-store-unreadable" };
  }
  let computed = 0, skipped = 0;
  const vectors = new Map<number, Float32Array>([[first.docId, probe]]);
  for (const doc of docs) {
    const vector = vectors.get(doc.docId) ?? await embed(doc.text.slice(0, RECALL_VECTOR_TEXT_CHARS));
    if (!vector || vector.length !== dim) {
      skipped++;
      continue;
    }
    try {
      const current = db.prepare("SELECT source_version FROM recall_documents WHERE id = ?").get(doc.docId) as { source_version: string } | undefined;
      if (!current || current.source_version !== doc.sourceVersion) {
        skipped++;
        continue;
      }
      const changed = db.prepare(
        "INSERT INTO recall_vectors (doc_id, model, dim, vector, source_version) VALUES (?, ?, ?, ?, ?) ON CONFLICT(doc_id) DO UPDATE SET vector = excluded.vector, model = excluded.model, dim = excluded.dim, source_version = excluded.source_version WHERE recall_vectors.source_version != excluded.source_version",
      ).run(doc.docId, config.model, dim, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), doc.sourceVersion).changes;
      if (changed > 0) computed++;
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { ok: true, computed, skipped, model: config.model, dim };
}
