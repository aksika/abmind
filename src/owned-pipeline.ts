/**
 * owned-pipeline — #1928 M3 indexed retrieval over new-model projections.
 *
 * Runs the mapped database stages (Sf.1 Porter, Sf.2/Sf.3 trigrams,
 * Se embeddings, Ss signatures, S8 relationships) over the serving
 * projection generation, plus full-only bounded S6 summaries. Shared
 * deterministic fusion (RRF K=60, context weight 0.5, MMR lambda=0.7),
 * profile work/output limits, safe grounding, continuation paging, and
 * history intent. Limits bound work, never memory age; no stage searches
 * legacy memories. A query returning enough hits never suppresses another
 * enabled stage; deadline/cancellation is checked between work units.
 */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { hasTokenBoundaryMatch, extractSignificantTerms } from "./trigram-search.js";
import { applyMMR } from "./mmr.js";
import { generateSignature, hammingSimilarity } from "./signature-generator.js";
import { cosineSimilarity } from "./ollama-embed.js";
import { getAbmindEnv } from "./env-schema.js";
import { loadEmbedConfig } from "./ollama-embed.js";
import { acquireEmbedPermit } from "./owned-embedding-gate.js";
import { searchOwnedSummaries } from "./owned-summaries.js";
import { isSuppressedByForget } from "./personal-forget.js";
import { ownedRefKey } from "./owned-recall-contract.js";
import type { OwnedRecallProfile, OwnedRecallRef, OwnedFilters } from "./owned-recall-contract.js";
import type { IEmbeddingProvider } from "./embedding-provider.js";

export class OwnedPipelineCancelled extends Error {
  constructor() {
    super("cancelled: recall lookup cancelled");
    this.name = "OwnedPipelineCancelled";
  }
}

/** Per-profile stage budgets (C3). Fixed engineering bounds. */
export interface OwnedStageBudgets {
  readonly lexicalProbe: number;
  readonly embeddingCandidates: number;
  readonly embeddingWaitMs: number;
  readonly signatureRows: number;
  readonly signatureKeep: number;
  readonly fusedCeiling: number;
  readonly graphHops: number;
  readonly graphNodes: number;
  readonly graphEdges: number;
  readonly groundingExcerpts: number;
}

export const OWNED_STAGE_BUDGETS: Record<OwnedRecallProfile, OwnedStageBudgets> = {
  recall_fast: { lexicalProbe: 24, embeddingCandidates: 24, embeddingWaitMs: 250, signatureRows: 5000, signatureKeep: 8, fusedCeiling: 128, graphHops: 1, graphNodes: 16, graphEdges: 32, groundingExcerpts: 0 },
  recall_normal: { lexicalProbe: 64, embeddingCandidates: 64, embeddingWaitMs: 500, signatureRows: 10000, signatureKeep: 24, fusedCeiling: 384, graphHops: 2, graphNodes: 48, graphEdges: 96, groundingExcerpts: 8 },
  recall_full: { lexicalProbe: 192, embeddingCandidates: 192, embeddingWaitMs: 1000, signatureRows: 25000, signatureKeep: 64, fusedCeiling: 1024, graphHops: 3, graphNodes: 128, graphEdges: 256, groundingExcerpts: 32 },
};

const RRF_K = 60;
const CONTEXT_RANK_WEIGHT = 0.5;
const MMR_LAMBDA = 0.7;
const STRONG_FLOOR = 1.2;
const SIGNATURE_FLOOR = 0.65;
const SEMANTIC_FLOOR = 0.5;
const PROMINENCE_EPSILON = 0.001;
const MMR_INPUT_CAP = 200;

function rrfTerm(rank: number): number {
  return RRF_K / (RRF_K + rank);
}

export interface OwnedPipelineRequest {
  readonly db: Database.Database;
  readonly owner: string;
  readonly profile: OwnedRecallProfile;
  readonly anchorText: string;
  readonly keywords: readonly string[];
  readonly contextTerms: readonly string[];
  readonly filters: OwnedFilters;
  readonly generation: number;
  readonly maxItems: number;
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
  readonly memoryDir: string | null;
  readonly embeddingProvider: IEmbeddingProvider | null;
  readonly excludeRefKeys?: ReadonlySet<string>;
  readonly reserveRefKeys?: readonly string[];
}

export interface OwnedPipelineItem {
  key: string;
  ref: OwnedRecallRef;
  docId: number | null;
  excerpt: string;
  authority: string;
  scope: string;
  currentness: string;
  rationale: string;
  provenance: string;
  sourceRefs: string[];
  sourceMessageIds: number[];
  weaker: boolean;
  required: boolean;
  score: number;
}

export interface OwnedPipelineOutcome {
  readonly items: OwnedPipelineItem[];
  readonly stageOutcomes: Record<string, { status: string; hitCount: number; reason?: string }>;
  readonly omissionReasons: string[];
  readonly elapsedMs: number;
}

interface StageCandidate {
  key: string;
  kind: "db" | "artifact" | "graph";
  layer?: "durable" | "episode";
  docId: number | null;
  recordId?: number;
  owner: string;
  version?: string;
  safeText: string;
  authority: string;
  scope: string;
  sourceMessageIds: number[];
  excerpt: string;
  provenance: string;
  ranks: { porter?: number; trigramEn?: number; trigramOrig?: number; embedding?: number; signature?: number; graph?: number; context?: number };
  anchorCoverage: number;
  weaker: boolean;
  required: boolean;
  /** Graph candidates reached from an anchor (not related-seed) path. */
  seedFromAnchor?: boolean;
  /** Fusion tier: 2 all-anchor, 1 partial, 0 weak/supplementary. */
  tier?: number;
  score: number;
  /** Source-language/original text for coverage (db docs). */
  originalText?: string;
  /** C2 evidence ref for the final packet (db, artifact, or graph). */
  ref: OwnedRecallRef;
  /** Match rationale for the final packet. */
  rationale: string;
}

function stopped(req: OwnedPipelineRequest): boolean {
  return Date.now() >= req.deadlineAt || req.signal?.aborted === true;
}

function checkPoint(req: OwnedPipelineRequest): void {
  if (stopped(req)) throw new OwnedPipelineCancelled();
}

function anchorTermsOf(req: OwnedPipelineRequest): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const kw of req.keywords) {
    const t = kw.trim().toLowerCase();
    if (t.length > 0 && !seen.has(t)) {
      seen.add(t);
      terms.push(kw.trim());
    }
  }
  for (const w of extractSignificantTerms([req.anchorText])) {
    const t = w.toLowerCase();
    if (!seen.has(t)) {
      seen.add(t);
      terms.push(w);
    }
  }
  return terms;
}

function coverageOf(haystack: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  let matched = 0;
  for (const t of terms) {
    try {
      if (hasTokenBoundaryMatch(haystack, t)) matched++;
    } catch {
      // A single unmatchable term never fails the coverage measure.
    }
  }
  return matched / terms.length;
}

/** Optional narrowing filters, pushed into probe SQL so caps stay meaningful. */
function docFilterSql(req: OwnedPipelineRequest): { join: string; where: string; params: unknown[] } {
  const joins: string[] = [];
  const conds: string[] = [];
  const params: unknown[] = [];
  const f = req.filters;
  const needLtm = f.memoryType !== undefined || f.timeStart !== undefined || f.timeEnd !== undefined;
  const needStm = f.timeStart !== undefined || f.timeEnd !== undefined;
  if (needLtm) joins.push("LEFT JOIN long_term_memories ltm ON (d.layer = 'durable' AND ltm.id = d.record_id AND ltm.user_id = d.owner)");
  if (needStm) joins.push("LEFT JOIN short_term_memories stm ON (d.layer = 'episode' AND stm.id = d.record_id AND stm.user_id = d.owner)");
  if (f.memoryType !== undefined) {
    conds.push("(d.layer = 'episode' OR ltm.memory_type = ?)");
    params.push(f.memoryType);
  }
  if (f.scope !== undefined && f.scope !== "general") {
    conds.push("(d.scope = ? OR d.scope = '{\"scope\":\"general\"}')");
    params.push(JSON.stringify({ scope: f.scope }));
  }
  if (f.timeStart !== undefined) {
    conds.push("((d.layer = 'durable' AND ltm.created_at >= ?) OR (d.layer = 'episode' AND stm.start_ts >= ?))");
    params.push(f.timeStart, f.timeStart);
  }
  if (f.timeEnd !== undefined) {
    conds.push("((d.layer = 'durable' AND ltm.created_at <= ?) OR (d.layer = 'episode' AND stm.start_ts <= ?))");
    params.push(f.timeEnd, f.timeEnd);
  }
  return {
    join: joins.join(" "),
    where: conds.length > 0 ? `AND ${conds.join(" AND ")}` : "",
    params,
  };
}

const DOC_COLS = "d.id, d.layer, d.record_id, d.source_version, d.safe_text, d.original_text, d.authority, d.scope, d.classification, d.source_refs, d.signature";

type DocRow = {
  id: number; layer: "durable" | "episode"; record_id: number; source_version: string;
  safe_text: string; original_text: string; authority: string; scope: string;
  classification: number; source_refs: string; signature: Buffer | null;
};

function rowToCandidate(row: DocRow, owner: string, excerpt: string, provenance: string): StageCandidate {
  const ref: OwnedRecallRef = { kind: "db", layer: row.layer, recordId: row.record_id, owner, version: row.source_version };
  return {
    key: ownedRefKey(ref),
    kind: "db",
    layer: row.layer,
    docId: row.id,
    recordId: row.record_id,
    owner,
    version: row.source_version,
    safeText: row.safe_text,
    authority: row.authority,
    scope: row.scope,
    sourceMessageIds: messageIdsOf(row.source_refs),
    excerpt,
    provenance,
    rationale: provenance,
    ranks: {},
    anchorCoverage: 0,
    weaker: false,
    required: false,
    score: 0,
    originalText: row.original_text,
    ref,
  };
}

function messageIdsOf(raw: string): number[] {
  try {
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    const out: number[] = [];
    for (const e of entries) {
      if (typeof e !== "object" || e === null) continue;
      const r = e as Record<string, unknown>;
      const id = typeof r.messageId === "number" ? r.messageId : Number(/^(?:messages:)?([1-9]\d*)$/.exec(String(r.ref ?? ""))?.[1]);
      if (Number.isSafeInteger(id)) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

function porterOr(terms: readonly string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

export async function runOwnedPipeline(req: OwnedPipelineRequest): Promise<OwnedPipelineOutcome> {
  const startedAt = Date.now();
  const budgets = OWNED_STAGE_BUDGETS[req.profile];
  const omissionReasons: string[] = [];
  const stageOutcomes: Record<string, { status: string; hitCount: number; reason?: string }> = {};
  const setOutcome = (stage: string, status: string, hitCount: number, reason?: string): void => {
    stageOutcomes[stage] = reason ? { status, hitCount, reason } : { status, hitCount };
  };
  const layers = req.profile === "recall_fast" ? ["durable"] : ["durable", "episode"];
  const terms = anchorTermsOf(req);
  const ceiling = Math.min(req.filters.classificationCeiling ?? 2, 2);
  const filter = docFilterSql(req);
  const baseWhere = `d.owner = ? AND d.generation = ? AND d.classification <= ? AND d.layer IN (${layers.map(() => "?").join(",")}) ${filter.where}`;
  const baseParams: unknown[] = [req.owner, req.generation, ceiling, ...layers, ...filter.params];

  const candidates = new Map<string, StageCandidate>();
  const sfSeen = new Set<string>();
  let sfCount = 0;
  const addRanked = (row: DocRow, field: "porter" | "trigramEn" | "trigramOrig" | "context", sourceLabel: string): void => {
    const c = rowToCandidate(row, req.owner, row.safe_text, `projection ${sourceLabel}`);
    const existing = candidates.get(c.key);
    if (existing) {
      if (existing.ranks[field] === undefined) existing.ranks[field] = sfCount;
      return;
    }
    if (sfCount >= budgets.lexicalProbe) return;
    c.ranks[field] = sfCount;
    sfCount++;
    sfSeen.add(c.key);
    void sfSeen;
    candidates.set(c.key, c);
  };

  // --- Sf.1: Porter FTS5 over safe text ---
  checkPoint(req);
  let porterFailed = false;
  try {
    if (terms.length > 0) {
      const phrase = req.anchorText.trim();
      const queries: string[] = [];
      if (phrase.length > 0) queries.push(`"${phrase.replace(/"/g, "").slice(0, 512)}"`);
      queries.push(porterOr(terms));
      for (const q of queries) {
        if (sfCount >= budgets.lexicalProbe) break;
        const rows = req.db.prepare(
          `SELECT ${DOC_COLS} FROM recall_fts ft JOIN recall_documents d ON d.id = ft.rowid ${filter.join} WHERE recall_fts MATCH ? AND ${baseWhere} ORDER BY rank LIMIT ?`,
        ).all(q, ...baseParams, budgets.lexicalProbe) as DocRow[];
        for (const r of rows) addRanked(r, "porter", "porter");
      }
    }
    setOutcome("Sf", "completed", sfCount);
  } catch (err) {
    porterFailed = true;
    setOutcome("Sf", "failed", sfCount, err instanceof Error ? err.message.slice(0, 160) : "porter failed");
  }

  // --- Sf.2 / Sf.3: trigram probes, per-term bounded, shared stage cap ---
  checkPoint(req);
  const trigramStage = (table: string, termsToProbe: readonly string[]): number => {
    let addedHere = 0;
    for (const term of termsToProbe) {
      if (sfCount >= budgets.lexicalProbe) break;
      const stripped = term.normalize("NFD").replace(/[̀-ͯ]/g, "");
      if (stripped.length < 3) continue;
      for (const variant of [stripped, ...substringsOf(stripped)]) {
        if (sfCount >= budgets.lexicalProbe) break;
        let rows: DocRow[];
        try {
          rows = req.db.prepare(
            `SELECT ${DOC_COLS} FROM ${table} ft JOIN recall_documents d ON d.id = ft.rowid ${filter.join} WHERE ${table} MATCH ? AND ${baseWhere} ORDER BY rank LIMIT ?`,
          ).all(`"${variant.replace(/"/g, "")}"`, ...baseParams, Math.min(12, budgets.lexicalProbe - sfCount)) as DocRow[];
        } catch {
          continue;
        }
        const before = addedHere;
        for (const r of rows) {
          addRanked(r, table === "recall_trigram_en" ? "trigramEn" : "trigramOrig", table === "recall_trigram_en" ? "trigram_en" : "trigram_orig");
          addedHere++;
          if (addedHere - before >= 12) break;
        }
        if (rows.length > 0) break;
      }
    }
    return addedHere;
  };
  try {
    const probeTerms = terms.slice(0, 50);
    const enAdded = trigramStage("recall_trigram_en", probeTerms);
    const origAdded = trigramStage("recall_trigram_orig", probeTerms);
    // A dead porter probe stays failed: trigram coverage is partial, not a
    // substitute. Trigram additions without porter coverage still complete.
    if (!porterFailed) {
      setOutcome("Sf", "completed", sfCount, enAdded + origAdded > 0 ? undefined : "no-trigram-additions");
    } else if (enAdded + origAdded > 0) {
      omissionReasons.push("Sf: porter probe failed; trigram coverage is partial");
    }
  } catch (err) {
    setOutcome("Sf", "failed", sfCount, err instanceof Error ? err.message.slice(0, 160) : "trigram failed");
  }

  // --- Context plan: bounded eligible context, half weight, no rewriting ---
  checkPoint(req);
  let contextPlans = 0;
  if (req.contextTerms.length > 0) {
    try {
      const ctxQuery = porterOr(req.contextTerms.slice(0, 12));
      const rows = req.db.prepare(
        `SELECT ${DOC_COLS} FROM recall_fts ft JOIN recall_documents d ON d.id = ft.rowid ${filter.join} WHERE recall_fts MATCH ? AND ${baseWhere} ORDER BY rank LIMIT ?`,
      ).all(ctxQuery, ...baseParams, budgets.lexicalProbe) as DocRow[];
      const beforeCtx = candidates.size;
      for (const r of rows) {
        if (sfCount >= budgets.lexicalProbe) break;
        addRanked(r, "context", "context-plan");
      }
      contextPlans = candidates.size - beforeCtx;
      setOutcome("Sf:ctx", "completed", contextPlans);
    } catch (err) {
      setOutcome("Sf:ctx", "failed", 0, err instanceof Error ? err.message.slice(0, 160) : "context plan failed");
    }
  } else {
    setOutcome("Sf:ctx", "not-requested", 0);
  }

  // --- Se: one query embedding, gated, cosine admission ---
  checkPoint(req);
  let seVector: Float32Array | null = null;
  const embedConfig = loadEmbedConfig();
  let seFired: Promise<Float32Array | null> | null = null;
  let sePermit: { release(): void } | null = null;
  if (!embedConfig.enabled) {
    setOutcome("Se", "disabled", 0);
  } else if (!req.embeddingProvider) {
    setOutcome("Se", "no-provider", 0);
  } else {
    const permit = acquireEmbedPermit(req.owner);
    if (!permit) {
      setOutcome("Se", "no-provider", 0, "se-busy: embedding capacity saturated");
    } else {
      sePermit = permit;
      try {
        const raw = req.embeddingProvider.embedText(req.anchorText);
        seFired = raw.then(
          (v) => {
            permit.release();
            return v;
          },
          () => {
            permit.release();
            return null;
          },
        );
      } catch {
        permit.release();
        sePermit = null;
        setOutcome("Se", "failed", 0, "provider-threw");
      }
    }
  }
  const cosineFloor = Math.max(getAbmindEnv().embeddingSimilarityThreshold, SEMANTIC_FLOOR);
  if (seFired) {
    const waited = await awaitForeground(seFired, budgets.embeddingWaitMs);
    if (waited.state === "deadline") {
      // Detached: the permit releases on settle; the late result is fenced
      // by the generation check below and can never publish.
      setOutcome("Se", "deadline", 0);
    } else if (!waited.vector) {
      setOutcome("Se", "failed", 0);
    } else {
      seVector = waited.vector;
      try {
        const stored = req.db.prepare(
          `SELECT d.id AS docId, v.vector AS vector, v.source_version AS sourceVersion, d.source_version AS docVersion
           FROM recall_vectors v JOIN recall_documents d ON d.id = v.doc_id
           WHERE d.owner = ? AND d.generation = ? AND v.model = ?`,
        ).all(req.owner, req.generation, embedConfig.model) as Array<{ docId: number; vector: Buffer; sourceVersion: string; docVersion: string }>;
        const scored: Array<{ docId: number; cosine: number }> = [];
        for (const s of stored) {
          if (s.sourceVersion !== s.docVersion) continue;
          const bytes = new Uint8Array(s.vector.buffer, s.vector.byteOffset, s.vector.byteLength);
          if (bytes.byteLength % 4 !== 0 || bytes.byteLength / 4 !== seVector.length) continue;
          const vec = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
          const cosine = cosineSimilarity(seVector, vec);
          if (cosine >= cosineFloor) scored.push({ docId: s.docId, cosine });
        }
        scored.sort((a, b) => b.cosine - a.cosine);
        let seAdded = 0;
        for (const s of scored.slice(0, budgets.embeddingCandidates)) {
          const existing = [...candidates.values()].find((c) => c.docId === s.docId);
          if (existing) {
            if (existing.ranks.embedding === undefined) existing.ranks.embedding = seAdded;
          } else {
            const row = req.db.prepare(`SELECT ${DOC_COLS} FROM recall_documents d WHERE d.id = ?`).get(s.docId) as DocRow | undefined;
            if (!row) continue;
            const c = rowToCandidate(row, req.owner, row.safe_text, "projection embedding");
            c.ranks.embedding = seAdded;
            candidates.set(c.key, c);
          }
          seAdded++;
        }
        setOutcome("Se", "completed", seAdded);
      } catch (err) {
        setOutcome("Se", "failed", 0, err instanceof Error ? err.message.slice(0, 160) : "se failed");
      }
    }
  }

  // --- Ss: deterministic coverage sample over eligible IDs, never newest rows ---
  checkPoint(req);
  const signatureFloor = SIGNATURE_FLOOR;
  try {
    const total = req.db.prepare(
      `SELECT COUNT(*) AS c FROM recall_documents d WHERE d.owner = ? AND d.generation = ? AND d.classification <= ? AND d.layer IN (${layers.map(() => "?").join(",")}) AND d.signature IS NOT NULL`,
    ).get(req.owner, req.generation, ceiling, ...layers) as { c: number };
    const scanCap = budgets.signatureRows;
    const rows = req.db.prepare(
      `SELECT ${DOC_COLS} FROM recall_documents d
       WHERE d.owner = ? AND d.generation = ? AND d.classification <= ? AND d.layer IN (${layers.map(() => "?").join(",")}) AND d.signature IS NOT NULL
       ORDER BY (d.id * 2654435761) % 2147483647 LIMIT ?`,
    ).all(req.owner, req.generation, ceiling, ...layers, scanCap + 1) as DocRow[];
    const incomplete = rows.length > scanCap;
    const querySig = generateSignature(req.anchorText);
    const scored: Array<{ row: DocRow; sim: number }> = [];
    for (const row of rows.slice(0, scanCap)) {
      if (!row.signature) continue;
      const sigBytes: Buffer = row.signature;
      const sig = new Uint8Array(sigBytes.buffer, sigBytes.byteOffset, sigBytes.byteLength);
      scored.push({ row, sim: hammingSimilarity(querySig, sig) });
    }
    scored.sort((a, b) => b.sim - a.sim);
    let ssAdded = 0;
    for (const { row, sim } of scored) {
      if (ssAdded >= budgets.signatureKeep || sim < signatureFloor) break;
      const c = rowToCandidate(row, req.owner, row.safe_text, "projection signature");
      const existing = candidates.get(c.key);
      if (existing) {
        if (existing.ranks.signature === undefined) existing.ranks.signature = ssAdded;
      } else {
        c.ranks.signature = ssAdded;
        candidates.set(c.key, c);
      }
      ssAdded++;
    }
    setOutcome(
      "Ss", "completed", ssAdded,
      incomplete ? `incomplete-scan: scored ${scanCap} of ${total.c}` : undefined,
    );
  } catch (err) {
    setOutcome("Ss", "failed", 0, err instanceof Error ? err.message.slice(0, 160) : "ss failed");
  }

  // --- S8: bounded traversal over eligible new-model source refs ---
  checkPoint(req);
  try {
    const words = (req.anchorText.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2);
    const uniqueSeeds = [...new Set(words)];
    const edgeRows = req.db.prepare(
      "SELECT entity_a, entity_b, relation, src_layer, src_record_id, src_version FROM recall_graph_edges WHERE owner = ? AND generation = ? LIMIT ?",
    ).all(req.owner, req.generation, budgets.graphEdges * 4) as Array<{
      entity_a: string; entity_b: string; relation: string; src_layer: string; src_record_id: number; src_version: string;
    }>;
    const adjacency = new Map<string, Array<{ to: string; edge: (typeof edgeRows)[number] }>>();
    for (const e of edgeRows) {
      if (!adjacency.has(e.entity_a)) adjacency.set(e.entity_a, []);
      adjacency.get(e.entity_a)?.push({ to: e.entity_b, edge: e });
      if (!adjacency.has(e.entity_b)) adjacency.set(e.entity_b, []);
      adjacency.get(e.entity_b)?.push({ to: e.entity_a, edge: e });
    }
    const known = uniqueSeeds.filter((w) => adjacency.has(w));
    let seeds = [...known];
    if (req.profile === "recall_full") {
      // Related-seed expansion: bounded co-occurring entities join the seeds.
      const related = new Map<string, number>();
      for (const s of known) {
        for (const { to } of adjacency.get(s) ?? []) related.set(to, (related.get(to) ?? 0) + 1);
      }
      const extra = [...related.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e).filter((e) => !seeds.includes(e)).slice(0, 8);
      seeds = [...seeds, ...extra];
    }
    const visitedNodes = new Map<string, boolean>(seeds.map((s) => [s, known.includes(s)]));
    const visitedEdges = new Set<string>();
    let s8Added = 0;
    let frontier: Array<{ node: string; anchored: boolean }> = seeds.map((s) => ({ node: s, anchored: known.includes(s) }));
    for (let hop = 1; hop <= budgets.graphHops && frontier.length > 0; hop++) {
      const next: Array<{ node: string; anchored: boolean }> = [];
      for (const { node, anchored } of frontier) {
        for (const { to, edge } of adjacency.get(node) ?? []) {
          if (visitedEdges.size >= budgets.graphEdges || visitedNodes.size >= budgets.graphNodes) break;
          const edgeKey = `${edge.entity_a}|${edge.relation}|${edge.entity_b}|${edge.src_record_id}`;
          if (visitedEdges.has(edgeKey)) continue;
          visitedEdges.add(edgeKey);
          if (!visitedNodes.has(to)) {
            visitedNodes.set(to, anchored);
            next.push({ node: to, anchored });
          }
          if (s8Added >= budgets.fusedCeiling) break;
          const srcKey = `db:durable:${edge.src_record_id}:${req.owner}:${edge.src_version}`;
          const key = `graph:${edge.entity_a}|${edge.relation}|${edge.entity_b}:${srcKey}`;
          if (candidates.has(key)) continue;
          const srcDoc = req.db.prepare(
            "SELECT id FROM recall_documents WHERE owner = ? AND generation = ? AND layer = 'durable' AND record_id = ? AND source_version = ?",
          ).get(req.owner, req.generation, edge.src_record_id, edge.src_version) as { id: number } | undefined;
          if (!srcDoc) continue;
          const graphRef: OwnedRecallRef = { kind: "graph", edge: `${edge.entity_a}|${edge.relation}|${edge.entity_b}`, sources: [srcKey] };
          const candidate: StageCandidate = {
            key,
            kind: "graph",
            ref: graphRef,
            docId: srcDoc.id,
            owner: req.owner,
            safeText: `${edge.entity_a} ${edge.relation} ${edge.entity_b}`,
            authority: "inference",
            scope: '{"scope":"general"}',
            sourceMessageIds: [],
            excerpt: `${edge.entity_a} —[${edge.relation}]→ ${edge.entity_b}`,
            provenance: `graph ${hop} hop(s) from anchored entities`,
            rationale: `related entity relationship (${hop} hop(s))`,
            ranks: { graph: s8Added },
            anchorCoverage: 0,
            weaker: false,
            required: false,
            score: 0,
            seedFromAnchor: anchored,
          };
          candidates.set(key, candidate);
          s8Added++;
        }
        if (visitedEdges.size >= budgets.graphEdges || visitedNodes.size >= budgets.graphNodes) break;
      }
      frontier = next;
    }
    setOutcome("S8", "completed", s8Added);
  } catch (err) {
    setOutcome("S8", "failed", 0, err instanceof Error ? err.message.slice(0, 160) : "s8 failed");
  }

  // --- Fusion: RRF over ranks, coverage tiers, prominence tiebreak ---
  // Scores are incomparable across stages, so ranks fuse (K=60). Tiers keep
  // strong all-anchor matches ahead of partial and weaker evidence;
  // prominence only breaks ties within a tier and never admits or excludes.
  checkPoint(req);
  const anchorTerms = terms;
  const fused = [...candidates.values()];
  for (const c of fused) {
    c.anchorCoverage = coverageOf(`${c.safeText}\n${c.originalText ?? ""}`, anchorTerms);
    let relevance = 0;
    if (c.ranks.porter !== undefined) relevance += rrfTerm(c.ranks.porter);
    if (c.ranks.trigramEn !== undefined) relevance += rrfTerm(c.ranks.trigramEn);
    if (c.ranks.trigramOrig !== undefined) relevance += rrfTerm(c.ranks.trigramOrig);
    if (c.ranks.embedding !== undefined) relevance += rrfTerm(c.ranks.embedding);
    if (c.ranks.signature !== undefined) relevance += rrfTerm(c.ranks.signature);
    if (c.ranks.graph !== undefined) relevance += rrfTerm(c.ranks.graph);
    if (c.ranks.context !== undefined) relevance += CONTEXT_RANK_WEIGHT * rrfTerm(c.ranks.context);
    if (relevance === 0) relevance = 0.01;
    c.score = relevance;
  }
  const hasSfRank = (c: StageCandidate): boolean =>
    c.ranks.porter !== undefined || c.ranks.trigramEn !== undefined || c.ranks.trigramOrig !== undefined;
  for (const c of fused) {
    const ctxOnly = c.ranks.context !== undefined && !hasSfRank(c) && c.ranks.embedding === undefined
      && c.ranks.signature === undefined && c.ranks.graph === undefined;
    if (!ctxOnly && c.anchorCoverage === 1 && hasSfRank(c) && c.score < STRONG_FLOOR) c.score = STRONG_FLOOR;
    if (ctxOnly && c.anchorCoverage === 1 && c.score < STRONG_FLOOR * CONTEXT_RANK_WEIGHT) {
      c.score = STRONG_FLOOR * CONTEXT_RANK_WEIGHT;
    }
  }
  // Anchor-support gate: signature-only/fuzzy matches without lexical,
  // semantic, anchored-graph, or accepted-context binding are weaker
  // evidence. Fast/normal exclude them; full labels them below strong.
  let gatedOut = 0;
  for (const c of fused) {
    const bound = c.anchorCoverage > 0 || c.ranks.embedding !== undefined
      || (c.ranks.graph !== undefined && c.seedFromAnchor === true)
      || c.ranks.context !== undefined;
    if (bound) continue;
    if (req.profile === "recall_full") {
      c.weaker = true;
      if (!c.rationale.startsWith("weaker")) c.rationale = `weaker ${c.rationale}`;
    } else {
      c.score = -1;
      gatedOut++;
    }
  }
  const supported = fused.filter((c) => c.score >= 0);
  if (gatedOut > 0) {
    omissionReasons.push(`anchor-support: ${gatedOut} signature-only/fuzzy candidate(s) excluded in ${req.profile}`);
  }
  // Prominence ranks/diversifies otherwise comparable eligible episodes
  // only: an epsilon tiebreak that cannot cross tiers, override authority,
  // or suppress required evidence. Zero prominence never discards.
  const prominenceByDoc = new Map<number, number>();
  try {
    const episodeDocIds = [...new Set(supported.filter((c) => c.layer === "episode" && c.docId !== null).map((c) => c.docId as number))];
    if (episodeDocIds.length > 0) {
      const ph = episodeDocIds.map(() => "?").join(",");
      const rows = req.db.prepare(
        `SELECT d.id AS docId, stm.prominence AS prominence FROM recall_documents d
         JOIN short_term_memories stm ON stm.id = d.record_id AND stm.user_id = d.owner
         WHERE d.owner = ? AND d.generation = ? AND d.layer = 'episode' AND d.id IN (${ph})`,
      ).all(req.owner, req.generation, ...episodeDocIds) as Array<{ docId: number; prominence: number }>;
      for (const row of rows) prominenceByDoc.set(row.docId, row.prominence);
    }
  } catch {
    // Prominence unavailable: order falls back to fused ranks alone.
  }
  for (const c of supported) {
    const tier = c.anchorCoverage === 1 ? 2 : c.anchorCoverage > 0 ? 1 : 0;
    c.tier = tier;
    c.score = tier * 1000 + c.score + (c.docId !== null ? (prominenceByDoc.get(c.docId) ?? 0) * PROMINENCE_EPSILON : 0);
  }
  const orderTiered = (list: StageCandidate[]): StageCandidate[] => {
    const ordered: StageCandidate[] = [];
    for (const tier of [2, 1, 0]) {
      const group = list.filter((c) => c.tier === tier).sort((a, b) => b.score - a.score);
      if (group.length === 0) continue;
      const mmrIn = group.slice(0, Math.min(group.length, MMR_INPUT_CAP)).map((c) => ({ cand: c, content: c.safeText, score: c.score }));
      ordered.push(...applyMMR(mmrIn, MMR_LAMBDA).map((w) => w.cand));
      if (group.length > MMR_INPUT_CAP) ordered.push(...group.slice(MMR_INPUT_CAP));
    }
    return ordered;
  };

  const pass1 = orderTiered(supported).slice(0, req.maxItems);
  checkPoint(req);

  // --- Required evidence: scoped exceptions and unresolved competitors ---
  // Retrieved before rendering so a resolved belief never hides them.
  const requiredExtras: StageCandidate[] = [];
  try {
    const provisionalDurables = pass1.filter((c) => c.kind === "db" && c.layer === "durable" && c.recordId !== undefined);
    for (const item of provisionalDurables.slice(0, req.maxItems)) {
      const recordId = item.recordId as number;
      const exceptions = req.db.prepare(
        `SELECT id, revision, content, content_original, authority, applicability_scope, evidence FROM long_term_memories
         WHERE user_id = ? AND superseded_by_id IS NULL AND classification <= 2 AND encrypted = 0 AND id != ?
         AND json_valid(provenance) AND json_extract(provenance, '$.scopedExceptionOf') = ? LIMIT 4`,
      ).all(req.owner, recordId, recordId) as Array<{
        id: number; revision: number; content: string; content_original: string | null;
        authority: string; applicability_scope: string; evidence: string;
      }>;
      for (const ex of exceptions) {
        if (requiredExtras.length >= 8) break;
        try {
          if (isSuppressedByForget(req.db, req.owner, { durableId: ex.id })) continue;
        } catch {
          continue;
        }
        const existing = candidates.get(`db:durable:${ex.id}:${req.owner}:${ex.revision}`);
        if (existing) {
          existing.required = true;
          continue;
        }
        requiredExtras.push(mkRequiredDbCandidate(req.owner, ex.id, String(ex.revision), registryDocId(req.db, req.owner, req.generation, "durable", ex.id), {
          content: ex.content, original: ex.content_original ?? "", authority: ex.authority,
          scope: ex.applicability_scope, evidence: ex.evidence,
        }, `required scoped exception to durable ${recordId}`));
      }
      const scopeRow = req.db.prepare("SELECT applicability_scope FROM long_term_memories WHERE id = ? AND user_id = ?").get(recordId, req.owner) as { applicability_scope: string } | undefined;
      if (scopeRow && requiredExtras.length < 8) {
        const rivals = req.db.prepare(
          `SELECT id, revision, content, content_original, authority, applicability_scope, evidence FROM long_term_memories
           WHERE user_id = ? AND superseded_by_id IS NULL AND classification <= 2 AND encrypted = 0 AND id != ?
           AND applicability_scope = ? AND authority IN ('user_statement', 'confirmed_decision') LIMIT 4`,
        ).all(req.owner, recordId, scopeRow.applicability_scope) as Array<{
          id: number; revision: number; content: string; content_original: string | null;
          authority: string; applicability_scope: string; evidence: string;
        }>;
        for (const rival of rivals) {
          if (requiredExtras.length >= 8) break;
          try {
            if (isSuppressedByForget(req.db, req.owner, { durableId: rival.id })) continue;
          } catch {
            continue;
          }
          const existing = candidates.get(`db:durable:${rival.id}:${req.owner}:${rival.revision}`);
          if (existing) {
            existing.required = true;
            continue;
          }
          requiredExtras.push(mkRequiredDbCandidate(req.owner, rival.id, String(rival.revision), registryDocId(req.db, req.owner, req.generation, "durable", rival.id), {
            content: rival.content, original: rival.content_original ?? "", authority: rival.authority,
            scope: rival.applicability_scope, evidence: rival.evidence,
          }, "required competing claim (unresolved)"));
        }
      }
    }
  } catch (err) {
    omissionReasons.push(`required-evidence: competitor lookup failed (${err instanceof Error ? err.message.slice(0, 120) : "unknown"})`);
  }
  for (const extra of requiredExtras) {
    if (candidates.has(extra.key)) continue;
    extra.tier = Math.min(extra.anchorCoverage === 1 ? 2 : extra.anchorCoverage > 0 ? 1 : 0, 1);
    extra.score = extra.tier * 1000 + 0.5;
    candidates.set(extra.key, extra);
  }

  // --- S6: full-only bounded supplementary summaries ---
  if (req.profile === "recall_full") {
    checkPoint(req);
    if (req.memoryDir === null) {
      setOutcome("S6", "disabled", 0, "no-memory-dir");
      omissionReasons.push("S6-disabled: no memory directory");
    } else {
      try {
        let pending = false;
        try {
          pending = req.db.prepare("SELECT 1 FROM forget_operations WHERE owner = ? AND state = 'pending' LIMIT 1").get(req.owner) !== undefined;
        } catch {
          pending = true;
        }
        const summary = await searchOwnedSummaries({
          memoryDir: req.memoryDir,
          owner: req.owner,
          keywords: terms.slice(0, 12),
          timeStart: req.filters.timeStart,
          timeEnd: req.filters.timeEnd,
          deadlineAt: req.deadlineAt,
          signal: req.signal,
          barrierPending: pending,
          checkSuperseded: buildSupersededCheck(req.db, req.owner),
        });
        setOutcome("S6", summary.status === "completed" ? "completed" : "partial", summary.candidates.length,
          summary.omitted[0] ?? (summary.status === "completed" ? undefined : "s6-partial"));
        omissionReasons.push(...summary.omitted.slice(0, 4).map((o) => `S6: ${o}`));
        for (const s of summary.candidates) {
          if (candidates.has(s.key)) continue;
          candidates.set(s.key, {
            key: s.key,
            kind: "artifact",
            ref: s.ref,
            docId: null,
            owner: req.owner,
            safeText: s.excerpt,
            authority: "summary",
            scope: '{"scope":"general"}',
            sourceMessageIds: [],
            excerpt: s.excerpt,
            provenance: `summary ${s.coveredPeriod}`,
            rationale: `supplementary summary (${s.coveredPeriod})`,
            ranks: {},
            anchorCoverage: 0,
            weaker: true,
            required: false,
            score: 0.02,
            tier: 0,
          });
        }
      } catch (err) {
        if (err instanceof OwnedPipelineCancelled) throw err;
        setOutcome("S6", "failed", 0, err instanceof Error ? err.message.slice(0, 160) : "s6 failed");
      }
    }
  } else {
    setOutcome("S6", "disabled", 0, "disabled-by-profile");
  }

  // --- Final assembly: order, page, reserve, cap ---
  checkPoint(req);
  const pool = [...candidates.values()].filter((c) => c.score >= 0 || c.weaker);
  for (const c of pool) {
    if (c.tier === undefined) {
      const tier = c.anchorCoverage === 1 ? 2 : c.anchorCoverage > 0 ? 1 : 0;
      c.tier = c.required ? Math.min(tier, 1) : tier;
      if (c.score < c.tier * 1000) c.score = c.tier * 1000 + (c.score % 1000);
    }
  }
  const ordered = orderTiered(pool.filter((c) => !req.excludeRefKeys?.has(c.key)));
  if (req.excludeRefKeys && req.excludeRefKeys.size > 0) {
    omissionReasons.push(`continuation-paging: excluded ${req.excludeRefKeys.size} already-seen reference(s)`);
  }
  let reserved: StageCandidate[] = [];
  if (req.reserveRefKeys && req.reserveRefKeys.length > 0) {
    reserved = resolveReserveItems(req, req.reserveRefKeys, omissionReasons);
    if (reserved.length > req.maxItems) {
      omissionReasons.push(`insufficient-capacity: retained ${reserved.length} still-valid strong item(s) over ${req.maxItems} capacity`);
      checkPoint(req);
      const enrichedReserved = await enrichSelected(req, budgets, reserved.slice(0, req.maxItems), omissionReasons);
      return finishPipeline(req, stageOutcomes, omissionReasons, enrichedReserved, startedAt);
    }
  }
  const freshKeys = new Set(reserved.map((r) => r.key));
  const fresh = ordered.filter((c) => !freshKeys.has(c.key)).slice(0, Math.max(0, req.maxItems - reserved.length));
  const selected = [...reserved, ...fresh];
  checkPoint(req);

  // --- Enrichment: source rows, grounding, neighbors, history ---
  const enriched = await enrichSelected(req, budgets, selected, omissionReasons);
  return finishPipeline(req, stageOutcomes, omissionReasons, enriched, startedAt);
}

function substringsOf(word: string, minLen = 4): string[] {
  const out: string[] = [];
  if (word.length <= minLen + 2) return out;
  for (let len = word.length - 1; len >= minLen; len--) {
    for (let i = 0; i + len <= word.length; i++) {
      out.push(word.slice(i, i + len));
      if (out.length >= 6) return out;
    }
  }
  return out;
}

async function awaitForeground(
  promise: Promise<Float32Array | null>,
  ms: number,
): Promise<{ state: "ready"; vector: Float32Array } | { state: "failed" | "deadline"; vector: null }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ state: "deadline", vector: null });
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    promise.then(
      (vector) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(vector ? { state: "ready", vector } : { state: "failed", vector: null });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ state: "failed", vector: null });
      },
    );
  });
}

/**
 * Required-evidence candidate from a source row: never filtered by
 * prominence or anchor gates, capped below strong matches.
 */
function mkRequiredDbCandidate(
  owner: string,
  recordId: number,
  version: string,
  docId: number | null,
  src: { content: string; original: string; authority: string; scope: string; evidence: string },
  rationale: string,
): StageCandidate {
  const ref: OwnedRecallRef = { kind: "db", layer: "durable", recordId, owner, version };
  return {
    key: ownedRefKey(ref),
    kind: "db",
    ref,
    layer: "durable",
    docId,
    recordId,
    owner,
    version,
    safeText: src.content,
    authority: src.authority,
    scope: src.scope,
    sourceMessageIds: messageIdsOf(src.evidence),
    excerpt: src.content,
    provenance: "required evidence (competitor/exception)",
    rationale,
    ranks: {},
    anchorCoverage: 0,
    weaker: false,
    required: true,
    score: 0,
    originalText: src.original,
  };
}

function registryDocId(db: Database.Database, owner: string, generation: number, layer: string, recordId: number): number | null {
  try {
    const row = db.prepare(
      "SELECT id FROM recall_documents WHERE owner = ? AND generation = ? AND layer = ? AND record_id = ?",
    ).get(owner, generation, layer, recordId) as { id: number } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/** Resolve reserved continuation refs to still-valid candidates. */
function resolveReserveItems(
  req: OwnedPipelineRequest,
  keys: readonly string[],
  omissionReasons: string[],
): StageCandidate[] {
  const out: StageCandidate[] = [];
  for (const key of keys.slice(0, 128)) {
    const m = /^db:(durable|episode):([1-9]\d*):(.+):(.+)$/.exec(key);
    if (!m?.[1] || !m[2] || !m[3] || !m[4]) {
      omissionReasons.push(`continuation-invalid: unparseable reserved ref`);
      continue;
    }
    const [, layer, recordIdRaw, keyOwner, version] = m;
    if (keyOwner !== req.owner) {
      omissionReasons.push(`continuation-invalid: reserved ref owner mismatch`);
      continue;
    }
    const recordId = Number(recordIdRaw);
    try {
      const row = req.db.prepare(
        `SELECT ${DOC_COLS} FROM recall_documents d WHERE d.owner = ? AND d.generation = ? AND d.layer = ? AND d.record_id = ?`,
      ).get(req.owner, req.generation, layer, recordId) as DocRow | undefined;
      if (!row || row.source_version !== version) {
        omissionReasons.push(`continuation-stale: reserved ${layer} ${recordId} changed since lookup`);
        continue;
      }
      try {
        if (isSuppressedByForget(req.db, req.owner, layer === "durable" ? { durableId: recordId } : { episodeId: recordId })) {
          omissionReasons.push(`continuation-stale: reserved ${layer} ${recordId} forgotten`);
          continue;
        }
      } catch {
        continue;
      }
      const c = rowToCandidate(row, req.owner, row.safe_text, "continued strong evidence");
      c.tier = 2;
      c.score = 2000 + out.length;
      out.push(c);
    } catch {
      omissionReasons.push(`continuation-stale: reserved ${layer} ${recordId} unreadable`);
    }
  }
  return out;
}

/** Superseded-retelling check for S6: excerpt matches a superseded (but no current) source. */
function buildSupersededCheck(db: Database.Database, owner: string): (excerpt: string) => boolean {
  let oldContents: string[] | null = null;
  let curContents: string[] | null = null;
  const load = (): void => {
    if (oldContents !== null) return;
    oldContents = [];
    curContents = [];
    try {
      const revs = db.prepare("SELECT content FROM long_term_revisions WHERE user_id = ? LIMIT 200").all(owner) as Array<{ content: string }>;
      for (const r of revs) oldContents.push(r.content);
      const superseded = db.prepare("SELECT content FROM long_term_memories WHERE user_id = ? AND superseded_by_id IS NOT NULL LIMIT 200").all(owner) as Array<{ content: string }>;
      for (const r of superseded) oldContents.push(r.content);
      const cur = db.prepare("SELECT content FROM long_term_memories WHERE user_id = ? AND superseded_by_id IS NULL LIMIT 500").all(owner) as Array<{ content: string }>;
      for (const r of cur) curContents?.push(r.content);
    } catch {
      oldContents = [];
      curContents = [];
    }
  };
  return (excerpt: string): boolean => {
    load();
    const window = excerpt.slice(0, 160);
    if (window.length < 40 || !oldContents || !curContents) return false;
    return oldContents.some((o) => o.includes(window)) && !curContents.some((c) => c.includes(window));
  };
}

type EnrichBudgets = { groundingExcerpts: number };

/**
 * Final enrichment for selected candidates: source authority/scope/
 * currentness, safe grounding quotes, full-only neighbor expansion, and
 * as-of history substitution. Drops candidates that no longer revalidate.
 */
async function enrichSelected(
  req: OwnedPipelineRequest,
  budgets: EnrichBudgets,
  selected: StageCandidate[],
  omissionReasons: string[],
): Promise<OwnedPipelineItem[]> {
  checkPoint(req);
  const items: OwnedPipelineItem[] = [];
  const docIds = selected.filter((c) => c.kind === "db" && c.docId !== null).map((c) => c.docId as number);
  const durableByDoc = new Map<number, {
    content: string; authority: string; scope: string; classification: number; revision: number;
    validFrom: string | null; validTo: string | null; evidence: string; createdAt: number;
  }>();
  const episodeByDoc = new Map<number, { topic: string; evidenceExcerpts: string; classification: number }>();
  try {
    if (docIds.length > 0) {
      const ph = docIds.map(() => "?").join(",");
      const rows = req.db.prepare(
        `SELECT d.id AS docId, ltm.content, ltm.authority, ltm.applicability_scope AS scope, ltm.classification,
                ltm.revision, ltm.valid_from AS validFrom, ltm.valid_to AS validTo, ltm.evidence, ltm.created_at AS createdAt
         FROM recall_documents d JOIN long_term_memories ltm ON ltm.id = d.record_id AND ltm.user_id = d.owner
         WHERE d.id IN (${ph}) AND d.layer = 'durable'`,
      ).all(...docIds) as Array<{
        docId: number; content: string; authority: string; scope: string; classification: number;
        revision: number; validFrom: string | null; validTo: string | null; evidence: string; createdAt: number;
      }>;
      for (const r of rows) durableByDoc.set(r.docId, r);
      const erows = req.db.prepare(
        `SELECT d.id AS docId, stm.topic, stm.evidence_excerpts AS evidenceExcerpts, stm.classification
         FROM recall_documents d JOIN short_term_memories stm ON stm.id = d.record_id AND stm.user_id = d.owner
         WHERE d.id IN (${ph}) AND d.layer = 'episode'`,
      ).all(...docIds) as Array<{ docId: number; topic: string; evidenceExcerpts: string; classification: number }>;
      for (const r of erows) episodeByDoc.set(r.docId, r);
    }
  } catch (err) {
    omissionReasons.push(`enrichment: source read failed (${err instanceof Error ? err.message.slice(0, 120) : "unknown"})`);
  }
  let groundingUsed = 0;
  const groundingBudget = budgets.groundingExcerpts;
  const withheldNotes = new Set<string>();
  const quoteFor = (messageId: number, wantExcerpt: string): string | null => {
    try {
      const msg = req.db.prepare("SELECT user_id, content, session_id, timestamp FROM messages WHERE id = ?").get(messageId) as
        | { user_id: string; content: string; session_id: string; timestamp: number } | undefined;
      if (!msg) {
        if (withheldNotes.size < 8) withheldNotes.add(`source-withheld: evidence message ${messageId} pruned`);
        return null;
      }
      if (msg.user_id !== req.owner) {
        if (withheldNotes.size < 8) withheldNotes.add(`source-withheld: evidence message ${messageId} foreign owner`);
        return null;
      }
      if (!msg.content.includes(wantExcerpt)) return null;
      try {
        if (isSuppressedByForget(req.db, req.owner, { messageId })) return null;
      } catch {
        return null;
      }
      return msg.content;
    } catch {
      return null;
    }
  };
  for (const c of selected) {
    if (c.kind === "artifact") {
      items.push({
        key: c.key,
        ref: c.ref,
        docId: null,
        excerpt: c.excerpt,
        authority: "summary",
        scope: '{"scope":"general"}',
        currentness: "historical-unverified",
        rationale: c.rationale,
        provenance: c.provenance,
        sourceRefs: [],
        sourceMessageIds: [],
        weaker: true,
        required: false,
        score: c.score,
      });
      continue;
    }
    if (c.kind === "graph") {
      items.push({
        key: c.key,
        ref: c.ref,
        docId: c.docId,
        excerpt: c.excerpt,
        authority: c.authority,
        scope: c.scope,
        currentness: "current",
        rationale: c.rationale,
        provenance: c.provenance,
        sourceRefs: [],
        sourceMessageIds: [],
        weaker: c.weaker,
        required: false,
        score: c.score,
      });
      continue;
    }
    // Required db candidates may lack a registry doc id; resolve it now so
    // enrichment and selection share one identity. A missing doc means the
    // serving generation does not cover an eligible source: omit loudly
    // rather than publishing an unverified ref.
    if (c.docId === null && c.layer && c.recordId !== undefined) {
      const found = registryDocId(req.db, req.owner, req.generation, c.layer, c.recordId);
      if (found === null) {
        omissionReasons.push(`required-unindexed: ${c.layer} ${c.recordId} has no serving-generation document`);
        continue;
      }
      c.docId = found;
    }
    const src = c.layer === "durable" ? durableByDoc.get(c.docId ?? -1) : undefined;
    const esrc = c.layer === "episode" ? episodeByDoc.get(c.docId ?? -1) : undefined;
    if (!src && !esrc) {
      omissionReasons.push(`stale-version: ${c.layer} doc ${c.docId} source gone`);
      continue;
    }
    try {
      const suppressed = c.layer === "durable"
        ? isSuppressedByForget(req.db, req.owner, { durableId: c.recordId })
        : isSuppressedByForget(req.db, req.owner, { episodeId: c.recordId });
      if (suppressed) {
        omissionReasons.push(`forgotten: ${c.layer} ${c.recordId} suppressed before publication`);
        continue;
      }
    } catch {
      omissionReasons.push(`stale-version: ${c.layer} ${c.recordId} revalidation failed`);
      continue;
    }
    let excerpt = c.excerpt;
    let currentness = "current";
    // As-of history: resolve the then-applicable revision and label it.
    if (req.filters.historyIntent && req.filters.asOf && c.layer === "durable" && src) {
      const day = req.filters.asOf.slice(0, 10);
      const curCovers = (src.validFrom ?? "") <= day && (src.validTo === null || src.validTo > day);
      if (curCovers) {
        currentness = `historical (as of ${day})`;
      } else {
        let rev: { content: string } | undefined;
        try {
          rev = req.db.prepare(
            `SELECT content FROM long_term_revisions WHERE memory_id = ? AND user_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY revision DESC LIMIT 1`,
          ).get(c.recordId, req.owner, day, day) as typeof rev;
        } catch {
          rev = undefined;
        }
        if (!rev) {
          omissionReasons.push(`no-applicable-revision: durable ${c.recordId} at ${day}`);
          continue;
        }
        excerpt = rev.content;
        currentness = `historical (as of ${day})`;
      }
    }
    // Safe grounding quotes from preserved source excerpts.
    const quotes: string[] = [];
    const quotedIds: Array<{ id: number; version: string }> = [];
    if (groundingUsed < groundingBudget) {
      const wanted = c.layer === "durable" ? evidenceExcerptsOf(src?.evidence ?? "[]") : evidenceExcerptsOf(esrc?.evidenceExcerpts ?? "[]");
      for (const w of wanted) {
        if (groundingUsed >= groundingBudget) break;
        const quoted = quoteFor(w.messageId, w.excerpt);
        if (quoted === null) continue;
        groundingUsed++;
        quotes.push(quoted);
        quotedIds.push({ id: w.messageId, version: createHash("sha256").update(quoted, "utf-8").digest("hex").slice(0, 16) });
        // Full-only neighbor expansion: one preceding and one following
        // message per authorized source, within session and caller bounds.
        if (req.profile === "recall_full" && groundingUsed < groundingBudget) {
          try {
            const anchor = req.db.prepare("SELECT session_id, timestamp FROM messages WHERE id = ? AND user_id = ?").get(w.messageId, req.owner) as
              | { session_id: string; timestamp: number } | undefined;
            if (anchor) {
              const timeClauses: string[] = [];
              const timeParams: unknown[] = [];
              if (req.filters.timeStart !== undefined) { timeClauses.push("timestamp >= ?"); timeParams.push(req.filters.timeStart); }
              if (req.filters.timeEnd !== undefined) { timeClauses.push("timestamp <= ?"); timeParams.push(req.filters.timeEnd); }
              const extra = timeClauses.length > 0 ? `AND ${timeClauses.join(" AND ")}` : "";
              const prev = req.db.prepare(
                `SELECT id, content FROM messages WHERE user_id = ? AND session_id = ? AND timestamp < ? ${extra} ORDER BY timestamp DESC LIMIT 1`,
              ).get(req.owner, anchor.session_id, anchor.timestamp, ...timeParams) as { id: number; content: string } | undefined;
              const nextMsg = req.db.prepare(
                `SELECT id, content FROM messages WHERE user_id = ? AND session_id = ? AND timestamp > ? ${extra} ORDER BY timestamp ASC LIMIT 1`,
              ).get(req.owner, anchor.session_id, anchor.timestamp, ...timeParams) as { id: number; content: string } | undefined;
              for (const neighbor of [prev, nextMsg]) {
                if (!neighbor || groundingUsed >= groundingBudget) break;
                try {
                  if (isSuppressedByForget(req.db, req.owner, { messageId: neighbor.id })) continue;
                } catch {
                  continue;
                }
                groundingUsed++;
                quotes.push(neighbor.content);
                quotedIds.push({ id: neighbor.id, version: createHash("sha256").update(neighbor.content, "utf-8").digest("hex").slice(0, 16) });
              }
            }
          } catch {
            // Neighbor expansion is supplementary: failure keeps the quote.
          }
        }
      }
    }
    if (quotes.length > 0) {
      excerpt = `${excerpt}\n\nGrounded sources:\n${quotes.map((q) => `- ${q.slice(0, 2000)}`).join("\n")}`;
    }
    const ref = c.ref;
    items.push({
      key: c.key,
      ref,
      docId: c.docId,
      excerpt,
      authority: c.authority,
      scope: c.scope,
      currentness,
      rationale: c.required ? `required ${c.rationale}` : c.weaker ? `weaker ${c.rationale}` : c.rationale,
      provenance: c.provenance,
      sourceRefs: quotedIds.map((q) => `db:raw:${q.id}:${req.owner}:${q.version}`),
      sourceMessageIds: c.sourceMessageIds,
      weaker: c.weaker,
      required: c.required,
      score: c.score,
    });
  }
  for (const note of withheldNotes) omissionReasons.push(note);
  return items;
}

function evidenceExcerptsOf(raw: string): Array<{ messageId: number; excerpt: string }> {
  try {
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    const out: Array<{ messageId: number; excerpt: string }> = [];
    for (const e of entries) {
      if (typeof e !== "object" || e === null) continue;
      const r = e as Record<string, unknown>;
      const messageId = typeof r.messageId === "number" ? r.messageId : Number(/^(?:messages:)?([1-9]\d*)$/.exec(String(r.ref ?? ""))?.[1]);
      if (Number.isSafeInteger(messageId) && typeof r.excerpt === "string" && r.excerpt.length > 0) {
        out.push({ messageId, excerpt: r.excerpt });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function finishPipeline(
  req: OwnedPipelineRequest,
  stageOutcomes: Record<string, { status: string; hitCount: number; reason?: string }>,
  omissionReasons: string[],
  items: OwnedPipelineItem[],
  startedAt: number,
): OwnedPipelineOutcome {
  void req;
  return { items, stageOutcomes, omissionReasons, elapsedMs: Date.now() - startedAt };
}
/**
 * Stable hash binding a lookup for continuation validation. The profile is
 * deliberately excluded: normal-to-full escalation keeps the same anchor.
 */
export function anchorHashOf(anchorText: string, keywords: readonly string[], contextTerms: readonly string[], filters: OwnedFilters, principal: string): string {
  return createHash("sha256")
    .update([anchorText, ...keywords, ...contextTerms, JSON.stringify(filters ?? null), principal].join("\0"), "utf-8")
    .digest("hex");
}
