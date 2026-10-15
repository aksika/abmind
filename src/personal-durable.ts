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
 * Store durable knowledge through the single personal writer. Unsupported
 * approval claims never gain user authority: callers requesting a
 * user-authoritative class must supply user evidence or explicit
 * confirmation in authorityBasis + evidence.
 */
export function storeDurable(db: Database.Database, input: DurableInput): { id: number; revision: number } {
  requireReady(db);
  if (!input.userId.trim()) throw new Error("durable requires an owner principal");
  if (!input.content.trim()) throw new Error("durable requires content");
  if (input.evidence.length === 0) throw new Error("durable requires preserved evidence");
  if (isUserAuthoritative(input.authority)) {
    const hasUserEvidence = input.evidence.some((e) => e.kind === "user_message" || e.kind === "user_confirmation");
    if (!hasUserEvidence || !input.authorityBasis.trim()) {
      throw new Error("user authority requires user evidence and an authority basis");
    }
  }
  const now = Date.now();
  const scope = input.applicabilityScope ?? { scope: "general" };
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
    JSON.stringify({ ...(input.provenance ?? {}), authorityBasis: input.authorityBasis, actor: input.actorId }),
    JSON.stringify(input.evidence),
    input.classification ?? 1,
    Buffer.from(generateSignature(input.content.trim())),
    now,
    now,
  );
  const id = Number(result.lastInsertRowid);
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
  if (isUserAuthoritative(opts.authority)) {
    const hasUserEvidence = opts.evidence.some((e) => e.kind === "user_message" || e.kind === "user_confirmation");
    if (!hasUserEvidence || !opts.authorityBasis.trim()) {
      throw new Error("user authority requires user evidence and an authority basis");
    }
  }
  const now = Date.now();
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
      current.valid_to,
      current.supersedes_id,
      current.provenance,
      current.evidence,
      current.classification,
      now,
    );
    const scope = opts.applicabilityScope ?? JSON.parse(current.applicability_scope) as Record<string, unknown>;
    const info = db.prepare(
      `UPDATE long_term_memories SET content = ?, authority = ?, applicability_scope = ?,
        revision = revision + 1, semantic_revision = semantic_revision + 1,
        provenance = ?, evidence = ?, signature = ?, updated_at = ?,
        valid_from = ?, valid_to = NULL
       WHERE id = ? AND user_id = ? AND revision = ?`,
    ).run(
      opts.content.trim(),
      opts.authority,
      scopeKey(scope),
      JSON.stringify({ authorityBasis: opts.authorityBasis, actor: opts.actorId, supersedes: current.id }),
      JSON.stringify(opts.evidence),
      Buffer.from(generateSignature(opts.content.trim())),
      now,
      todayLocal(),
      opts.memoryId,
      opts.userId,
      opts.expectedRevision,
    );
    if (info.changes !== 1) throw new Error("supersession lost the revision race");
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
