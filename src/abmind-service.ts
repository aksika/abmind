import type Database from "better-sqlite3";
import { recallSearch } from "./recall-engine.js";
import type {
  AbmindMethod, AbmindMethodMap, AbmindRequestV1, AbmindResponseV1,
  AbmindErrorBodyV1, AbmindCurrentV1, AbmindCapabilitiesV1,
  AbmindSystemHealthOutput, AbmindSystemStatusOutput,
  ServiceCallContext, DomainName, MethodEntry,
} from "./abmind-protocol.js";
import {
  ABMIND_PROTOCOL_VERSION, METHOD_REGISTRY, REQUEST_MAX_BYTES,
  RESPONSE_MAX_BYTES, REQUEST_ID_MAX, IDEMPOTENCY_KEY_MAX,
  SESSION_ORIGIN_MAX, ABMIND_VERSION, CAS_WRITE_ENABLED,
  canonicalPayloadHash,
} from "./abmind-protocol.js";
import type { MemoryManager } from "./memory-manager.js";
import type { OperationalMemoryApi } from "./imemory-system.js";
import type { PageRequest } from "./operational-memory-types.js";
import { buildSessionStartContext } from "./session-context.js";
import { buildWakeUp } from "./wake-up-builder.js";

export interface AbmindServiceConfig {
  serverInstanceId: string;
  mode: "embedded" | "daemon";
  manager: MemoryManager;
  operational: OperationalMemoryApi | null;
  requestLedgerDb: Database.Database | null;
}

export class AbmindService {
  private readonly serverInstanceId: string;
  private readonly mode_: "embedded" | "daemon";
  private readonly manager: MemoryManager;
  private readonly operational: OperationalMemoryApi | null;
  readonly ledger: AbmindRequestLedger | null;
  private closed = false;
  private inFlight_ = 0;
  private requestCount_ = 0;
  private startTime = Date.now();

  constructor(config: AbmindServiceConfig) {
    this.serverInstanceId = config.serverInstanceId;
    this.mode_ = config.mode;
    this.manager = config.manager;
    this.operational = config.operational;
    this.ledger = config.requestLedgerDb ? new AbmindRequestLedger(config.requestLedgerDb) : null;
  }

  close(): void {
    this.closed = true;
  }

  get mode(): "embedded" | "daemon" { return this.mode_; }
  get requestCount(): number { return this.requestCount_; }
  get isClosed(): boolean { return this.closed; }
  get inFlight(): number { return this.inFlight_; }

  async drain(timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (this.inFlight_ > 0 && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  async handle<K extends AbmindMethod>(
    request: AbmindRequestV1<K>,
    context: ServiceCallContext,
  ): Promise<AbmindResponseV1<K>> {
    if (this.closed) return this.err(request.requestId, "unavailable", "Service is closed");

    const parseResult = this.parseAndValidate(request);
    if (!parseResult.ok) return parseResult.response;

    const { method, payload } = parseResult;

    const entry: MethodEntry<K> = METHOD_REGISTRY[method];
    const authResult = this.authorize(entry, context);
    if (!authResult) {
      return this.err(request.requestId, "unauthorized", `Domain not granted: ${entry.domain}`);
    }

    if (entry.domain === "private") {
      const userIdResult = this.resolveUserId(context, payload);
      if (!userIdResult.ok) {
        return this.err(request.requestId, "unauthorized", "Principal not authorized for private memory");
      }
    }

    const payloadError = this.validatePayload(method, payload);
    if (payloadError) {
      return this.err(request.requestId, "validation_error", payloadError);
    }

    if (method === "private.recordFeedback") {
      const feedback = payload as { userId: string; memoryId: number };
      if (!this.manager.hasExtractedMemoryForUser(feedback.memoryId, feedback.userId)) {
        return this.err(request.requestId, "unauthorized", "Memory does not belong to the authenticated user");
      }
    }

    if (entry.requiresCas && !CAS_WRITE_ENABLED) {
      return this.err(request.requestId, "unauthorized", "Private mutation requires #1449 CAS enforcement which is not yet available");
    }

    this.inFlight_++;
    try {
      if (entry.mutation === "read") {
        return await this.dispatchRead(request.requestId, method, payload);
      }

      if (!request.idempotencyKey) {
        return this.err(request.requestId, "validation_error", "Idempotency key required for mutating method");
      }

      if (!this.ledger) {
        return this.err(request.requestId, "unavailable", "Request ledger not available");
      }

      return await this.dispatchWithIdempotency(request.requestId, method, payload, context, request.idempotencyKey);
    } finally {
      this.inFlight_--;
    }
  }

  private parseAndValidate<K extends AbmindMethod>(
    request: AbmindRequestV1<K>,
  ): { ok: true; method: K; payload: AbmindMethodMap[K]["input"] } | { ok: false; response: AbmindResponseV1<K> } {
    if (request.version !== ABMIND_PROTOCOL_VERSION) {
      return { ok: false, response: this.err(request.requestId, "unsupported_version", `Unsupported protocol version: ${request.version}`) };
    }

    if (!request.method) {
      return { ok: false, response: this.err(request.requestId, "unsupported_method", "Method is required") };
    }

    const entry = METHOD_REGISTRY[request.method];
    if (!entry) {
      return { ok: false, response: this.err(request.requestId, "unsupported_method", `Unsupported method: ${request.method}`) };
    }

    if (typeof request.requestId !== "string" || request.requestId.length > REQUEST_ID_MAX) {
      return { ok: false, response: this.err(request.requestId, "validation_error", "Invalid or oversized requestId") };
    }

    if (request.idempotencyKey != null && (typeof request.idempotencyKey !== "string" || request.idempotencyKey.length > IDEMPOTENCY_KEY_MAX)) {
      return { ok: false, response: this.err(request.requestId, "validation_error", "Invalid or oversized idempotencyKey") };
    }

    if (request.context) {
      if (typeof request.context !== "object" || request.context === null) {
        return { ok: false, response: this.err(request.requestId, "validation_error", "context must be an object") };
      }
      if (request.context.sessionId != null && (typeof request.context.sessionId !== "string" || request.context.sessionId.length > SESSION_ORIGIN_MAX)) {
        return { ok: false, response: this.err(request.requestId, "validation_error", "Invalid sessionId") };
      }
      if (request.context.origin != null && (typeof request.context.origin !== "string" || request.context.origin.length > SESSION_ORIGIN_MAX)) {
        return { ok: false, response: this.err(request.requestId, "validation_error", "Invalid origin") };
      }
    }

    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(request.payload);
    } catch {
      return { ok: false, response: this.err(request.requestId, "validation_error", "Payload must be JSON-serializable") };
    }
    if (typeof serialized !== "string") {
      return { ok: false, response: this.err(request.requestId, "validation_error", "Payload is required") };
    }
    if (Buffer.byteLength(serialized, "utf-8") > Math.min(REQUEST_MAX_BYTES, entry.maxInputBytes)) {
      return { ok: false, response: this.err(request.requestId, "validation_error", "Request payload exceeds maximum size") };
    }

    return { ok: true, method: request.method, payload: request.payload as AbmindMethodMap[K]["input"] };
  }

  private validatePayload(method: AbmindMethod, payload: unknown): string | null {
    if (method.startsWith("private.") || method.startsWith("operational.")) {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return "Payload must be an object";
      }
    }

    const p = payload as Record<string, unknown>;
    const requiredString = (name: string): string | null =>
      typeof p[name] === "string" && (p[name] as string).trim().length > 0 ? null : `${name} must be a non-empty string`;

    switch (method) {
      case "private.recall": {
        const userError = requiredString("userId");
        if (userError) return userError;
        if (!Array.isArray(p.translated) || p.translated.some((v) => typeof v !== "string")) {
          return "translated must be an array of strings";
        }
        return null;
      }
      case "private.instantStore":
        return requiredString("userId") ?? requiredString("contentEn") ?? requiredString("contentOriginal") ?? requiredString("memoryType");
      case "private.edit":
        return requiredString("userId");
      case "private.cascadeDelete":
        return requiredString("userId") ?? (Array.isArray(p.messageIds) && p.messageIds.every((v) => Number.isInteger(v)) ? null : "messageIds must be an array of integers");
      case "private.recordMessage":
      case "private.assembleSessionContext":
      case "private.getCoreKnowledge":
        return requiredString("userId");
      case "private.recordFeedback":
        if (requiredString("userId")) return requiredString("userId");
        if (!Number.isSafeInteger(p.memoryId) || (p.memoryId as number) < 1) return "memoryId must be a positive integer";
        return p.feedbackType === "cite" || p.feedbackType === "reject" ? null : "feedbackType must be cite or reject";
      case "private.embed":
        if (!Array.isArray(p.texts) || p.texts.length < 1 || p.texts.length > 100 || p.texts.some((v) => typeof v !== "string" || v.length > 8192)) {
          return "texts must contain 1-100 strings of at most 8192 characters";
        }
        return null;
      default:
        return null;
    }
  }

  private authorize<K extends AbmindMethod>(
    entry: MethodEntry<K>,
    context: ServiceCallContext,
  ): boolean {
    if (!context.grantedDomains.has(entry.domain)) return false;
    return !entry.capability || context.capabilities?.has(entry.capability) === true;
  }

  private resolveUserId(context: ServiceCallContext, payload: unknown): { ok: boolean } {
    if (!context.grantedDomains.has("private")) return { ok: false };
    const p = payload as Record<string, unknown> | null | undefined;
    if (!p || typeof p !== "object") return { ok: true };
    // When userId is present in the payload, it must be a valid authenticated principal.
    if (
      "userId" in p &&
      (typeof p.userId !== "string" ||
        (p.userId !== context.principalId && context.allowPrivateDelegation !== true))
    ) {
      return { ok: false };
    }
    return { ok: true };
  }

  private async dispatchRead<K extends AbmindMethod>(
    requestId: string,
    method: K,
    payload: AbmindMethodMap[K]["input"],
  ): Promise<AbmindResponseV1<K>> {
    this.requestCount_++;
    try {
      const result = await this.doDispatch(method, payload);
      const serialized = JSON.stringify(result) ?? "null";
      if (serialized.length > RESPONSE_MAX_BYTES) {
        return this.err(requestId, "validation_error", "Response exceeds maximum size");
      }
      return { ok: true, requestId, serverInstanceId: this.serverInstanceId, result } as AbmindResponseV1<K>;
    } catch (err) {
      return this.err(requestId, "unavailable", `Dispatch error: ${(err as Error).message}`);
    }
  }

  private async dispatchWithIdempotency<K extends AbmindMethod>(
    requestId: string,
    method: K,
    payload: AbmindMethodMap[K]["input"],
    context: ServiceCallContext,
    idempotencyKey: string,
  ): Promise<AbmindResponseV1<K>> {
    const hash = canonicalPayloadHash(ABMIND_PROTOCOL_VERSION, method, payload);

    const reservation = this.ledger!.reserve(context.principalId, idempotencyKey, method, hash);
    if (reservation.status === "completed") {
      if (!this.authorize(METHOD_REGISTRY[method], context)) {
        return this.err(requestId, "unauthorized", "Authorization changed since original request");
      }
      return JSON.parse(reservation.responseJson!) as AbmindResponseV1<K>;
    }
    if (reservation.status === "conflict") {
      return this.err(requestId, "idempotency_conflict", reservation.message!);
    }
    if (reservation.status === "unknown") {
      return this.err(requestId, "outcome_unknown", "Previous request outcome is unknown; cannot retry");
    }

    this.ledger!.markStarted(context.principalId, idempotencyKey);
    const response = await this.dispatchMutation(requestId, method, payload);
    this.ledger!.complete(context.principalId, idempotencyKey, JSON.stringify(response));
    return response;
  }

  private async dispatchMutation<K extends AbmindMethod>(
    requestId: string,
    method: K,
    payload: AbmindMethodMap[K]["input"],
  ): Promise<AbmindResponseV1<K>> {
    this.requestCount_++;
    try {
      const result = await this.doDispatch(method, payload);
      const serialized = JSON.stringify(result) ?? "null";
      if (serialized.length > RESPONSE_MAX_BYTES) {
        return this.err(requestId, "validation_error", "Response exceeds maximum size");
      }
      return { ok: true, requestId, serverInstanceId: this.serverInstanceId, result } as AbmindResponseV1<K>;
    } catch (err) {
      return this.err(requestId, "unavailable", `Dispatch error: ${(err as Error).message}`);
    }
  }

  private async doDispatch<K extends AbmindMethod>(
    method: K,
    payload: AbmindMethodMap[K]["input"],
  ): Promise<AbmindMethodMap[K]["output"]> {
    const m = method;
    const p = payload as unknown;
    switch (m) {
      case "system.negotiate":
        return this.handleNegotiate() as unknown as AbmindMethodMap[K]["output"];
      case "system.health":
        return this.handleHealth() as unknown as AbmindMethodMap[K]["output"];
      case "system.status":
        return this.handleStatus() as unknown as AbmindMethodMap[K]["output"];
      case "system.capabilities":
        return this.handleCapabilities() as unknown as AbmindMethodMap[K]["output"];

      case "private.recall":
        return await this.dispatchPrivateRecall(p as Parameters<typeof recallSearch>[1]) as unknown as AbmindMethodMap[K]["output"];
      case "private.instantStore":
        return this.manager.editor.instantStore(p as Parameters<MemoryManager["editor"]["instantStore"]>[0]) as unknown as AbmindMethodMap[K]["output"];
      case "private.edit":
        return this.manager.editor.editMemory(p as Parameters<MemoryManager["editor"]["editMemory"]>[0]) as unknown as AbmindMethodMap[K]["output"];
      case "private.reclassify": {
        const rp = p as { id: number; level: number; userOverride: boolean };
        this.manager.editor.reclassifyMemory(rp.id, rp.level, rp.userOverride);
        return undefined as unknown as AbmindMethodMap[K]["output"];
      }
      case "private.adjustRelevance": {
        const ap = p as { id: number; delta: number };
        this.manager.editor.adjustRelevance(ap.id, ap.delta);
        return undefined as unknown as AbmindMethodMap[K]["output"];
      }
      case "private.merge":
        return this.manager.editor.mergeMemories(
          (p as { idA: number; idB: number }).idA,
          (p as { idA: number; idB: number }).idB,
        ) as unknown as AbmindMethodMap[K]["output"];
      case "private.cascadeDelete":
        return this.manager.editor.cascadeDelete(
          (p as { messageIds: number[]; userId: string }).messageIds,
          (p as { messageIds: number[]; userId: string }).userId,
        ) as unknown as AbmindMethodMap[K]["output"];
      case "private.rebuildFts":
        return this.manager.rebuildFtsIndexes() as unknown as AbmindMethodMap[K]["output"];
      case "private.embed": {
        const provider = this.manager.getEmbeddingProvider();
        if (!provider) throw new Error("Embeddings are not configured");
        const vectors = await provider.batchEmbed((p as { texts: string[] }).texts);
        return { vectors: vectors.map(v => v ? Array.from(v) : null), model: provider.name } as unknown as AbmindMethodMap[K]["output"];
      }

      case "private.recordMessage":
        return this.manager.recordMessage(p as any) as any;
      case "private.getRecentConversation": {
        const rcp = p as { userId: string; since: number; limit: number };
        return this.manager.getRecentConversation(rcp.userId, rcp.since, rcp.limit) as any;
      }
      case "private.assembleSessionContext": {
        const scp = p as { userId: string; maxChars?: number };
        const maxChars = scp.maxChars == null ? undefined : Math.max(256, Math.min(131072, Math.floor(scp.maxChars)));
        const session = buildSessionStartContext(this.manager, scp.userId, maxChars);
        return {
          wakeUp: this.manager.buildWakeUp(maxChars),
          recall: session.text ?? "",
          coreKnowledge: this.manager.readCoreKnowledge(),
          soulBundle: this.manager.getSessionBundle(),
        } as any;
      }
      case "private.getRuntimeStatus":
        return this.manager.getStats((p as any)?.userId) as any;
      case "private.getCoreKnowledge":
        return this.manager.readCoreKnowledge() as any;
      case "private.recordFeedback": {
        const fp = p as { userId: string; memoryId: number; feedbackType: "cite" | "reject" };
        if (!this.manager.hasExtractedMemoryForUser(fp.memoryId, fp.userId)) {
          throw new Error("Memory no longer belongs to the authenticated user");
        }
        if (fp.feedbackType === "cite") this.manager.bumpCitedCount([fp.memoryId]);
        else this.manager.bumpRejectedCount([fp.memoryId]);
        return undefined as any;
      }

      case "operational.submitDraft":
        return await this.operational!.submitDraft(p as Parameters<OperationalMemoryApi["submitDraft"]>[0]) as unknown as AbmindMethodMap[K]["output"];
      case "operational.listDrafts":
        return await this.operational!.listDrafts(p as Parameters<OperationalMemoryApi["listDrafts"]>[0]) as unknown as AbmindMethodMap[K]["output"];
      case "operational.getMemory":
        return await this.operational!.getMemory((p as { memoryId: string }).memoryId) as unknown as AbmindMethodMap[K]["output"];
      case "operational.getHistory":
        return await this.operational!.getHistory(
          (p as { memoryId: string; page: PageRequest }).memoryId,
          (p as { memoryId: string; page: PageRequest }).page,
        ) as unknown as AbmindMethodMap[K]["output"];
      case "operational.promoteDraft":
        return await this.operational!.promoteDraft(p as Parameters<OperationalMemoryApi["promoteDraft"]>[0]) as unknown as AbmindMethodMap[K]["output"];
      case "operational.rejectDraft":
        return await this.operational!.rejectDraft(p as Parameters<OperationalMemoryApi["rejectDraft"]>[0]) as unknown as AbmindMethodMap[K]["output"];
      case "operational.revise":
        return await this.operational!.revise(p as Parameters<OperationalMemoryApi["revise"]>[0]) as unknown as AbmindMethodMap[K]["output"];
      case "operational.retire":
        return await this.operational!.retire(p as Parameters<OperationalMemoryApi["retire"]>[0]) as unknown as AbmindMethodMap[K]["output"];
      case "operational.recall":
        return await this.operational!.recall(p as Parameters<OperationalMemoryApi["recall"]>[0]) as unknown as AbmindMethodMap[K]["output"];

      default:
        throw new Error(`Unhandled method: ${method}`);
    }
  }

  private async dispatchPrivateRecall(
    params: Parameters<typeof recallSearch>[1],
  ): Promise<Awaited<ReturnType<typeof recallSearch>>> {
    const db = this.manager.getDatabase();
    if (!db) throw new Error("Database not initialized");
    const index = this.manager.getMemoryIndex();
    if (!index) throw new Error("Memory index not initialized");
    return recallSearch({ db, index, memoryDir: this.manager.getConfig().memoryDir }, params);
  }

  private handleNegotiate(): AbmindCapabilitiesV1 {
    const methods = Object.keys(METHOD_REGISTRY);
    const domains = ["system", "private", "operational", "operator"];
    return { version: ABMIND_PROTOCOL_VERSION, methods, domains, features: {} };
  }

  private handleHealth(): AbmindSystemHealthOutput {
    const enabled = this.manager.getConfig().memoryEnabled;
    return { status: enabled ? "healthy" : "degraded", uptimeMs: Date.now() - this.startTime, memoryEnabled: enabled };
  }

  private handleStatus(): AbmindSystemStatusOutput {
    return {
      version: ABMIND_VERSION,
      mode: this.mode_,
      instanceId: this.serverInstanceId,
      databaseSizeBytes: 0,
      operationalDbSizeBytes: 0,
      uptimeMs: Date.now() - this.startTime,
      requestCount: this.requestCount_,
    };
  }

  private handleCapabilities(): Record<string, string> {
    return {
      version: String(ABMIND_PROTOCOL_VERSION),
      mode: this.mode_,
      private_read: "true",
      private_write: String(CAS_WRITE_ENABLED),
      operational: String(this.operational !== null),
    };
  }

  private err<K extends AbmindMethod>(
    requestId: string,
    code: AbmindErrorBodyV1["code"],
    message: string,
    current?: AbmindCurrentV1,
  ): AbmindResponseV1<K> {
    const error: AbmindErrorBodyV1 = { code, message };
    if (current) error.current = current;
    return { ok: false, requestId, error } as AbmindResponseV1<K>;
  }
}

// ── Idempotency ledger ──────────────────────────────────────────────────────

export type ReservationResult =
  | { status: "completed"; responseJson: string }
  | { status: "conflict"; message: string }
  | { status: "unknown" }
  | { status: "reserved" };

export class AbmindRequestLedger {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  reserve(principalId: string, idempotencyKey: string, method: string, payloadHash: string): ReservationResult {
    const existing = this.db.prepare(`
      SELECT method, payload_hash, state, response_json FROM abmind_service_requests
      WHERE principal_id = ? AND idempotency_key = ?
    `).get(principalId, idempotencyKey) as { method: string; payload_hash: string; state: string; response_json: string | null } | undefined;

    if (existing) {
      if (existing.method !== method || existing.payload_hash !== payloadHash) {
        return { status: "conflict", message: "Idempotency key used with different method or payload" };
      }
      if (existing.state === "completed") {
        return { status: "completed", responseJson: existing.response_json! };
      }
      return { status: "unknown" };
    }

    const now = Date.now();
    try {
      this.db.prepare(`
        INSERT INTO abmind_service_requests (principal_id, idempotency_key, method, payload_hash, state, response_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'reserved', NULL, ?, ?)
      `).run(principalId, idempotencyKey, method, payloadHash, now, now);
      return { status: "reserved" };
    } catch {
      return { status: "unknown" };
    }
  }

  markStarted(principalId: string, idempotencyKey: string): void {
    this.db.prepare(`
      UPDATE abmind_service_requests SET state = 'dispatch_started', updated_at = ?
      WHERE principal_id = ? AND idempotency_key = ? AND state = 'reserved'
    `).run(Date.now(), principalId, idempotencyKey);
  }

  complete(principalId: string, idempotencyKey: string, responseJson: string): void {
    this.db.prepare(`
      UPDATE abmind_service_requests SET state = 'completed', response_json = ?, updated_at = ?
      WHERE principal_id = ? AND idempotency_key = ?
    `).run(responseJson, Date.now(), principalId, idempotencyKey);
  }

  markUnknown(principalId: string, idempotencyKey: string): void {
    this.db.prepare(`
      UPDATE abmind_service_requests SET state = 'outcome_unknown', updated_at = ?
      WHERE principal_id = ? AND idempotency_key = ?
    `).run(Date.now(), principalId, idempotencyKey);
  }

  /** Transition rows left in dispatch_started by a crash to outcome_unknown. */
  recoverCrashed(): void {
    this.db.prepare(`
      UPDATE abmind_service_requests SET state = 'outcome_unknown', updated_at = ?
      WHERE state = 'dispatch_started' OR state = 'reserved'
    `).run(Date.now());
  }

  cleanup(): void {
    const cutoff = Date.now() - 30 * 24 * 3600_000;
    this.db.prepare(`
      DELETE FROM abmind_service_requests WHERE state = 'completed' AND updated_at < ?
    `).run(cutoff);

    const count = this.db.prepare("SELECT COUNT(*) as c FROM abmind_service_requests WHERE state = 'completed'").get() as { c: number };
    if (count.c > 10000) {
      this.db.prepare(`
        DELETE FROM abmind_service_requests WHERE rowid IN (
          SELECT rowid FROM abmind_service_requests WHERE state = 'completed'
          ORDER BY updated_at ASC LIMIT ?
        )
      `).run(count.c - 10000);
    }
  }
}
