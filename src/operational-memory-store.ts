/**
 * operational-memory-store.ts — Transactional write seam for the operational
 * memory domain (#1371).
 *
 * Provides hash-guarded optimistic concurrency for revisions and retirements.
 * Not a public CLI/service API in this ticket — that belongs to #1372.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ScopeLevel,
  MemoryStatus,
  DraftStatus,
  EvidenceEntry,
  ProvenanceMap,
  NormalizedScope,
  CreateDraftInput,
  PromoteDraftInput,
  RejectDraftInput,
  ReviseOperationalMemoryInput,
  RetireOperationalMemoryInput,
  OperationalDraft,
  OperationalMemory,
  OperationalMemoryVersion,
  OperationalWriteResult,
} from "./operational-memory-types.js";
import {
  normalizeScope,
  computeContentHash,
  validateCreateDraftInput,
  validatePromoteDraftInput,
  validateRejectDraftInput,
  validateReviseInput,
  validateRetireInput,
  ValidationError,
} from "./operational-memory-types.js";

const TAG = "operational-memory-store";

// ── Helpers ────────────────────────────────────────────────────────────────

function now(): number {
  return Date.now();
}

function jsonOrEmpty<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function extractScope(level: ScopeLevel, platform?: string | null, host?: string | null, workspace?: string | null, repository?: string | null, taskEnvironment?: string | null): NormalizedScope {
  switch (level) {
    case "global": return normalizeScope("global");
    case "platform": return normalizeScope("platform", platform ?? undefined);
    case "host": return normalizeScope("host", host ?? undefined);
    case "workspace": return normalizeScope("workspace", workspace ?? undefined);
    case "repository": return normalizeScope("repository", repository ?? undefined);
    case "task_environment": return normalizeScope("task_environment", taskEnvironment ?? undefined);
  }
}

function ensureJson(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? (Array.isArray(value) ? [] : {}));
}

function parseDraftRow(row: Record<string, unknown>): OperationalDraft {
  return {
    id: row.id as string,
    status: row.status as DraftStatus,
    lesson: row.lesson as string,
    problem: (row.problem as string) ?? null,
    recommendation: (row.recommendation as string) ?? null,
    evidence: jsonOrEmpty<EvidenceEntry[]>(row.evidence_json as string | null, []),
    suggestedScopeLevel: row.suggested_scope_level as ScopeLevel,
    suggestedPlatform: (row.suggested_platform as string) ?? null,
    suggestedHost: (row.suggested_host as string) ?? null,
    suggestedWorkspace: (row.suggested_workspace as string) ?? null,
    suggestedRepository: (row.suggested_repository as string) ?? null,
    suggestedTaskEnvironment: (row.suggested_task_environment as string) ?? null,
    confidence: row.confidence as number,
    sourceTaskId: (row.source_task_id as string) ?? null,
    sourceSessionId: (row.source_session_id as string) ?? null,
    sourceExecutor: (row.source_executor as string) ?? null,
    sourceHost: (row.source_host as string) ?? null,
    provenance: jsonOrEmpty<ProvenanceMap>(row.provenance_json as string | null, {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    promotedMemoryId: (row.promoted_memory_id as string) ?? null,
    rejectedBy: (row.rejected_by as string) ?? null,
    rejectedAt: (row.rejected_at as number) ?? null,
    rejectionReason: (row.rejection_reason as string) ?? null,
  };
}

function parseMemoryRow(row: Record<string, unknown>): OperationalMemory {
  return {
    id: row.id as string,
    status: row.status as MemoryStatus,
    scopeLevel: row.scope_level as ScopeLevel,
    platform: (row.platform as string) ?? null,
    host: (row.host as string) ?? null,
    workspace: (row.workspace as string) ?? null,
    repository: (row.repository as string) ?? null,
    taskEnvironment: (row.task_environment as string) ?? null,
    contentHash: row.content_hash as string,
    currentVersionId: row.current_version_id as string,
    confidence: row.confidence as number,
    provenance: jsonOrEmpty<ProvenanceMap>(row.provenance_json as string | null, {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function parseVersionRow(row: Record<string, unknown>): OperationalMemoryVersion {
  return {
    id: row.id as string,
    memoryId: row.memory_id as string,
    previousVersionId: (row.previous_version_id as string) ?? null,
    status: row.status as MemoryStatus,
    scopeLevel: row.scope_level as ScopeLevel,
    platform: (row.platform as string) ?? null,
    host: (row.host as string) ?? null,
    workspace: (row.workspace as string) ?? null,
    repository: (row.repository as string) ?? null,
    taskEnvironment: (row.task_environment as string) ?? null,
    content: row.content as string,
    contentHash: row.content_hash as string,
    confidence: row.confidence as number,
    provenance: jsonOrEmpty<ProvenanceMap>(row.provenance_json as string | null, {}),
    evidence: jsonOrEmpty<EvidenceEntry[]>(row.evidence_json as string | null, []),
    mutationReason: row.mutation_reason as string,
    actorId: row.actor_id as string,
    createdAt: row.created_at as number,
  };
}

// ── Store ──────────────────────────────────────────────────────────────────

export class OperationalMemoryStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Retrieve a draft by ID. */
  getDraft(draftId: string): OperationalDraft | null {
    const row = this.db.prepare("SELECT * FROM operational_lesson_drafts WHERE id = ?").get(draftId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return parseDraftRow(row);
  }

  /** Retrieve multiple drafts by status, newest first. */
  getDrafts(status?: DraftStatus, limit = 50): OperationalDraft[] {
    let sql = "SELECT * FROM operational_lesson_drafts";
    const params: unknown[] = [];
    if (status) {
      sql += " WHERE status = ?";
      params.push(status);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseDraftRow);
  }

  /** Retrieve a logical memory by ID. */
  getMemory(memoryId: string): OperationalMemory | null {
    const row = this.db.prepare("SELECT * FROM operational_memories WHERE id = ?").get(memoryId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return parseMemoryRow(row);
  }

  /** List active memories matching a scope. */
  getMemoriesByScope(scopeLevel: ScopeLevel, scopeValue?: string, limit = 50): OperationalMemory[] {
    let sql = "SELECT * FROM operational_memories WHERE status = 'active' AND scope_level = ?";
    const params: unknown[] = [scopeLevel];
    if (scopeValue != null) {
      const SCOPE_COLUMNS: Record<string, string> = { global: "id", platform: "platform", host: "host", workspace: "workspace", repository: "repository", task_environment: "task_environment" };
      const col = SCOPE_COLUMNS[scopeLevel];
      if (!col) return [];
      sql += ` AND ${col} = ?`;
      params.push(scopeValue);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseMemoryRow);
  }

  /** Get the version lineage for a memory, newest first. */
  getVersionLineage(memoryId: string, limit = 100): OperationalMemoryVersion[] {
    const rows = this.db.prepare(
      "SELECT * FROM operational_memory_versions WHERE memory_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(memoryId, limit) as Record<string, unknown>[];
    return rows.map(parseVersionRow);
  }

  /** Get a single version by ID. */
  getVersion(versionId: string): OperationalMemoryVersion | null {
    const row = this.db.prepare("SELECT * FROM operational_memory_versions WHERE id = ?").get(versionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return parseVersionRow(row);
  }

  /** Count all operational drafts. */
  countDrafts(): number {
    return (this.db.prepare("SELECT COUNT(*) as cnt FROM operational_lesson_drafts").get() as { cnt: number }).cnt;
  }

  /** Count all operational memories. */
  countMemories(): number {
    return (this.db.prepare("SELECT COUNT(*) as cnt FROM operational_memories").get() as { cnt: number }).cnt;
  }

  // ── Mutation methods ─────────────────────────────────────────────────────

  createDraft(input: CreateDraftInput): OperationalWriteResult<OperationalDraft> {
    try {
      validateCreateDraftInput(input);
    } catch (err) {
      if (err instanceof ValidationError) return { ok: false, code: "validation_error" };
      throw err;
    }

    const id = randomUUID();
    const ts = now();
    const evidence = input.evidence ?? [];
    const provenance = input.provenance ?? {};

    this.db.prepare(`
      INSERT INTO operational_lesson_drafts
        (id, status, lesson, problem, recommendation, evidence_json,
         suggested_scope_level, suggested_platform, suggested_host, suggested_workspace,
         suggested_repository, suggested_task_environment, confidence,
         source_task_id, source_session_id, source_executor, source_host,
         provenance_json, created_at, updated_at)
      VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.lesson, input.problem ?? null, input.recommendation ?? null,
      ensureJson(evidence),
      input.suggestedScopeLevel, input.suggestedPlatform ?? null, input.suggestedHost ?? null,
      input.suggestedWorkspace ?? null, input.suggestedRepository ?? null,
      input.suggestedTaskEnvironment ?? null, input.confidence,
      input.sourceTaskId ?? null, input.sourceSessionId ?? null,
      input.sourceExecutor ?? null, input.sourceHost ?? null,
      ensureJson(provenance), ts, ts,
    );

    return { ok: true, value: this.getDraft(id)! };
  }

  promoteDraft(input: PromoteDraftInput): OperationalWriteResult<OperationalMemory> {
    try {
      validatePromoteDraftInput(input);
    } catch (err) {
      if (err instanceof ValidationError) return { ok: false, code: "validation_error" };
      throw err;
    }

    const txn = this.db.transaction((): OperationalWriteResult<OperationalMemory> => {
      const draft = this.db.prepare("SELECT * FROM operational_lesson_drafts WHERE id = ?").get(input.draftId) as Record<string, unknown> | undefined;
      if (!draft) return { ok: false, code: "not_found" };
      if (draft.status !== "draft") {
        if (draft.status === "promoted" && draft.promoted_memory_id) {
          const mem = this.getMemory(draft.promoted_memory_id as string);
          if (mem) return { ok: true, value: mem };
        }
        return { ok: false, code: "not_found" };
      }

      const curate = input.curate;
      const content = curate?.lesson ?? (draft.lesson as string);
      const scopeLevel = (curate?.scopeLevel ?? draft.suggested_scope_level) as ScopeLevel;

      let scopeValue: string | undefined;
      if (curate?.scopeLevel) {
        scopeValue = curate.platform ?? curate.host ?? curate.workspace ?? curate.repository ?? curate.taskEnvironment ?? undefined;
      } else {
        scopeValue = (draft.suggested_platform as string) ?? (draft.suggested_host as string) ?? (draft.suggested_workspace as string) ?? (draft.suggested_repository as string) ?? (draft.suggested_task_environment as string) ?? undefined;
      }
      const scope = normalizeScope(scopeLevel, scopeValue);
      const confidence = curate?.confidence ?? (draft.confidence as number);
      const provenance = curate?.provenance ?? jsonOrEmpty<ProvenanceMap>(draft.provenance_json as string | null, {});
      const evidence = curate?.evidence ?? jsonOrEmpty<EvidenceEntry[]>(draft.evidence_json as string | null, []);

      const status: MemoryStatus = "active";
      const hashInput = { content, status, scope, confidence, provenance, evidence };
      const contentHash = computeContentHash(hashInput);
      const versionId = randomUUID();
      const memoryId = randomUUID();
      const ts = now();

      this.db.prepare(`
        INSERT INTO operational_memories
          (id, status, scope_level, platform, host, workspace, repository, task_environment,
           content_hash, current_version_id, confidence, provenance_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        memoryId, status, scope.scopeLevel, scope.platform, scope.host,
        scope.workspace, scope.repository, scope.taskEnvironment,
        contentHash, versionId, confidence, ensureJson(provenance), ts, ts,
      );

      this.db.prepare(`
        INSERT INTO operational_memory_versions
          (id, memory_id, previous_version_id, status, scope_level,
           platform, host, workspace, repository, task_environment,
           content, content_hash, confidence, provenance_json, evidence_json,
           mutation_reason, actor_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        versionId, memoryId, null, status, scope.scopeLevel,
        scope.platform, scope.host, scope.workspace, scope.repository, scope.taskEnvironment,
        content, contentHash, confidence, ensureJson(provenance), ensureJson(evidence),
        input.mutationReason, input.actorId, ts,
      );

      this.db.prepare(`
        UPDATE operational_lesson_drafts
        SET status = 'promoted', promoted_memory_id = ?, updated_at = ?
        WHERE id = ?
      `).run(memoryId, ts, input.draftId);

      return { ok: true, value: this.getMemory(memoryId)! };
    });

    return txn();
  }

  rejectDraft(input: RejectDraftInput): OperationalWriteResult<OperationalDraft> {
    try {
      validateRejectDraftInput(input);
    } catch (err) {
      if (err instanceof ValidationError) return { ok: false, code: "validation_error" };
      throw err;
    }

    const txn = this.db.transaction((): OperationalWriteResult<OperationalDraft> => {
      const draft = this.db.prepare("SELECT * FROM operational_lesson_drafts WHERE id = ?").get(input.draftId) as Record<string, unknown> | undefined;
      if (!draft) return { ok: false, code: "not_found" };
      if (draft.status !== "draft") {
        return { ok: true, value: parseDraftRow(draft) as unknown as OperationalDraft };
      }

      const ts = now();
      const result = this.db.prepare(`
        UPDATE operational_lesson_drafts
        SET status = 'rejected', rejected_by = ?, rejected_at = ?, rejection_reason = ?, updated_at = ?
        WHERE id = ? AND status = 'draft'
      `).run(input.rejectedBy, ts, input.rejectionReason, ts, input.draftId);

      if (result.changes === 0) {
        const updated = this.db.prepare("SELECT * FROM operational_lesson_drafts WHERE id = ?").get(input.draftId) as Record<string, unknown> | undefined;
        if (!updated) return { ok: false, code: "not_found" };
        return { ok: true, value: parseDraftRow(updated) };
      }

      return { ok: true, value: this.getDraft(input.draftId)! };
    });

    return txn();
  }

  revise(input: ReviseOperationalMemoryInput): OperationalWriteResult<OperationalMemory> {
    try {
      validateReviseInput(input);
    } catch (err) {
      if (err instanceof ValidationError) return { ok: false, code: "validation_error" };
      throw err;
    }

    const txn = this.db.transaction((): OperationalWriteResult<OperationalMemory> => {
      const memory = this.db.prepare("SELECT * FROM operational_memories WHERE id = ?").get(input.memoryId) as Record<string, unknown> | undefined;
      if (!memory) return { ok: false, code: "not_found" };

      if (memory.content_hash !== input.expectedContentHash) {
        return { ok: false, code: "conflict", current: { versionId: memory.current_version_id as string, contentHash: memory.content_hash as string } };
      }

      const scope = extractScope(input.scopeLevel, input.platform, input.host, input.workspace, input.repository, input.taskEnvironment);
      const status: MemoryStatus = "active";
      const evidence = input.evidence ?? [];
      const provenance = input.provenance ?? {};
      const hashInput = { content: input.content, status, scope, confidence: input.confidence, provenance, evidence };
      const contentHash = computeContentHash(hashInput);
      const versionId = randomUUID();
      const ts = now();

      this.db.prepare(`
        INSERT INTO operational_memory_versions
          (id, memory_id, previous_version_id, status, scope_level,
           platform, host, workspace, repository, task_environment,
           content, content_hash, confidence, provenance_json, evidence_json,
           mutation_reason, actor_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        versionId, input.memoryId, memory.current_version_id as string,
        status, scope.scopeLevel,
        scope.platform, scope.host, scope.workspace, scope.repository, scope.taskEnvironment,
        input.content, contentHash, input.confidence, ensureJson(provenance), ensureJson(evidence),
        input.mutationReason, input.actorId, ts,
      );

      const current = this.db.prepare("SELECT content_hash, current_version_id FROM operational_memories WHERE id = ?").get(input.memoryId) as { content_hash: string; current_version_id: string };
      if (current.content_hash !== input.expectedContentHash) {
        return { ok: false, code: "conflict", current: { versionId: current.current_version_id, contentHash: current.content_hash } };
      }

      this.db.prepare(`
        UPDATE operational_memories
        SET current_version_id = ?, content_hash = ?, status = ?,
            scope_level = ?, platform = ?, host = ?, workspace = ?, repository = ?, task_environment = ?,
            confidence = ?, provenance_json = ?, updated_at = ?
        WHERE id = ? AND content_hash = ?
      `).run(
        versionId, contentHash, status,
        scope.scopeLevel, scope.platform, scope.host, scope.workspace, scope.repository, scope.taskEnvironment,
        input.confidence, ensureJson(provenance), ts,
        input.memoryId, input.expectedContentHash,
      );

      return { ok: true, value: this.getMemory(input.memoryId)! };
    });

    return txn();
  }

  retire(input: RetireOperationalMemoryInput): OperationalWriteResult<OperationalMemory> {
    try {
      validateRetireInput(input);
    } catch (err) {
      if (err instanceof ValidationError) return { ok: false, code: "validation_error" };
      throw err;
    }

    const txn = this.db.transaction((): OperationalWriteResult<OperationalMemory> => {
      const memory = this.db.prepare("SELECT * FROM operational_memories WHERE id = ?").get(input.memoryId) as Record<string, unknown> | undefined;
      if (!memory) return { ok: false, code: "not_found" };

      if (memory.content_hash !== input.expectedContentHash) {
        return { ok: false, code: "conflict", current: { versionId: memory.current_version_id as string, contentHash: memory.content_hash as string } };
      }

      const status: MemoryStatus = "retired";
      const scope = extractScope(memory.scope_level as ScopeLevel, memory.platform as string | undefined, memory.host as string | undefined, memory.workspace as string | undefined, memory.repository as string | undefined, memory.task_environment as string | undefined);
      const confidence = memory.confidence as number;
      const provenance = jsonOrEmpty<ProvenanceMap>(memory.provenance_json as string | null, {});
      const evidence: EvidenceEntry[] = [];
      const hashInput = {
        content: "",
        status,
        scope,
        confidence,
        provenance,
        evidence,
      };
      const contentHash = computeContentHash(hashInput);
      const versionId = randomUUID();
      const ts = now();

      this.db.prepare(`
        INSERT INTO operational_memory_versions
          (id, memory_id, previous_version_id, status, scope_level,
           platform, host, workspace, repository, task_environment,
           content, content_hash, confidence, provenance_json, evidence_json,
           mutation_reason, actor_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        versionId, input.memoryId, memory.current_version_id as string,
        status, scope.scopeLevel,
        scope.platform, scope.host, scope.workspace, scope.repository, scope.taskEnvironment,
        "", contentHash, confidence, ensureJson(provenance), "[]",
        input.mutationReason, input.actorId, ts,
      );

      const current = this.db.prepare("SELECT content_hash, current_version_id FROM operational_memories WHERE id = ?").get(input.memoryId) as { content_hash: string; current_version_id: string };
      if (current.content_hash !== input.expectedContentHash) {
        return { ok: false, code: "conflict", current: { versionId: current.current_version_id, contentHash: current.content_hash } };
      }

      this.db.prepare(`
        UPDATE operational_memories
        SET current_version_id = ?, content_hash = ?, status = ?, updated_at = ?
        WHERE id = ? AND content_hash = ?
      `).run(
        versionId, contentHash, status, ts,
        input.memoryId, input.expectedContentHash,
      );

      return { ok: true, value: this.getMemory(input.memoryId)! };
    });

    return txn();
  }
}
