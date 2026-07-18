import {
  normalizeScope,
  computeContentHash,
  ValidationError,
  SCOPE_RANK_ORDER,
  QUERY_MAX,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  PAGE_SERIALIZED_MAX,
  CURSOR_MAX,
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

function pageLimit(limit?: number): number | null {
  const n = limit ?? PAGE_LIMIT_DEFAULT;
  if (!Number.isInteger(n) || n < 1 || n > PAGE_LIMIT_MAX) return null;
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
  if (Buffer.byteLength(cursor, "utf-8") > CURSOR_MAX) return [null, null];
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [null, null];
    const fingerprint = (parsed as Record<string, unknown>).queryFingerprint;
    if (typeof fingerprint !== "string" || fingerprint.length === 0) return [null, null];
    return [parsed as T, fingerprint];
  } catch {
    return [null, null];
  }
}

function encodeCursor(data: unknown): string {
  const encoded = Buffer.from(JSON.stringify(data), "utf-8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf-8") > CURSOR_MAX) throw new ValidationError("cursor exceeds maximum size");
  return encoded;
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

function scopeValue(input: { platform?: string | null; host?: string | null; workspace?: string | null; repository?: string | null; taskEnvironment?: string | null }, level: ScopeLevel): string | undefined {
  switch (level) {
    case "global": return undefined;
    case "platform": return input.platform ?? undefined;
    case "host": return input.host ?? undefined;
    case "workspace": return input.workspace ?? undefined;
    case "repository": return input.repository ?? undefined;
    case "task_environment": return input.taskEnvironment ?? undefined;
  }
}

function normalizeRuntimeScope(input: OperationalScope): OperationalScope {
  const result: OperationalScope = {};
  const dimensions: Array<[ScopeLevel, keyof OperationalScope]> = [
    ["platform", "platform"],
    ["host", "host"],
    ["workspace", "workspace"],
    ["repository", "repository"],
    ["task_environment", "taskEnvironment"],
  ];
  for (const [level, key] of dimensions) {
    const value = input[key];
    if (value !== undefined) {
      const normalized = normalizeScope(level, value);
      result[key] = normalized[key] ?? undefined;
    }
  }
  return result;
}

function normalizeMutationScope(input: ReviseOperationalMemoryInput): ReviseOperationalMemoryInput {
  const dimensions = {
    platform: input.platform,
    host: input.host,
    workspace: input.workspace,
    repository: input.repository,
    taskEnvironment: input.taskEnvironment,
  };
  const selected = scopeValue(dimensions, input.scopeLevel);
  const selectedKey = input.scopeLevel === "task_environment" ? "taskEnvironment" : input.scopeLevel;
  const providedKeys = Object.entries(dimensions).filter(([, value]) => value != null).map(([key]) => key);
  if (input.scopeLevel === "global" && providedKeys.length !== 0) throw new ValidationError("global scope must not have scope values");
  if (input.scopeLevel !== "global" && (providedKeys.length !== 1 || providedKeys[0] !== selectedKey)) {
    throw new ValidationError(`scope_level=${input.scopeLevel} requires only its matching scope value`);
  }
  const normalized = normalizeScope(input.scopeLevel, selected);
  return {
    ...input,
    platform: normalized.platform,
    host: normalized.host,
    workspace: normalized.workspace,
    repository: normalized.repository,
    taskEnvironment: normalized.taskEnvironment,
  };
}

function validateCursorTuple(value: unknown): value is { createdAt: number; id: string } {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return Number.isFinite(row.createdAt) && typeof row.id === "string" && row.id.length > 0 && Buffer.byteLength(row.id, "utf-8") <= ID_MAX;
}

function pageSize<T>(items: T[], nextCursor?: string): number {
  return Buffer.byteLength(JSON.stringify({ items, ...(nextCursor ? { nextCursor } : {}) }), "utf-8");
}

function isCanonicalScope(scope: { scopeLevel: ScopeLevel; platform: string | null; host: string | null; workspace: string | null; repository: string | null; taskEnvironment: string | null }): boolean {
  try {
    const values = {
      platform: scope.platform,
      host: scope.host,
      workspace: scope.workspace,
      repository: scope.repository,
      taskEnvironment: scope.taskEnvironment,
    };
    const selected = scopeValue(values, scope.scopeLevel);
    const normalized = normalizeScope(scope.scopeLevel, selected);
    return normalized.platform === scope.platform
      && normalized.host === scope.host
      && normalized.workspace === scope.workspace
      && normalized.repository === scope.repository
      && normalized.taskEnvironment === scope.taskEnvironment;
  } catch {
    return false;
  }
}

function isValidVersion(version: OperationalMemoryVersion): boolean {
  if (!isCanonicalScope(version)) return false;
  try {
    return computeContentHash({
      content: version.content,
      status: version.status,
      scope: {
        scopeLevel: version.scopeLevel,
        platform: version.platform,
        host: version.host,
        workspace: version.workspace,
        repository: version.repository,
        taskEnvironment: version.taskEnvironment,
      },
      confidence: version.confidence,
      provenance: version.provenance,
      evidence: version.evidence,
    }) === version.contentHash;
  } catch {
    return false;
  }
}

function normalizeWriteScope(
  level: ScopeLevel,
  values: { platform?: string | null; host?: string | null; workspace?: string | null; repository?: string | null; taskEnvironment?: string | null },
) {
  const providedKeys = Object.entries(values).filter(([, value]) => value !== undefined).map(([key]) => key);
  const selectedKey = level === "task_environment" ? "taskEnvironment" : level;
  if (level === "global" && providedKeys.length !== 0) throw new ValidationError("global scope must not have scope values");
  if (level !== "global" && (providedKeys.length !== 1 || providedKeys[0] !== selectedKey)) {
    throw new ValidationError(`scope_level=${level} requires only its matching scope value`);
  }
  return normalizeScope(level, scopeValue(values, level));
}

export class OperationalMemoryService {
  private store: OperationalMemoryStore;
  private closed = false;

  constructor(store: OperationalMemoryStore) {
    this.store = store;
  }

  close(): void {
    this.closed = true;
  }

  async submitDraft(input: SubmitOperationalDraftInput): Promise<OperationalResult<OperationalDraft>> {
    try {
      if (this.closed) return validationErr("Operational memory is unavailable");
      const ns = normalizeWriteScope(input.scopeLevel, {
        platform: input.platform,
        host: input.host,
        workspace: input.workspace,
        repository: input.repository,
        taskEnvironment: input.taskEnvironment,
      });
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
      if (this.closed) return validationErr("Operational memory is unavailable");
      const limit = pageLimit(query.limit);
      if (limit === null) return validationErr("limit must be an integer between 1 and 100");
      if (query.status !== undefined && query.status !== "draft" && query.status !== "promoted" && query.status !== "rejected") {
        return validationErr("Invalid draft status");
      }
      const fp = cursorFingerprint({ status: query.status });

      let cursorCreatedAt: number | undefined;
      let cursorId: string | undefined;
      let parsedFp: string | null = null;
      if (query.cursor) {
        const [parsed, fpParsed] = parseCursor<DraftListCursor>(query.cursor);
        if (!parsed || fpParsed !== fp || !validateCursorTuple(parsed)) return validationErr("Invalid or mismatched cursor");
        cursorCreatedAt = parsed.createdAt;
        cursorId = parsed.id;
        parsedFp = fpParsed;
      }

      const candidates = this.store.listDraftsPaginated(query.status ?? null, limit, cursorCreatedAt, cursorId);
      const hasMore = candidates.length > limit;
      const items: OperationalDraft[] = [];
      let nextCursor: string | undefined;
      for (const draft of candidates.slice(0, limit)) {
        const candidateCursor = (hasMore || items.length + 1 < candidates.length)
          ? encodeCursor({ createdAt: draft.createdAt, id: draft.id, queryFingerprint: fp } satisfies DraftListCursor)
          : undefined;
        const candidateItems = [...items, draft];
        if (pageSize(candidateItems, candidateCursor) > PAGE_SERIALIZED_MAX) {
          if (items.length === 0) return validationErr("Single draft exceeds serialized page limit");
          nextCursor = encodeCursor({ createdAt: items[items.length - 1]!.createdAt, id: items[items.length - 1]!.id, queryFingerprint: fp } satisfies DraftListCursor);
          return ok({ items, nextCursor });
        }
        items.push(draft);
        nextCursor = candidateCursor;
      }
      return ok({ items, nextCursor });
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  async getMemory(memoryId: string): Promise<OperationalResult<OperationalMemoryProjection>> {
    try {
      if (this.closed) return validationErr("Operational memory is unavailable");
      if (typeof memoryId !== "string") return validationErr("memoryId must be text");
      if (Buffer.byteLength(memoryId, "utf-8") > ID_MAX) return validationErr("memoryId too long");
      const memory = this.store.getMemory(memoryId);
      if (!memory) return notFoundErr(`Memory not found: ${memoryId}`);
      const version = this.store.getVersion(memory.currentVersionId);
      if (!version) return validationErr(`Memory ${memoryId} has missing current version`);
      const scope = memory as unknown as { scopeLevel: ScopeLevel; platform: string | null; host: string | null; workspace: string | null; repository: string | null; taskEnvironment: string | null };
      const canonical = isCanonicalScope(scope);
      if (!canonical || !isValidVersion(version) || version.memoryId !== memory.id || version.contentHash !== memory.contentHash) {
        return validationErr(`Memory ${memoryId} has invalid current version`);
      }
      if (pageSize([buildProjection(memory, version)]) > PAGE_SERIALIZED_MAX) return validationErr("Memory exceeds serialized page limit");
      return ok(buildProjection(memory, version));
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  async getHistory(memoryId: string, page: PageRequest): Promise<OperationalResult<Page<OperationalMemoryVersion>>> {
    try {
      if (this.closed) return validationErr("Operational memory is unavailable");
      if (typeof memoryId !== "string") return validationErr("memoryId must be text");
      if (page === null || typeof page !== "object") return validationErr("page must be an object");
      if (Buffer.byteLength(memoryId, "utf-8") > ID_MAX) return validationErr("memoryId too long");
      const memory = this.store.getMemory(memoryId);
      if (!memory) return notFoundErr(`Memory not found: ${memoryId}`);

      if (!isCanonicalScope(memory)) return validationErr(`Memory ${memoryId} has non-canonical stored scope`);
      const limit = pageLimit(page.limit);
      if (limit === null) return validationErr("limit must be an integer between 1 and 100");
      const fp = cursorFingerprint({});

      let cursorCreatedAt: number | undefined;
      let cursorId: string | undefined;
      if (page.cursor) {
        const [parsed, fpParsed] = parseCursor<MemoryVersionCursor>(page.cursor);
        if (!parsed || fpParsed !== fp || parsed.memoryId !== memoryId || !validateCursorTuple(parsed)) return validationErr("Invalid or mismatched cursor");
        cursorCreatedAt = parsed.createdAt;
        cursorId = parsed.id;
      }

      const candidates = this.store.getVersionLineagePaginated(memoryId, limit, cursorCreatedAt, cursorId);
      for (const version of candidates) {
        if (!isValidVersion(version)) return validationErr(`Memory ${memoryId} has invalid version history`);
      }
      const hasMore = candidates.length > limit;
      const items: OperationalMemoryVersion[] = [];
      let nextCursor: string | undefined;
      for (const version of candidates.slice(0, limit)) {
        const candidateCursor = (hasMore || items.length + 1 < candidates.length)
          ? encodeCursor({ createdAt: version.createdAt, id: version.id, memoryId, queryFingerprint: fp } satisfies MemoryVersionCursor)
          : undefined;
        const candidateItems = [...items, version];
        if (pageSize(candidateItems, candidateCursor) > PAGE_SERIALIZED_MAX) {
          if (items.length === 0) return validationErr("Single version exceeds serialized page limit");
          const last = items[items.length - 1]!;
          return ok({
            items,
            nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id, memoryId, queryFingerprint: fp } satisfies MemoryVersionCursor),
          });
        }
        items.push(version);
        nextCursor = candidateCursor;
      }
      return ok({ items, nextCursor });
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  async promoteDraft(input: PromoteDraftInput): Promise<OperationalResult<OperationalMemoryProjection>> {
    try {
      if (this.closed) return validationErr("Operational memory is unavailable");
      const result = this.store.promoteDraft(input);
      return this.mapPromoteResult(result, input.draftId);
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  async rejectDraft(input: RejectDraftInput): Promise<OperationalResult<OperationalDraft>> {
    try {
      if (this.closed) return validationErr("Operational memory is unavailable");
      const result = this.store.rejectDraft(input);
      return this.mapRejectResult(result, input.draftId);
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  async revise(input: ReviseOperationalMemoryInput): Promise<OperationalResult<OperationalMemoryProjection>> {
    try {
      if (this.closed) return validationErr("Operational memory is unavailable");
      const normalizedInput = normalizeMutationScope(input);
      const result = this.store.revise(normalizedInput);
      return this.mapMemoryMutationResult(result, input.memoryId);
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  async retire(input: RetireOperationalMemoryInput): Promise<OperationalResult<OperationalMemoryProjection>> {
    try {
      if (this.closed) return validationErr("Operational memory is unavailable");
      const result = this.store.retire(input);
      return this.mapMemoryMutationResult(result, input.memoryId);
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  async recall(query: OperationalRecallQuery): Promise<OperationalResult<Page<OperationalRecallHit>>> {
    try {
      if (this.closed) return validationErr("Operational memory is unavailable");
      const limit = pageLimit(query.limit);
      if (limit === null) return validationErr("limit must be an integer between 1 and 100");
      if (query.query !== undefined && typeof query.query !== "string") return validationErr("query must be text");
      const normalizedQuery = query.query === undefined ? null : normalizeQuery(query.query);
      if (query.query !== undefined && query.query.trim().length > 0 && normalizedQuery === null) {
        return validationErr("query exceeds 1024 bytes");
      }
      const tokens = normalizedQuery ? queryTokens(normalizedQuery) : [];

      const normalizedScope = normalizeRuntimeScope({
        platform: query.platform,
        host: query.host,
        workspace: query.workspace,
        repository: query.repository,
        taskEnvironment: query.taskEnvironment,
      });
      const fp = cursorFingerprint({ query: normalizedQuery ?? undefined, ...normalizedScope });

      let cursorUpdatedAt: number | undefined;
      let cursorId: string | undefined;
      let cursorScopeRank: number | undefined;
      if (query.cursor) {
        const [parsed, fpParsed] = parseCursor<RecallCursor>(query.cursor);
        if (!parsed || fpParsed !== fp || !validateCursorTuple(parsed) || !Number.isInteger(parsed.scopeRank) || parsed.scopeRank < 0 || parsed.scopeRank >= SCOPE_RANK_ORDER.length) {
          return validationErr("Invalid or mismatched cursor");
        }
        cursorUpdatedAt = parsed.updatedAt;
        cursorId = parsed.id;
        cursorScopeRank = parsed.scopeRank;
      }

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
      let examined = 0;
      let hasMore = false;
      let continuation: { updatedAt: number; id: string; scopeRank: number } | undefined;
      let lastExamined: { updatedAt: number; id: string; scopeRank: number } | undefined;

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
          const rowCursor = {
            updatedAt: row.updated_at as number,
            id: row.memory_id as string,
            scopeRank: row.scope_rank as number,
          };
          if (examined >= RECALL_EXAMINE_MAX) {
            continuation = lastExamined;
            hasMore = true;
            break;
          }
          examined++;
          lastExamined = rowCursor;

          if (!isCanonicalScope({
            scopeLevel: row.scope_level as ScopeLevel,
            platform: (row.platform as string) ?? null,
            host: (row.host as string) ?? null,
            workspace: (row.workspace as string) ?? null,
            repository: (row.repository as string) ?? null,
            taskEnvironment: (row.task_environment as string) ?? null,
          }) || row.version_scope_level !== row.scope_level
            || row.version_platform !== row.platform
            || row.version_host !== row.host
            || row.version_workspace !== row.workspace
            || row.version_repository !== row.repository
            || row.version_task_environment !== row.task_environment
            || row.version_content_hash !== row.content_hash) continue;

          if (tokens.length > 0) {
            const content = (row.lesson as string) ?? "";
            if (!matchesQuery(content, tokens)) continue;
          }

          let hit: OperationalRecallHit;
          try {
            const evidence = this.parseEvidence(row.evidence_json as string | null);
            const provenance = this.parseProvenance(row.version_provenance_json as string | null);
            const version: OperationalMemoryVersion = {
              id: row.current_version_id as string,
              memoryId: row.memory_id as string,
              previousVersionId: null,
              status: "active",
              scopeLevel: row.version_scope_level as ScopeLevel,
              platform: (row.version_platform as string) ?? null,
              host: (row.version_host as string) ?? null,
              workspace: (row.version_workspace as string) ?? null,
              repository: (row.version_repository as string) ?? null,
              taskEnvironment: (row.version_task_environment as string) ?? null,
              content: (row.lesson as string) ?? "",
              contentHash: row.version_content_hash as string,
              confidence: row.version_confidence as number,
              provenance,
              evidence,
              mutationReason: "",
              actorId: "",
              createdAt: row.version_created_at as number,
            };
            if (!isValidVersion(version)) continue;
            hit = {
            memoryId: row.memory_id as string,
            contentHash: row.content_hash as string,
            versionId: row.current_version_id as string,
            scopeLevel: row.scope_level as ScopeLevel,
            matchedScopeLevel: SCOPE_RANK_ORDER[row.scope_rank as number] as OperationalRecallHit["matchedScopeLevel"],
            confidence: row.confidence as number,
            lesson: (row.lesson as string) ?? "",
            problem: null,
            recommendation: null,
            evidence,
            provenance,
            createdAt: row.created_at as number,
            updatedAt: row.updated_at as number,
            };
          } catch (err) {
            if (err instanceof ValidationError) continue;
            throw err;
          }

          if (pageSize([...hits, hit]) > PAGE_SERIALIZED_MAX) {
            if (hits.length === 0) return validationErr("Single recall hit exceeds serialized page limit");
            hasMore = true;
            break;
          }

          hits.push(hit);
          continuation = rowCursor;

          if (hits.length >= limit) {
            hasMore = rows.length > rows.indexOf(row) + 1 || rows.length === RECALL_SCAN_CHUNK;
            break;
          }
        }

        if (!hasMore && examined >= RECALL_EXAMINE_MAX && rows.length === RECALL_SCAN_CHUNK) {
          continuation = lastExamined;
          hasMore = true;
        }
        if (hasMore || examined >= RECALL_EXAMINE_MAX || hits.length >= limit) break;
        const last = rows[rows.length - 1]!;
        cursorUpdatedAt = last.updated_at as number;
        cursorId = last.memory_id as string;
        cursorScopeRank = last.scope_rank as number;
      }

      const cursor = hasMore && continuation
        ? encodeCursor({ ...continuation, queryFingerprint: fp } satisfies RecallCursor)
        : undefined;

      return ok({ items: hits, nextCursor: cursor });
    } catch (err) {
      if (err instanceof ValidationError) return validationErr(err.message);
      throw err;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private parseEvidence(raw: string | null): EvidenceEntry[] {
    if (!raw) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new ValidationError("Stored evidence is invalid JSON"); }
    if (!Array.isArray(parsed)) throw new ValidationError("Stored evidence is not an array");
    return parsed as EvidenceEntry[];
  }

  private parseProvenance(raw: string | null): ProvenanceMap {
    if (!raw) return {};
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new ValidationError("Stored provenance is invalid JSON"); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ValidationError("Stored provenance is not an object");
    return parsed as ProvenanceMap;
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
      if (!version || !isCanonicalScope(result.value) || !isValidVersion(version) || version.contentHash !== result.value.contentHash) return validationErr("Promoted memory has an invalid current version");
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

  private mapMemoryMutationResult(result: OperationalWriteResult<OperationalMemory>, memoryId: string): OperationalResult<OperationalMemoryProjection> {
    if (result.ok) {
      const version = this.store.getVersion(result.value.currentVersionId);
      if (!version || !isCanonicalScope(result.value) || !isValidVersion(version) || version.contentHash !== result.value.contentHash) return validationErr("Memory has an invalid current version");
      return ok(buildProjection(result.value, version));
    }
    if (result.code === "validation_error") return validationErr("Validation failed");
    if (result.code === "not_found") return notFoundErr("Memory not found");
    if (result.code === "conflict" && result.current) {
      return conflictErr("Stale content hash", {
        kind: "memory",
        memoryId,
        versionId: result.current.versionId,
        contentHash: result.current.contentHash,
      });
    }
    return conflictErr("Conflict", { kind: "memory", memoryId, versionId: "", contentHash: "" });
  }
}
