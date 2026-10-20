/**
 * personal-durable.ts — Durable learned knowledge layer (C2) with authority
 * classes, applicability scope, and revision-safe supersession (#1930 M2).
 *
 * Durable rows carry no age-based decay or expiry. New information updates
 * or supersedes applicable knowledge while preserving earlier history and
 * scoped exceptions. Consolidation/conversion cannot manufacture user
 * authority: only user evidence or explicit confirmation yields
 * user_statement/confirmed_decision.
 */

import type Database from "better-sqlite3";
import { generateSignature } from "./signature-generator.js";
import { isPersonalReady } from "./personal-schema.js";
import type { AuthorityClass } from "./personal-episodes.js";
import { validateClassification, validatePersonalEvidence } from "./personal-evidence.js";
import { isSuppressedByForget } from "./personal-forget.js";
import { indexDurableDocument, dropSourceDocuments } from "./recall-projection-build.js";
import { validateGraphProposal, readStoredGraph } from "./recall-projection-build.js";
import type { GraphRelationInput } from "./recall-projection-build.js";

export type DurableGraphInput = {
  readonly entities?: readonly string[];
  readonly relations?: readonly GraphRelationInput[];
};

export type DurableInput = {
  userId: string;
  memoryType: string;
  content: string;
  contentOriginal?: string | null;
  authority: AuthorityClass;
  authorityBasis: string;
  applicabilityScope?: Record<string, unknown>;
  validFrom?: string | null;
  provenance?: Record<string, unknown>;
  evidence: Array<{ kind: string; ref: string; excerpt: string; classification: number }>;
  classification?: number;
  actorId: string;
};

export type DurableRow = {
  id: number;
  user_id: string;
  memory_type: string;
  content: string;
  content_original: string | null;
  authority: AuthorityClass;
  applicability_scope: string;
  valid_from: string | null;
  valid_to: string | null;
  revision: number;
  supersedes_id: number | null;
  superseded_by_id: number | null;
  provenance: string;
  evidence: string;
  classification: number;
  semantic_revision: number;
};

const USER_AUTHORITATIVE: ReadonlySet<AuthorityClass> = new Set(["user_statement", "confirmed_decision"]);

export function isUserAuthoritative(authority: AuthorityClass): boolean {
  return USER_AUTHORITATIVE.has(authority);
}

function requireReady(db: Database.Database): void {
  if (!isPersonalReady(db)) {
    const row = db.prepare("SELECT state, reason FROM personal_model_state WHERE singleton = 1").get() as
      | { state: string; reason: string | null }
      | undefined;
    throw new Error(`personal serving refused: dataset is ${row?.state ?? "unknown"}`);
  }
}

function scopeKey(scope: Record<string, unknown>): string {
  return JSON.stringify(scope);
}

/** Local date (YYYY-MM-DD) for validity defaults. */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * #1928 C8: clean the step-04 proposal graph before storing it in
 * provenance. Entities/relations must appear in the content or evidence
 * excerpts; unknown labels coerce to `related`; counts are bounded.
 * Returns a storable `{entities, relations}` or null when nothing valid
 * remains. Never throws: invalid input yields no graph, never a write
 * refusal (extraction still stores the durable fact).
 */
function cleanGraphForStore(
  content: string,
  evidence: DurableInput["evidence"],
  provenance: Record<string, unknown> | undefined,
): { entities: string[]; relations: GraphRelationInput[] } | null {
  if (!provenance) return null;
  const raw = provenance["graph"];
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const entitiesRaw = Array.isArray(record["entities"]) ? (record["entities"] as unknown[]) : null;
  const relationsRaw = Array.isArray(record["relations"]) ? (record["relations"] as unknown[]) : null;
  if (!entitiesRaw && !relationsRaw) return null;
  const entities: string[] = [];
  if (entitiesRaw) {
    for (const e of entitiesRaw) {
      if (typeof e !== "string") continue;
      entities.push(e);
      if (entities.length >= 8) break;
    }
  }
  const relations: GraphRelationInput[] = [];
  if (relationsRaw) {
    for (const r of relationsRaw) {
      if (typeof r !== "object" || r === null) continue;
      const rec = r as Record<string, unknown>;
      if (typeof rec["a"] !== "string" || typeof rec["b"] !== "string" || typeof rec["rel"] !== "string") continue;
      relations.push({ a: rec["a"] as string, rel: rec["rel"] as string, b: rec["b"] as string });
      if (relations.length >= 8) break;
    }
  }
  const excerpts = evidence.map((e) => e.excerpt);
  const cleaned = validateGraphProposal(content, excerpts, entities.length > 0 ? entities : null, relations.length > 0 ? relations : null);
  if (cleaned.entities.length === 0 && cleaned.relations.length === 0) return null;
  return { entities: [...cleaned.entities], relations: [...cleaned.relations] };
}

/**
 * Store durable knowledge through the single personal writer. Unsupported
 * approval claims never gain user authority: callers requesting a
 * user-authoritative class must supply user evidence or explicit
 * confirmation in authorityBasis + evidence.
 */
export function storeDurable(db: Database.Database, input: DurableInput): { id: number; revision: number } {
  requireReady(db);
  if (!input.userId.trim()) throw new Error("durable requires an owner principal");
  if (!input.content.trim()) throw new Error("durable requires content");
  const classification = input.classification ?? 1;
  validateClassification(classification);
  if (classification >= 3) throw new Error("sealed durable writes require the sealed mutation projection");
  const sourceClassification = validatePersonalEvidence(db, input.userId, input.evidence, isUserAuthoritative(input.authority));
  if (classification < sourceClassification) throw new Error("durable classification cannot downgrade its evidence");
  if (isSuppressedByForget(db, input.userId, { content: input.content, evidence: input.evidence })) throw new Error("durable source has been forgotten");
  if (isUserAuthoritative(input.authority)) {
    const hasUserEvidence = input.evidence.some((e) => e.kind === "user_message" || e.kind === "user_confirmation");
    if (!hasUserEvidence || !input.authorityBasis.trim()) {
      throw new Error("user authority requires user evidence and an authority basis");
    }
  }
  const now = Date.now();
  const scope = input.applicabilityScope ?? { scope: "general" };
  // C8: validate any step-04 proposal graph against content/evidence.
  const cleanedGraph = cleanGraphForStore(input.content.trim(), input.evidence, input.provenance);
  const provenanceToStore: Record<string, unknown> = { ...(input.provenance ?? {}) };
  if (cleanedGraph) provenanceToStore["graph"] = cleanedGraph;
  else delete provenanceToStore["graph"];
  // #1928 M2: the source insert and its retrieval projection share one
  // transaction, so a crash cannot leave a servable row unindexed.
  const id = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO long_term_memories
        (user_id, memory_type, content, content_original, authority, applicability_scope,
         valid_from, revision, provenance, evidence, classification, signature, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.userId,
      input.memoryType,
      input.content.trim(),
      input.contentOriginal ?? null,
      input.authority,
      scopeKey(scope),
      input.validFrom ?? todayLocal(),
      JSON.stringify({ ...provenanceToStore, authorityBasis: input.authorityBasis, actor: input.actorId }),
      JSON.stringify(input.evidence),
      classification,
      Buffer.from(generateSignature(input.content.trim())),
      now,
      now,
    );
    const newId = Number(result.lastInsertRowid);
    indexDurableDocument(db, input.userId, newId);
    return newId;
  })();
  return { id, revision: 1 };
}

/**
 * Scoped correction/supersession: the new revision applies within the
 * overlapping scope/time interval; the prior row keeps its history with
 * valid_to closed and a superseded_by link. Ordinary correction appends;
 * nothing silently overwrites conflicting historical evidence.
 */
export function supersedeDurable(
  db: Database.Database,
  opts: {
    userId: string;
    memoryId: number;
    expectedRevision: number;
    content: string;
    authority: AuthorityClass;
    authorityBasis: string;
    applicabilityScope?: Record<string, unknown>;
    evidence: DurableInput["evidence"];
    actorId: string;
    graph?: DurableGraphInput;
  },
): { id: number; revision: number } {
  requireReady(db);
  const current = db.prepare("SELECT * FROM long_term_memories WHERE id = ? AND user_id = ?").get(
    opts.memoryId,
    opts.userId,
  ) as DurableRow | undefined;
  if (!current) throw new Error("durable memory not found");
  if (current.superseded_by_id !== null) throw new Error("durable memory already superseded");
  if (current.revision !== opts.expectedRevision) throw new Error(`revision conflict (current=${current.revision})`);
  if (!opts.content.trim()) throw new Error("correction requires content");
  if (current.classification >= 3) throw new Error("sealed corrections require the sealed mutation projection");
  const sourceClassification = validatePersonalEvidence(db, opts.userId, opts.evidence, isUserAuthoritative(opts.authority));
  if (current.classification < sourceClassification) throw new Error("correction cannot downgrade its evidence");
  if (isSuppressedByForget(db, opts.userId, { durableId: current.id, content: opts.content, evidence: opts.evidence })) throw new Error("correction source has been forgotten");
  if (isUserAuthoritative(opts.authority)) {
    const hasUserEvidence = opts.evidence.some((e) => e.kind === "user_message" || e.kind === "user_confirmation");
    if (!hasUserEvidence || !opts.authorityBasis.trim()) {
      throw new Error("user authority requires user evidence and an authority basis");
    }
  }
  const now = Date.now();
  const scope = opts.applicabilityScope ?? JSON.parse(current.applicability_scope) as Record<string, unknown>;
  // C8: carry the stored proposal graph forward when the correction supplies
  // none, re-validated against the revised content/evidence; a supplied
  // graph replaces it. Stale endpoints drop out on re-derivation.
  const currentGraph = readStoredGraph(current.provenance);
  const incomingGraph: DurableGraphInput | undefined = opts.graph ?? (currentGraph ? { entities: currentGraph.entities, relations: currentGraph.relations } : undefined);
  const carriedGraph = incomingGraph
    ? cleanGraphForStore(opts.content.trim(), opts.evidence, { graph: { entities: [...(incomingGraph.entities ?? [])], relations: [...(incomingGraph.relations ?? [])] } })
    : null;
  if (scopeKey(scope) !== current.applicability_scope) {
    // A scoped exception must not replace the owner's general knowledge.
    return db.transaction(() => {
      const created = storeDurable(db, { ...opts, memoryType: current.memory_type, validFrom: todayLocal(), classification: current.classification,
        provenance: { scopedExceptionOf: current.id } });
      db.prepare("UPDATE long_term_memories SET supersedes_id = ? WHERE id = ? AND user_id = ?").run(current.id, created.id, opts.userId);
      return created;
    })();
  }
  const txn = db.transaction(() => {
    db.prepare(
      "INSERT INTO long_term_revisions (memory_id, user_id, revision, content, content_original, authority, applicability_scope, valid_from, valid_to, supersedes_id, provenance, evidence, classification, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      current.id,
      current.user_id,
      current.revision,
      current.content,
      current.content_original,
      current.authority,
      current.applicability_scope,
      current.valid_from,
      todayLocal(),
      current.supersedes_id,
      current.provenance,
      current.evidence,
      current.classification,
      now,
    );
    const info = db.prepare(
      `UPDATE long_term_memories SET content = ?, content_original = NULL, authority = ?, applicability_scope = ?,
        revision = revision + 1, semantic_revision = semantic_revision + 1,
        provenance = ?, evidence = ?, signature = ?, embedding = NULL, updated_at = ?,
        valid_from = ?, valid_to = NULL
       WHERE id = ? AND user_id = ? AND revision = ?`,
    ).run(
      opts.content.trim(),
      opts.authority,
      scopeKey(scope),
      JSON.stringify({
        ...(carriedGraph ? { graph: carriedGraph } : {}),
        authorityBasis: opts.authorityBasis,
        actor: opts.actorId,
        supersedes: current.id,
      }),
      JSON.stringify(opts.evidence),
      Buffer.from(generateSignature(opts.content.trim())),
      now,
      todayLocal(),
      opts.memoryId,
      opts.userId,
      opts.expectedRevision,
    );
    if (info.changes !== 1) throw new Error("supersession lost the revision race");
    // #1928 M2: rotate the retrieval projection to the new revision in the
    // same transaction — a crash cannot serve the superseded content.
    dropSourceDocuments(db, opts.userId, "durable", opts.memoryId);
    indexDurableDocument(db, opts.userId, opts.memoryId);
  });
  txn();
  const after = db.prepare("SELECT revision FROM long_term_memories WHERE id = ?").get(opts.memoryId) as {
    revision: number;
  };
  return { id: opts.memoryId, revision: after.revision };
}

export function getDurable(db: Database.Database, userId: string, memoryId: number): DurableRow | undefined {
  return db.prepare("SELECT * FROM long_term_memories WHERE id = ? AND user_id = ?").get(memoryId, userId) as
    | DurableRow
    | undefined;
}

export function listDurable(
  db: Database.Database,
  userId: string,
  opts?: { memoryType?: string; includeSuperseded?: boolean; limit?: number },
): DurableRow[] {
  if (opts?.memoryType) {
    return db.prepare(
      "SELECT * FROM long_term_memories WHERE user_id = ? AND memory_type = ? ORDER BY created_at DESC LIMIT ?",
    ).all(userId, opts.memoryType, opts.limit ?? 50) as DurableRow[];
  }
  if (opts?.includeSuperseded) {
    return db.prepare("SELECT * FROM long_term_memories WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(
      userId,
      opts.limit ?? 50,
    ) as DurableRow[];
  }
  return db.prepare(
    "SELECT * FROM long_term_memories WHERE user_id = ? AND superseded_by_id IS NULL ORDER BY created_at DESC LIMIT ?",
  ).all(userId, opts?.limit ?? 50) as DurableRow[];
}
