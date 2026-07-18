import {
  normalizeScope,
  ValidationError,
  SCOPE_RANK_ORDER,
  QUERY_MAX,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  PAGE_SERIALIZED_MAX,
  RECALL_SCAN_CHUNK,
  RECALL_EXAMINE_MAX,
  ID_MAX,
  type ScopeLevel,
  type OperationalDraft,
  type OperationalMemory,
  type OperationalMemoryVersion,
  type OperationalMemoryProjection,
  type OperationalRecallHit,
  type OperationalWriteResult,
  type OperationalResult,
  type Page,
  type PageRequest,
  type DraftListQuery,
  type OperationalRecallQuery,
  type SubmitOperationalDraftInput,
  type PromoteDraftInput,
  type RejectDraftInput,
  type ReviseOperationalMemoryInput,
  type RetireOperationalMemoryInput,
  type EvidenceEntry,
  type ProvenanceMap,
  type DraftListCursor,
  type MemoryVersionCursor,
  type RecallCursor,
  type OperationalScope,
} from "./operational-memory-types.js";
import type { OperationalMemoryStore } from "./operational-memory-store.js";

function padPageLimit(limit?: number): number {
  const n = limit ?? PAGE_LIMIT_DEFAULT;
  if (n < 1) return PAGE_LIMIT_DEFAULT;
  if (n > PAGE_LIMIT_MAX) return PAGE_LIMIT_MAX;
  return n;
}

function ok<T>(value: T): OperationalResult<T> {
  return { ok: true, value };
}

function validationErr<T>(message: string): OperationalResult<T> {
  return { ok: false, code: "validation_error", message };
}

function notFoundErr<T>(message: string): OperationalResult<T> {
  return { ok: false, code: "not_found", message };
}

function conflictErr<T>(message: string, current: { kind: "memory"; memoryId: string; versionId: string; contentHash: string } | { kind: "draft"; draftId: string; status: "promoted" | "rejected"; promotedMemoryId?: string }): OperationalResult<T> {
  return { ok: false, code: "conflict", message, current };
}

function cursorFingerprint(input: { status?: string; query?: string; platform?: string; host?: string; workspace?: string; repository?: string; taskEnvironment?: string }): string {
  const parts: string[] = [];
  if (input.status) parts.push(`s=${input.status}`);
  if (input.query) parts.push(`q=${input.query}`);
  if (input.platform) parts.push(`pl=${input.platform}`);
  if (input.host) parts.push(`h=${input.host}`);
  if (input.workspace) parts.push(`w=${input.workspace}`);
  if (input.repository) parts.push(`r=${input.repository}`);
  if (input.taskEnvironment) parts.push(`te=${input.taskEnvironment}`);
  return parts.join("&") || "default";
}

function parseCursor<T>(cursor: string | undefined): [T | null, string | null] {
  if (!cursor) return [null, null];
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf-8");
    const parsed = JSON.parse(raw) as T & { queryFingerprint?: string };
    return [parsed as T, (parsed as Record<string, unknown>).queryFingerprint as string ?? null];
  } catch {
    return [null, null];
  }
}

function encodeCursor(data: unknown): string {
  return Buffer.from(JSON.stringify(data), "utf-8").toString("base64url");
}

function normalizeQuery(raw: string | undefined): string | null {
  if (!raw || raw.trim().length === 0) return null;
  const normalized = raw.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
  if (Buffer.byteLength(normalized, "utf-8") > QUERY_MAX) return null;
  return normalized;
}

function queryTokens(normalized: string): string[] {
  return normalized.split(" ").filter(t => t.length > 0);
}

function matchesQuery(content: string, tokens: string[]): boolean {
  const normalized = content.normalize("NFKC").toLowerCase();
  return tokens.every(t => normalized.includes(t));
}

function buildProjection(memory: OperationalMemory, version: OperationalMemoryVersion): OperationalMemoryProjection {
  return {
    id: memory.id,
    status: memory.status,
    scopeLevel: memory.scopeLevel,
    platform: memory.platform,
    host: memory.host,
    workspace: memory.workspace,
    repository: memory.repository,
    taskEnvironment: memory.taskEnvironment,
    contentHash: memory.contentHash,
    currentVersionId: memory.currentVersionId,
    confidence: memory.confidence,
    provenance: memory.provenance,
    lesson: version.content,
    problem: null,
    recommendation: null,
    evidence: version.evidence,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

function checkScopeCanonical(scope: { scopeLevel: ScopeLevel; platform: string | null; host: string | null; workspace: string | null; repository: string | null; taskEnvironment: string | null }): boolean {
  if (scope.scopeLevel === "global") {
    return !scope.platform && !scope.host && !scope.workspace && !scope.repository && !scope.taskEnvironment;
  }
  const val = scope[scope.scopeLevel as keyof typeof scope] as string | null;
  if (!val) return false;
  const trimmed = val.trim();
  if (trimmed.length === 0) return false;
  const canon = trimmed.toLowerCase();
  return val === canon;
}

function normalizeScopeInput(dimension: string | undefined): string | null | undefined {
  if (dimension === undefined) return undefined;
  if (dimension === null) return null;
  const trimmed = dimension.trim();
  if (trimmed.length === 0) return null;
  if (Buffer.byteLength(trimmed, "utf-8") > 512) return null;
  return trimmed.toLowerCase();
}

export class OperationalMemoryService {
  private store: OperationalMemoryStore;

  constructor(store: OperationalMemoryStore) {
    this.store = store;
  }

  async submitDraft(input: SubmitOperationalDraftInput): Promise<OperationalResult<OperationalDraft>> {
    try {
      const ns = normalizeScope(input.scopeLevel, input.platform ?? input.host ?? input.workspace ?? input.repository ?? input.taskEnvironment);
      const storeInput: import("./operational-memory-types.js").CreateDraftInput = {
        lesson: input.lesson,
        problem: input.problem,
        recommendation: input.recommendation,
        evidence: input.evidence,
        suggestedScopeLevel: ns.scopeLevel,
        suggestedPlatform: ns.platform ?? undefined,
        suggestedHost: ns.host ?? undefined,
        suggestedWorkspace: ns.workspace ?? undefined,
        suggestedRepository: ns.repository ?? undefined,
        suggestedTaskEnvironment: ns.taskEnvironment ?? undefined,
        confidence: input.confidence,
        sourceTaskId: input.sourceTaskId,
        sourceSessionId: input.sourceSessionId,
        sourceExecutor: input.sourceExecutor,
        sourceHost: input.sourceHost,
        provenance: input.provenance,
      };
      const result = this.store.createDraft(storeInput);
      return this.mapWriteResult(result);
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  async listDrafts(query: DraftListQuery): Promise<OperationalResult<Page<OperationalDraft>>> {
    try {
      const limit = padPageLimit(query.limit);
      const fp = cursorFingerprint({ status: query.status });

      let cursorCreatedAt: number | undefined;
      let cursorId: string | undefined;
      let parsedFp: string | null = null;
      if (query.cursor) {
        const [parsed, fpParsed] = parseCursor<DraftListCursor>(query.cursor);
        if (!parsed || fpParsed !== fp) return validationErr("Invalid or mismatched cursor");
        cursorCreatedAt = parsed.createdAt;
        cursorId = parsed.id;
        parsedFp = fpParsed;
      }

      const drafts = this.store.listDraftsPaginated(query.status ?? null, limit, cursorCreatedAt, cursorId);
      const hasMore = drafts.length > limit;
      if (hasMore) drafts.pop();

      let nextCursor: string | undefined;
      if (hasMore && drafts.length > 0) {
        const last = drafts[drafts.length - 1]!;
        nextCursor = encodeCursor({ createdAt: last.createdAt, id: last.id, queryFingerprint: fp } satisfies DraftListCursor);
      }

      return ok({ items: drafts, nextCursor });
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  async getMemory(memoryId: string): Promise<OperationalResult<OperationalMemoryProjection>> {
    try {
      if (Buffer.byteLength(memoryId, "utf-8") > ID_MAX) return validationErr("memoryId too long");
      const memory = this.store.getMemory(memoryId);
      if (!memory) return notFoundErr(`Memory not found: ${memoryId}`);
      const version = this.store.getVersion(memory.currentVersionId);
      if (!version) return validationErr(`Memory ${memoryId} has missing current version`);
      const scope = memory as unknown as { scopeLevel: ScopeLevel; platform: string | null; host: string | null; workspace: string | null; repository: string | null; taskEnvironment: string | null };
      const canonical = checkScopeCanonical(scope);
      if (!canonical) return validationErr(`Memory ${memoryId} has non-canonical stored scope`);
      return ok(buildProjection(memory, version));
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  async getHistory(memoryId: string, page: PageRequest): Promise<OperationalResult<Page<OperationalMemoryVersion>>> {
    try {
      if (Buffer.byteLength(memoryId, "utf-8") > ID_MAX) return validationErr("memoryId too long");
      const memory = this.store.getMemory(memoryId);
      if (!memory) return notFoundErr(`Memory not found: ${memoryId}`);

      const limit = padPageLimit(page.limit);
      const fp = cursorFingerprint({});

      let cursorCreatedAt: number | undefined;
      let cursorId: string | undefined;
      if (page.cursor) {
        const [parsed, fpParsed] = parseCursor<MemoryVersionCursor>(page.cursor);
        if (!parsed || fpParsed !== fp || parsed.memoryId !== memoryId) return validationErr("Invalid or mismatched cursor");
        cursorCreatedAt = parsed.createdAt;
        cursorId = parsed.id;
      }

      const versions = this.store.getVersionLineagePaginated(memoryId, limit, cursorCreatedAt, cursorId);
      const hasMore = versions.length > limit;
      if (hasMore) versions.pop();

      let nextCursor: string | undefined;
      if (hasMore && versions.length > 0) {
        const last = versions[versions.length - 1]!;
        nextCursor = encodeCursor({ createdAt: last.createdAt, id: last.id, memoryId, queryFingerprint: fp } satisfies MemoryVersionCursor);
      }

      return ok({ items: versions, nextCursor });
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  async promoteDraft(input: PromoteDraftInput): Promise<OperationalResult<OperationalMemoryProjection>> {
    try {
      const result = this.store.promoteDraft(input);
      return this.mapPromoteResult(result, input.draftId);
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  async rejectDraft(input: RejectDraftInput): Promise<OperationalResult<OperationalDraft>> {
    try {
      const result = this.store.rejectDraft(input);
      return this.mapRejectResult(result, input.draftId);
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  async revise(input: ReviseOperationalMemoryInput): Promise<OperationalResult<OperationalMemoryProjection>> {
    try {
      const result = this.store.revise(input);
      return this.mapMemoryMutationResult(result);
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  async retire(input: RetireOperationalMemoryInput): Promise<OperationalResult<OperationalMemoryProjection>> {
    try {
      const result = this.store.retire(input);
      return this.mapMemoryMutationResult(result);
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  async recall(query: OperationalRecallQuery): Promise<OperationalResult<Page<OperationalRecallHit>>> {
    try {
      const limit = padPageLimit(query.limit);
      const fp = cursorFingerprint({ query: query.query, platform: query.platform, host: query.host, workspace: query.workspace, repository: query.repository, taskEnvironment: query.taskEnvironment });

      const tokens = query.query ? queryTokens(normalizeQuery(query.query) ?? "") : [];
      if (query.query && tokens.length === 0) return validationErr("Query too long or empty after normalization");

      let cursorUpdatedAt: number | undefined;
      let cursorId: string | undefined;
      let cursorScopeRank: number | undefined;
      if (query.cursor) {
        const [parsed, fpParsed] = parseCursor<RecallCursor>(query.cursor);
        if (!parsed || fpParsed !== fp) return validationErr("Invalid or mismatched cursor");
        cursorUpdatedAt = parsed.updatedAt;
        cursorId = parsed.id;
        cursorScopeRank = parsed.scopeRank;
      }

      const normalizedScope: OperationalScope = {};
      if (query.platform !== undefined) normalizedScope.platform = normalizeScopeInput(query.platform) ?? undefined;
      if (query.host !== undefined) normalizedScope.host = normalizeScopeInput(query.host) ?? undefined;
      if (query.workspace !== undefined) normalizedScope.workspace = normalizeScopeInput(query.workspace) ?? undefined;
      if (query.repository !== undefined) normalizedScope.repository = normalizeScopeInput(query.repository) ?? undefined;
      if (query.taskEnvironment !== undefined) normalizedScope.taskEnvironment = normalizeScopeInput(query.taskEnvironment) ?? undefined;

      const activeRanks = SCOPE_RANK_ORDER.filter(r => {
        if (r === "global") return true;
        const val = normalizedScope[r as keyof OperationalScope];
        return val != null && val !== "";
      });

      const scopeBindings: Record<string, string | null> = {};
      for (const r of activeRanks) {
        if (r === "global") continue;
        scopeBindings[r] = normalizedScope[r as keyof OperationalScope] ?? null;
      }

      const hits: OperationalRecallHit[] = [];
      const serializedHits: string[] = [];
      let serializedBytes = 0;
      let examined = 0;
      let cursor: string | undefined;

      while (hits.length < limit) {
        const rows = this.store.recallMemories(
          scopeBindings,
          activeRanks,
          RECALL_SCAN_CHUNK,
          cursorUpdatedAt,
          cursorId,
          cursorScopeRank,
        );

        if (rows.length === 0) break;

        for (const row of rows) {
          examined++;
          if (examined > RECALL_EXAMINE_MAX) {
            cursor = encodeCursor({
              updatedAt: row.updated_at as number,
              id: row.memory_id as string,
              scopeRank: row.scope_rank as number,
              queryFingerprint: fp,
            } satisfies RecallCursor);
            break;
          }

          if (tokens.length > 0) {
            const content = (row.lesson as string) ?? "";
            if (!matchesQuery(content, tokens)) continue;
          }

          const hit: OperationalRecallHit = {
            memoryId: row.memory_id as string,
            contentHash: row.content_hash as string,
            versionId: row.current_version_id as string,
            scopeLevel: row.scope_level as ScopeLevel,
            matchedScopeLevel: SCOPE_RANK_ORDER[row.scope_rank as number] as OperationalRecallHit["matchedScopeLevel"],
            confidence: row.confidence as number,
            lesson: (row.lesson as string) ?? "",
            problem: null,
            recommendation: null,
            evidence: this.parseEvidence(row.evidence_json as string | null),
            provenance: this.parseProvenance(row.provenance_json as string | null),
            createdAt: row.created_at as number,
            updatedAt: row.updated_at as number,
          };

          const hitJson = JSON.stringify(hit);
          if (serializedBytes + Buffer.byteLength(hitJson, "utf-8") > PAGE_SERIALIZED_MAX) {
            if (hits.length === 0) return validationErr("Single recall hit exceeds serialized page limit");
            cursorUpdatedAt = row.updated_at as number;
            cursorId = row.memory_id as string;
            cursorScopeRank = row.scope_rank as number;
            break;
          }

          hits.push(hit);
          serializedHits.push(hitJson);
          serializedBytes += Buffer.byteLength(hitJson, "utf-8");
          cursorUpdatedAt = row.updated_at as number;
          cursorId = row.memory_id as string;
          cursorScopeRank = row.scope_rank as number;

          if (hits.length >= limit) break;
        }

        if (cursor || examined >= RECALL_EXAMINE_MAX || hits.length >= limit) break;
      }

      if (cursor || (examined > 0 && cursorUpdatedAt != null && cursorId != null && cursorScopeRank != null && (examined >= RECALL_EXAMINE_MAX || hits.length > 0))) {
        cursor = encodeCursor({
          updatedAt: cursorUpdatedAt!,
          id: cursorId!,
          scopeRank: cursorScopeRank!,
          queryFingerprint: fp,
        } satisfies RecallCursor);
      }

      return ok({ items: hits, nextCursor: cursor });
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private parseEvidence(raw: string | null): EvidenceEntry[] {
    if (!raw) return [];
    try { return JSON.parse(raw) as EvidenceEntry[]; } catch { return []; }
  }

  private parseProvenance(raw: string | null): ProvenanceMap {
    if (!raw) return {};
    try { return JSON.parse(raw) as ProvenanceMap; } catch { return {}; }
  }

  private mapWriteResult<T>(result: OperationalWriteResult<T>): OperationalResult<T> {
    if (result.ok) return ok(result.value);
    if (result.code === "validation_error") return validationErr("Validation failed");
    if (result.code === "not_found") return notFoundErr("Not found");
    return conflictErr("Conflict", { kind: "memory", memoryId: "", versionId: result.current?.versionId ?? "", contentHash: result.current?.contentHash ?? "" });
  }

  private mapPromoteResult(result: OperationalWriteResult<OperationalMemory>, draftId: string): OperationalResult<OperationalMemoryProjection> {
    if (result.ok) {
      const version = this.store.getVersion(result.value.currentVersionId);
      if (!version) return validationErr("Promoted memory has missing current version");
      return ok(buildProjection(result.value, version));
    }
    if (result.code === "validation_error") return validationErr("Validation failed");
    if (result.code === "not_found") return notFoundErr(`Draft not found: ${draftId}`);
    if (result.code === "conflict") {
      const draft = this.store.getDraft(draftId);
      if (draft && draft.status !== "draft") {
        return conflictErr(`Draft is ${draft.status}`, {
          kind: "draft",
          draftId: draft.id,
          status: draft.status as "promoted" | "rejected",
          promotedMemoryId: draft.promotedMemoryId ?? undefined,
        });
      }
      return conflictErr("Conflict", { kind: "memory", memoryId: "", versionId: "", contentHash: "" });
    }
    return validationErr("Unknown error");
  }

  private mapRejectResult(result: OperationalWriteResult<OperationalDraft>, draftId: string): OperationalResult<OperationalDraft> {
    if (result.ok) return ok(result.value);
    if (result.code === "validation_error") return validationErr("Validation failed");
    if (result.code === "not_found") return notFoundErr(`Draft not found: ${draftId}`);
    if (result.code === "conflict") {
      const draft = this.store.getDraft(draftId);
      if (draft && draft.status !== "draft") {
        return conflictErr(`Draft is ${draft.status}`, {
          kind: "draft",
          draftId: draft.id,
          status: draft.status as "promoted" | "rejected",
          promotedMemoryId: draft.promotedMemoryId ?? undefined,
        });
      }
      return conflictErr("Conflict", { kind: "memory", memoryId: "", versionId: "", contentHash: "" });
    }
    return validationErr("Unknown error");
  }

  private mapMemoryMutationResult(result: OperationalWriteResult<OperationalMemory>): OperationalResult<OperationalMemoryProjection> {
    if (result.ok) {
      const version = this.store.getVersion(result.value.currentVersionId);
      if (!version) return validationErr("Memory has missing current version");
      return ok(buildProjection(result.value, version));
    }
    if (result.code === "validation_error") return validationErr("Validation failed");
    if (result.code === "not_found") return notFoundErr("Memory not found");
    if (result.code === "conflict" && result.current) {
      return conflictErr("Stale content hash", {
        kind: "memory",
        memoryId: "",
        versionId: result.current.versionId,
        contentHash: result.current.contentHash,
      });
    }
    return conflictErr("Conflict", { kind: "memory", memoryId: "", versionId: "", contentHash: "" });
  }
}
