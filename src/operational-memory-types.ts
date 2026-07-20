/**
 * operational-memory-types.ts — Shared types, bounds, validators, and
 * canonical hash for the operational-memory domain (#1371).
 *
 * Reused by #1372 (scoped search and CLI/service methods).
 */

import { createHash } from "node:crypto";

// ── Identity & scope ──────────────────────────────────────────────────────

export type ScopeLevel = "global" | "platform" | "host" | "workspace" | "repository" | "task_environment";

export type DraftStatus = "draft" | "promoted" | "rejected";

export type MemoryStatus = "active" | "retired";

// ── Bounds ────────────────────────────────────────────────────────────────

export const ID_MAX = 128;
export const ACTOR_SOURCE_MAX = 256;
export const SCOPE_VALUE_MAX = 512;
export const LESSON_MAX = 4096;
export const PROBLEM_RECOMMENDATION_MAX = 4096;
export const CONTENT_MAX = 16384;
export const REASON_MAX = 2048;
export const EVIDENCE_JSON_MAX = 32768;
export const EVIDENCE_ENTRY_MAX = 32;
export const EVIDENCE_DEPTH_MAX = 4;
export const PROVENANCE_JSON_MAX = 16384;
export const PROVENANCE_KEYS_MAX = 64;
export const PROVENANCE_DEPTH_MAX = 4;

// ── Service bounds (#1372) ─────────────────────────────────────────────────

export const QUERY_MAX = 1024;
export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 100;
export const CURSOR_MAX = 2048;
export const PAGE_SERIALIZED_MAX = 262144;
export const RECALL_SCAN_CHUNK = 200;
export const RECALL_EXAMINE_MAX = 1000;

// ── Input types ───────────────────────────────────────────────────────────

export interface EvidenceEntry {
  source: string;
  detail: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface ProvenanceMap {
  [key: string]: string | number | boolean | null | ProvenanceMap | Array<string | number | boolean | null>;
}

export interface CreateDraftInput {
  lesson: string;
  problem?: string;
  recommendation?: string;
  evidence?: EvidenceEntry[];
  suggestedScopeLevel: ScopeLevel;
  suggestedPlatform?: string;
  suggestedHost?: string;
  suggestedWorkspace?: string;
  suggestedRepository?: string;
  suggestedTaskEnvironment?: string;
  confidence: number;
  sourceTaskId?: string;
  sourceSessionId?: string;
  sourceExecutor?: string;
  sourceHost?: string;
  provenance?: ProvenanceMap;
}

export interface PromoteDraftInput {
  draftId: string;
  actorId: string;
  mutationReason: string;
  /** Optional curation overrides applied before promotion */
  curate?: {
    lesson?: string;
    problem?: string;
    recommendation?: string;
    evidence?: EvidenceEntry[];
    scopeLevel?: ScopeLevel;
    platform?: string;
    host?: string;
    workspace?: string;
    repository?: string;
    taskEnvironment?: string;
    confidence?: number;
    provenance?: ProvenanceMap;
  };
}

export interface RejectDraftInput {
  draftId: string;
  rejectedBy: string;
  rejectionReason: string;
}

export interface ReviseOperationalMemoryInput {
  memoryId: string;
  expectedContentHash: string;
  content: string;
  scopeLevel: ScopeLevel;
  platform?: string | null;
  host?: string | null;
  workspace?: string | null;
  repository?: string | null;
  taskEnvironment?: string | null;
  confidence: number;
  provenance?: ProvenanceMap;
  evidence?: EvidenceEntry[];
  mutationReason: string;
  actorId: string;
}

export interface RetireOperationalMemoryInput {
  memoryId: string;
  expectedContentHash: string;
  mutationReason: string;
  actorId: string;
}

// ── Output types ──────────────────────────────────────────────────────────

export interface OperationalDraft {
  id: string;
  status: DraftStatus;
  lesson: string;
  problem: string | null;
  recommendation: string | null;
  evidence: EvidenceEntry[];
  suggestedScopeLevel: ScopeLevel;
  suggestedPlatform: string | null;
  suggestedHost: string | null;
  suggestedWorkspace: string | null;
  suggestedRepository: string | null;
  suggestedTaskEnvironment: string | null;
  confidence: number;
  sourceTaskId: string | null;
  sourceSessionId: string | null;
  sourceExecutor: string | null;
  sourceHost: string | null;
  provenance: ProvenanceMap;
  createdAt: number;
  updatedAt: number;
  promotedMemoryId: string | null;
  rejectedBy: string | null;
  rejectedAt: number | null;
  rejectionReason: string | null;
}

export interface OperationalMemory {
  id: string;
  status: MemoryStatus;
  scopeLevel: ScopeLevel;
  platform: string | null;
  host: string | null;
  workspace: string | null;
  repository: string | null;
  taskEnvironment: string | null;
  contentHash: string;
  currentVersionId: string;
  confidence: number;
  provenance: ProvenanceMap;
  createdAt: number;
  updatedAt: number;
}

export interface OperationalMemoryVersion {
  id: string;
  memoryId: string;
  previousVersionId: string | null;
  status: MemoryStatus;
  scopeLevel: ScopeLevel;
  platform: string | null;
  host: string | null;
  workspace: string | null;
  repository: string | null;
  taskEnvironment: string | null;
  content: string;
  contentHash: string;
  confidence: number;
  provenance: ProvenanceMap;
  evidence: EvidenceEntry[];
  mutationReason: string;
  actorId: string;
  createdAt: number;
}

export type OperationalWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "not_found" | "conflict" | "validation_error"; current?: { versionId: string; contentHash: string } };

// ── Projection & recall (#1372) ───────────────────────────────────────────

export interface OperationalMemoryProjection {
  id: string;
  status: MemoryStatus;
  scopeLevel: ScopeLevel;
  platform: string | null;
  host: string | null;
  workspace: string | null;
  repository: string | null;
  taskEnvironment: string | null;
  contentHash: string;
  currentVersionId: string;
  confidence: number;
  provenance: ProvenanceMap;
  lesson: string;
  problem: string | null;
  recommendation: string | null;
  evidence: EvidenceEntry[];
  createdAt: number;
  updatedAt: number;
}

export type ScopeRank = "task_environment" | "repository" | "workspace" | "host" | "platform" | "global";

export const SCOPE_RANK_ORDER: ScopeRank[] = ["task_environment", "repository", "workspace", "host", "platform", "global"];

export interface OperationalRecallHit {
  memoryId: string;
  contentHash: string;
  versionId: string;
  scopeLevel: ScopeLevel;
  matchedScopeLevel: ScopeRank;
  confidence: number;
  lesson: string;
  problem: string | null;
  recommendation: string | null;
  evidence: EvidenceEntry[];
  provenance: ProvenanceMap;
  createdAt: number;
  updatedAt: number;
}

// ── Pagination (#1372) ────────────────────────────────────────────────────

export interface PageRequest {
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

// ── Service input types (#1372) ───────────────────────────────────────────

export interface SubmitOperationalDraftInput {
  lesson: string;
  problem?: string;
  recommendation?: string;
  evidence?: EvidenceEntry[];
  scopeLevel: ScopeLevel;
  platform?: string;
  host?: string;
  workspace?: string;
  repository?: string;
  taskEnvironment?: string;
  confidence: number;
  sourceTaskId?: string;
  sourceSessionId?: string;
  sourceExecutor?: string;
  sourceHost?: string;
  provenance?: ProvenanceMap;
}

export interface DraftListQuery {
  status?: DraftStatus;
  limit?: number;
  cursor?: string;
}

export interface OperationalRecallQuery {
  query?: string;
  platform?: string;
  host?: string;
  workspace?: string;
  repository?: string;
  taskEnvironment?: string;
  limit?: number;
  cursor?: string;
}

// ── Service result type (#1372) ───────────────────────────────────────────

export type OperationalResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: "validation_error" | "not_found" | "conflict";
      message: string;
      current?:
        | { kind: "memory"; memoryId: string; versionId: string; contentHash: string }
        | { kind: "draft"; draftId: string; status: "promoted" | "rejected"; promotedMemoryId?: string };
    };

// ── Cursor payloads (#1372) ──────────────────────────────────────────────

export interface DraftListCursor {
  createdAt: number;
  id: string;
  queryFingerprint: string;
}

export interface MemoryVersionCursor {
  createdAt: number;
  id: string;
  memoryId: string;
  queryFingerprint: string;
}

export interface RecallCursor {
  updatedAt: number;
  id: string;
  scopeRank: number;
  queryFingerprint: string;
}

// ── Runtime context (#1372) ──────────────────────────────────────────────

export interface OperationalScope {
  platform?: string;
  host?: string;
  workspace?: string;
  repository?: string;
  taskEnvironment?: string;
}

// ── Scope helpers ─────────────────────────────────────────────────────────

export interface NormalizedScope {
  scopeLevel: ScopeLevel;
  platform: string | null;
  host: string | null;
  workspace: string | null;
  repository: string | null;
  taskEnvironment: string | null;
}

export function normalizeScope(level: ScopeLevel, value?: string | null): NormalizedScope {
  const base: NormalizedScope = { scopeLevel: level, platform: null, host: null, workspace: null, repository: null, taskEnvironment: null };
  if (level === "global") {
    if (value != null) throw new ValidationError("global scope must not have a scope value");
    return base;
  }
  if (level !== "platform" && level !== "host" && level !== "workspace" && level !== "repository" && level !== "task_environment") {
    throw new ValidationError(`invalid scope level: ${String(level)}`);
  }
  if (value == null) throw new ValidationError(`scope value for ${level} is required`);
  if (typeof value !== "string") throw new ValidationError(`scope value for ${level} must be text`);

  const canonical = value.trim().toLowerCase();
  if (canonical.length === 0) throw new ValidationError(`scope value for ${level} is empty after trimming`);
  if (Buffer.byteLength(canonical, "utf-8") > SCOPE_VALUE_MAX) throw new ValidationError(`scope value for ${level} exceeds ${SCOPE_VALUE_MAX} bytes`);
  switch (level) {
    case "platform": base.platform = canonical; break;
    case "host": base.host = canonical; break;
    case "workspace": base.workspace = canonical; break;
    case "repository": base.repository = canonical; break;
    case "task_environment": base.taskEnvironment = canonical; break;
  }
  return base;
}

export function getScopeValue(scope: NormalizedScope): string | null {
  switch (scope.scopeLevel) {
    case "global": return null;
    case "platform": return scope.platform;
    case "host": return scope.host;
    case "workspace": return scope.workspace;
    case "repository": return scope.repository;
    case "task_environment": return scope.taskEnvironment;
  }
}

// ── Hash ──────────────────────────────────────────────────────────────────

export interface HashInput {
  content: string;
  status: MemoryStatus;
  scope: NormalizedScope;
  confidence: number;
  provenance: ProvenanceMap;
  evidence: EvidenceEntry[];
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Non-finite number in hash input: ${value}`);
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return "{" + keys.map(k => `${canonicalJson(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",") + "}";
  }
  throw new Error(`Unsupported value type in hash input: ${typeof value}`);
}

export function computeContentHash(input: HashInput): string {
  const prefix = "operational-state-v1\0";
  const scopeVal = getScopeValue(input.scope);
  const state = {
    content: input.content,
    status: input.status,
    scopeLevel: input.scope.scopeLevel,
    platform: input.scope.platform,
    host: input.scope.host,
    workspace: input.scope.workspace,
    repository: input.scope.repository,
    taskEnvironment: input.scope.taskEnvironment,
    confidence: input.confidence,
    provenance: input.provenance,
    evidence: input.evidence,
  };
  const json = canonicalJson(state);
  return createHash("sha256").update(prefix, "utf-8").update(json, "utf-8").digest("hex");
}

// ── Validation ────────────────────────────────────────────────────────────

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function checkLength(value: string | undefined | null, max: number, label: string): void {
  if (value != null && Buffer.byteLength(value, "utf-8") > max) {
    throw new ValidationError(`${label} exceeds ${max} bytes`);
  }
}

function checkJsonDepth(value: unknown, maxDepth: number, path: string): void {
  if (typeof value !== "object" || value === null) return;
  if (maxDepth <= 0) throw new ValidationError(`JSON depth exceeded at ${path}`);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) checkJsonDepth(value[i], maxDepth - 1, `${path}[${i}]`);
  } else {
    for (const k of Object.keys(value as Record<string, unknown>)) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
      checkJsonDepth((value as Record<string, unknown>)[k], maxDepth - 1, `${path}.${k}`);
    }
  }
}

function checkPlainObject(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ValidationError(`${label} must be a plain object`);
  }
}

function checkJsonObject(value: unknown, maxBytes: number, maxDepth: number, label: string): void {
  if (value == null) return;
  checkPlainObject(value, label);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf-8") > maxBytes) throw new ValidationError(`${label} exceeds ${maxBytes} bytes`);
  checkJsonDepth(value, maxDepth, label);
}

function checkEvidenceArray(value: unknown, label: string): void {
  if (value == null) return;
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array`);
  if (value.length > EVIDENCE_ENTRY_MAX) throw new ValidationError(`${label} exceeds ${EVIDENCE_ENTRY_MAX} entries`);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf-8") > EVIDENCE_JSON_MAX) throw new ValidationError(`${label} exceeds ${EVIDENCE_JSON_MAX} bytes`);
  for (const entry of value) {
    checkPlainObject(entry, `${label} entry`);
    checkJsonDepth(entry, EVIDENCE_DEPTH_MAX, label);
  }
}

function validateScopeConsistency(level: ScopeLevel, platform?: string | null, host?: string | null, workspace?: string | null, repository?: string | null, taskEnvironment?: string | null, prefix = ""): void {
  const values = { platform, host, workspace, repository, taskEnvironment };
  const setValues = Object.entries(values).filter(([, v]) => v != null).map(([k]) => k);
  if (level === "global") {
    if (setValues.length > 0) throw new ValidationError(`${prefix}scope_level=global must not have scope values (got: ${setValues.join(", ")})`);
  } else {
    if (setValues.length !== 1) throw new ValidationError(`${prefix}scope_level=${level} requires exactly one scope value (got: ${setValues.length}, keys: ${setValues.join(", ")})`);
    if (!setValues.includes(level)) throw new ValidationError(`${prefix}scope_level=${level} requires '${level}' value, but got: ${setValues.join(", ") || "none"}`);
  }
}

export function validateCreateDraftInput(input: CreateDraftInput): void {
  checkLength(input.lesson, LESSON_MAX, "lesson");
  checkLength(input.problem, PROBLEM_RECOMMENDATION_MAX, "problem");
  checkLength(input.recommendation, PROBLEM_RECOMMENDATION_MAX, "recommendation");
  checkLength(input.suggestedPlatform, SCOPE_VALUE_MAX, "suggestedPlatform");
  checkLength(input.suggestedHost, SCOPE_VALUE_MAX, "suggestedHost");
  checkLength(input.suggestedWorkspace, SCOPE_VALUE_MAX, "suggestedWorkspace");
  checkLength(input.suggestedRepository, SCOPE_VALUE_MAX, "suggestedRepository");
  checkLength(input.suggestedTaskEnvironment, SCOPE_VALUE_MAX, "suggestedTaskEnvironment");
  checkLength(input.sourceTaskId, ACTOR_SOURCE_MAX, "sourceTaskId");
  checkLength(input.sourceSessionId, ACTOR_SOURCE_MAX, "sourceSessionId");
  checkLength(input.sourceExecutor, ACTOR_SOURCE_MAX, "sourceExecutor");
  checkLength(input.sourceHost, ACTOR_SOURCE_MAX, "sourceHost");
  checkEvidenceArray(input.evidence, "evidence");
  checkJsonObject(input.provenance, PROVENANCE_JSON_MAX, PROVENANCE_DEPTH_MAX, "provenance");
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 100) throw new ValidationError("confidence must be 0-100");
  validateScopeConsistency(input.suggestedScopeLevel, input.suggestedPlatform, input.suggestedHost, input.suggestedWorkspace, input.suggestedRepository, input.suggestedTaskEnvironment, "suggested");
}

export function validatePromoteDraftInput(input: PromoteDraftInput): void {
  checkLength(input.draftId, ID_MAX, "draftId");
  checkLength(input.actorId, ACTOR_SOURCE_MAX, "actorId");
  checkLength(input.mutationReason, REASON_MAX, "mutationReason");
  if (input.curate) {
    checkLength(input.curate.lesson, LESSON_MAX, "curate.lesson");
    checkLength(input.curate.problem, PROBLEM_RECOMMENDATION_MAX, "curate.problem");
    checkLength(input.curate.recommendation, PROBLEM_RECOMMENDATION_MAX, "curate.recommendation");
    checkLength(input.curate.platform, SCOPE_VALUE_MAX, "curate.platform");
    checkLength(input.curate.host, SCOPE_VALUE_MAX, "curate.host");
    checkLength(input.curate.workspace, SCOPE_VALUE_MAX, "curate.workspace");
    checkLength(input.curate.repository, SCOPE_VALUE_MAX, "curate.repository");
    checkLength(input.curate.taskEnvironment, SCOPE_VALUE_MAX, "curate.taskEnvironment");
    checkEvidenceArray(input.curate.evidence, "curate.evidence");
    checkJsonObject(input.curate.provenance, PROVENANCE_JSON_MAX, PROVENANCE_DEPTH_MAX, "curate.provenance");
    if (input.curate.confidence !== undefined && (!Number.isFinite(input.curate.confidence) || input.curate.confidence < 0 || input.curate.confidence > 100)) {
      throw new ValidationError("curate.confidence must be 0-100");
    }
    if (input.curate.scopeLevel) {
      validateScopeConsistency(input.curate.scopeLevel, input.curate.platform, input.curate.host, input.curate.workspace, input.curate.repository, input.curate.taskEnvironment, "curate.");
    } else if ([input.curate.platform, input.curate.host, input.curate.workspace, input.curate.repository, input.curate.taskEnvironment].some(v => v != null)) {
      throw new ValidationError("curated scope values require curate.scopeLevel");
    }
  }
}

export function validateRejectDraftInput(input: RejectDraftInput): void {
  checkLength(input.draftId, ID_MAX, "draftId");
  checkLength(input.rejectedBy, ACTOR_SOURCE_MAX, "rejectedBy");
  checkLength(input.rejectionReason, REASON_MAX, "rejectionReason");
}

export function validateReviseInput(input: ReviseOperationalMemoryInput): void {
  checkLength(input.memoryId, ID_MAX, "memoryId");
  checkLength(input.content, CONTENT_MAX, "content");
  checkLength(input.actorId, ACTOR_SOURCE_MAX, "actorId");
  checkLength(input.mutationReason, REASON_MAX, "mutationReason");
  checkLength(input.platform, SCOPE_VALUE_MAX, "platform");
  checkLength(input.host, SCOPE_VALUE_MAX, "host");
  checkLength(input.workspace, SCOPE_VALUE_MAX, "workspace");
  checkLength(input.repository, SCOPE_VALUE_MAX, "repository");
  checkLength(input.taskEnvironment, SCOPE_VALUE_MAX, "taskEnvironment");
  checkEvidenceArray(input.evidence, "evidence");
  checkJsonObject(input.provenance, PROVENANCE_JSON_MAX, PROVENANCE_DEPTH_MAX, "provenance");
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 100) throw new ValidationError("confidence must be 0-100");
  validateScopeConsistency(input.scopeLevel, input.platform, input.host, input.workspace, input.repository, input.taskEnvironment);
}

export function validateRetireInput(input: RetireOperationalMemoryInput): void {
  checkLength(input.memoryId, ID_MAX, "memoryId");
  checkLength(input.actorId, ACTOR_SOURCE_MAX, "actorId");
  checkLength(input.mutationReason, REASON_MAX, "mutationReason");
}
