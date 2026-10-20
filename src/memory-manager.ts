import { mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { MessageStore } from "./message-store.js";
import { MemoryEditor } from "./memory-editor.js";
import { MaintenanceService } from "./maintenance-service.js";
import { loadEmbedConfig } from "./ollama-embed.js";
import { createEmbeddingProvider, type IEmbeddingProvider } from "./embedding-provider.js";
import { getAbmindEnv } from "./env-schema.js";

import type { SearchResult, SearchOptions } from "./mem-types.js";
import type { IOperationalMemoryCore } from "./imemory-system.js";
import { logError, logInfo, logWarn } from "./mem-logger.js";
import { abmindHome } from "./mem-paths.js";
import { resolveSavedUserIdOrNull } from "./user-utils.js";
import { SleepDataAccess } from "./sleep-data-access.js";
import { buildWakeUp } from "./wake-up-builder.js";
import { readCoreParts, suppressCoreParts, isMemoryTestMode, applyNotesReadBudget, AGENT_NOTES_BUDGET_BYTES, type CoreParts } from "./core-composition.js";
import { quantizeToInt8 } from "./embedding-quantize.js";
import { isPersonalReady } from "./personal-schema.js";
import { requirePersonalRoute } from "./personal-readiness.js";
import { listPersonalPrincipals } from "./personal-exchanges.js";
import { selectPrunableMessageIds } from "./personal-retention.js";

const TAG = "memory-manager";

/**
 * Top-level coordinator for the local memory layer.
 *
 * Owns the SQLite database and delegates to focused sub-services:
 * - store: message recording and loading
 * - editor: extracted memory mutations (edit, instant-store, merge, delete)
 * - maintenance: disk budget, backup pruning, auto-compact, forget operations
 * - operationalStore: operational memory writes (#1371)
 * - operational: operational memory service facade (#1372)
 *
 * When `memoryEnabled` is false, all methods are no-ops.
 *
 * Implements IMemoryCore, IMemorySystem, and IOperationalMemoryCore.
 */
export class MemoryManager implements IOperationalMemoryCore {
  private readonly config: MemoryConfig;
  private db: Database.Database | null = null;
  private memoryIndex: MemoryIndex | null = null;
  private embeddingProvider: IEmbeddingProvider | null = null;

  /** Message recording and loading. Available after initialize(). */
  store!: MessageStore;
  /** Extracted memory mutations. Available after initialize(). */
  editor!: MemoryEditor;
  /** Disk budget, pruning, forget operations. Available after initialize(). */
  maintenance!: MaintenanceService;

  /** @internal Operational memory store (#1371). Package-internal; not exported. */
  private operationalStore: import("./operational-memory-store.js").OperationalMemoryStore | null = null;
  /** @internal Operational memory service (#1372). Package-internal; not exported. */
  private operationalService: import("./operational-memory-service.js").OperationalMemoryService | null = null;

  /** Operational memory API facade (#1372). Null before init, after close, on failure, or when memory is disabled. */
  private operationalApi: import("./imemory-system.js").OperationalMemoryApi | null = null;
  get operational(): import("./imemory-system.js").OperationalMemoryApi | null { return this.operationalApi; }

  /**
   * Runtime availability flag (consumer-managed, not abmind-internal). Consumers
   * (e.g. abtars) set this to false when a memory bundle comes back empty, so
   * later prompt/soul builds skip memory rather than emitting a broken bundle.
   * Declared on the class so consumers need no cross-package type augmentation
   * (#1243 supported surface); abmind itself does not read or set it.
   */
  available?: boolean;

  constructor(config: MemoryConfig, opts?: { ownerSnapshot?: string }) {
    this.config = config;
    this.ownerSnapshotOverride = opts?.ownerSnapshot ?? null;
  }

  /**
   * #1863 Step 0: the owner's immutable primary-identity snapshot. Resolved
   * once in `initialize()` from the injected value or the home manifest, then
   * held for the process lifetime — never re-read, never derived from ambient
   * env. Null only when neither is available (isolated tests without a
   * manifest); production installs always persist one, and owner startup
   * points refuse to serve without it.
   */
  private ownerSnapshotOverride: string | null = null;
  private ownerSnapshot: string | null = null;
  getOwnerSnapshot(): string | null { return this.ownerSnapshot; }

  /** @internal Package-internal only. External consumers use IMemorySystem methods. */
  getMemoryIndex(): MemoryIndex | null { return this.memoryIndex; }
  getConfig(): MemoryConfig { return this.config; }

  /** The active embedding provider (null if memory disabled or not yet initialized). */
  getEmbeddingProvider(): IEmbeddingProvider | null { return this.embeddingProvider; }

  async initialize(opts?: { skipEmbeddingCheck?: boolean }): Promise<void> {
    if (!this.config.memoryEnabled) return;

    // #1863 Step 0: capture the immutable owner snapshot once. Injected
    // identity wins (tests), else the home manifest. Resolved only on the
    // first initialize: a repeated initialize must not re-read the manifest
    // and change ownership mid-process. Null when neither exists —
    // reachable only in isolated tests; owner startup points resolve
    // strictly and refuse without one.
    if (this.ownerSnapshot === null) {
      this.ownerSnapshot = this.ownerSnapshotOverride ?? resolveSavedUserIdOrNull(abmindHome());
    }

    try {
      mkdirSync(this.config.memoryDir, { recursive: true });

      const dbPath = join(this.config.memoryDir, "memory.db");
      this.db = initializeDatabase(dbPath);
      this.runWalCheckpoint(); // flush pending WAL from previous crash

      // #427 — seed missing core files + run schema migrations
      const { ensureInitialized } = await import("./ensure-initialized.js");
      ensureInitialized(this.db, this.config.memoryDir);

      // #1660 — settle any interrupted secrets key rotation and report a
      // generation mismatch (restored backup) as an operator decision.
      try {
        const { recoverSecretKeyRotation } = await import("./secret-key-rotation.js");
        const rotation = recoverSecretKeyRotation(this.db);
        if (rotation.state === "mismatch" || rotation.state === "refused") {
          logWarn(TAG, `Secret key rotation state requires an operator decision (db generation ${rotation.dbGeneration}, key generation ${rotation.keyGeneration}, ${rotation.encryptedRowCount} encrypted rows): ${rotation.reason}`);
        }
      } catch (rotationErr) {
        logWarn(TAG, `Secret key rotation recovery failed: ${rotationErr instanceof Error ? rotationErr.message : String(rotationErr)}`);
      }

      if (this.db.prepare("SELECT 1 FROM forget_operations WHERE state = 'pending' LIMIT 1").get()) {
        const { resumePendingForgetCleanup } = await import("./personal-forget.js");
        const cleanup = resumePendingForgetCleanup(this.db, this.config.memoryDir);
        if (cleanup.completed < cleanup.resumed) logWarn(TAG, "Personal forgetting cleanup remains pending; affected serving stays blocked");
      }

      this.memoryIndex = new MemoryIndex(this.db);

      // Wire sub-services FIRST — message recording must not be blocked by embedding failures (#860)
      this.editor = new MemoryEditor(this.db, this.ownerSnapshot);
      this.store = new MessageStore(this.db, this.config, this.memoryIndex);
      this.maintenance = new MaintenanceService(this.db, this.config, this.memoryIndex, this.editor, () => getAbmindEnv().embeddingDimensions);
      this.store.setDiskBudgetCallback(() => this.maintenance.enforceDiskBudget());
      this.operationalStore = new (await import("./operational-memory-store.js")).OperationalMemoryStore(this.db);
      const { OperationalMemoryService } = await import("./operational-memory-service.js");
      this.operationalService = new OperationalMemoryService(this.operationalStore);
      this.operationalApi = this.operationalService;

      // #173 — create the configured embedding provider. Boot-time dimension
      // assertion catches "user switched providers without running embed --reset".
      this.embeddingProvider = createEmbeddingProvider();
      try {
        this.assertEmbeddingDimensionsMatch(this.db, this.embeddingProvider);
      } catch (dimErr) {
        logWarn(TAG, `Embedding dimension issue (non-fatal): ${dimErr instanceof Error ? dimErr.message : String(dimErr)}`);
      }

      // Ollama embedding health check (skip for CLI tools that just need DB access)
      // Only runs for ollama provider — openai has no equivalent free health endpoint.
      if (!opts?.skipEmbeddingCheck) {
        const embedConfig = loadEmbedConfig();
        if (embedConfig.enabled && getAbmindEnv().embeddingProvider === "ollama") {
          const { checkEmbeddingHealth } = await import("./embedding-health.js");
          const health = await checkEmbeddingHealth(embedConfig.url, embedConfig.model);
          if (health.reachable && health.modelPulled) {
            logInfo(TAG, `Embedding enabled: ${embedConfig.model} via ollama (${this.embeddingProvider?.dimensions} dims)`);
          } else if (health.reachable) {
            logWarn(TAG, `Embedding model '${embedConfig.model}' not found in ollama (available: ${health.modelsAvailable.join(", ")})`);
          } else {
            logWarn(TAG, `Ollama unreachable at ${embedConfig.url} — embeddings disabled`);
          }
        } else if (embedConfig.enabled) {
          // openai / compatible — just log without health-probing (no standard endpoint)
          logInfo(TAG, `Embedding enabled: ${embedConfig.model} via ${getAbmindEnv().embeddingProvider} (${this.embeddingProvider?.dimensions} dims)`);
        }
      }

      logInfo(TAG, "Memory manager initialized");
      this.maintenance.enforceDiskBudget();
    } catch (err) {
      logError(TAG, "Failed to initialize memory manager", err);
      // #1371: reset ALL partial state and rethrow — a half-initialized
      // manager with stale service references must not masquerade as usable.
      try { this.db?.close(); } catch { /* ignore close error */ }
      this.db = null;
      this.memoryIndex = null;
      this.embeddingProvider = null;
      // Reset service references so guard checks (!this.store etc.) fail closed.
      (this as unknown as Record<string, undefined>).store = undefined;
      (this as unknown as Record<string, undefined>).editor = undefined;
      (this as unknown as Record<string, undefined>).maintenance = undefined;
      this.operationalStore = null;
      this.operationalService = null;
      this.operationalApi = null;
      throw err;
    }
  }

  // --- Delegated methods (kept for backward compat during migration) ---

  /**
   * Record a conversation message. Returns the inserted SQLite ID on success,
   * or `null` for every no-write path (memory disabled, store unavailable,
   * store-internal filter/rejection/error). See MessageStore.recordMessage.
   */
  recordMessage(...args: Parameters<MessageStore["recordMessage"]>): number | null {
    if (!this.config.memoryEnabled) { logWarn(TAG, "recordMessage skipped — memoryEnabled=false"); return null; }
    if (!this.store) { logError(TAG, "recordMessage FAILED — store is null (FTS init failed?). Messages are being LOST."); return null; }
    return this.store.recordMessage(...args);
  }

  /** Get recent conversation turns for hydration (oldest first). */
  getRecentConversation(userId: string, since: number, limit: number): Array<{ role: string; content: string; timestamp: number }> {
    if (!this.config.memoryEnabled || !this.store) return [];
    this.requirePersonalHydration();
    return this.store.getRecentConversation(userId, since, limit);
  }

  /** Load recent messages. Delegates to store. */
  loadRecentMessages(userId: string, sessionId: string, count: number): import("./mem-types.js").MessageRecord[] {
    if (!this.config.memoryEnabled || !this.store) return [];
    this.requirePersonalHydration();
    return this.store.loadRecentMessages(userId, sessionId, count);
  }

  /** Search via FTS5. */
  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    if (!this.config.memoryEnabled || !this.memoryIndex) return [];
    try { return this.memoryIndex.search(query, opts); }
    catch (err) { logError(TAG, "Search failed", err); return []; }
  }

  /** Substring search via LIKE. */
  substringSearch(query: string, opts?: SearchOptions): SearchResult[] {
    if (!this.config.memoryEnabled || !this.memoryIndex) return [];
    try { return this.memoryIndex.substringSearch(query, opts); }
    catch (err) { logError(TAG, "Substring search failed", err); return []; }
  }

  /** Timestamp of the most recent message. */
  getLastMessageTimestamp(excludeSystem = false, sessionTypeFilter?: string): number {
    return this.store?.getLastMessageTimestamp(excludeSystem, sessionTypeFilter) ?? 0;
  }

  /** Read user profile + agent notes from core/. The notes portion is
   *  bounded by the #1859 8 KiB session budget with a visible omission
   *  marker; the file itself is never modified here. */
  readCoreKnowledge(): string {
    if (!this.config.memoryEnabled) return "";
    this.requirePersonalHydration();
    const parts: string[] = [];
    for (const file of ["user_profile.md", "agent_notes.md"]) {
      try {
        const filePath = join(this.config.memoryDir, "core", file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, "utf-8").trim();
          if (!content) continue;
          if (file === "agent_notes.md") {
            const view = applyNotesReadBudget(content);
            if (view.truncated) {
              logWarn(TAG, `agent_notes.md over session budget (${view.totalBytes} bytes > ${AGENT_NOTES_BUDGET_BYTES}) — injecting bounded excerpt with omission marker`);
            }
            parts.push(view.text);
          } else {
            parts.push(content);
          }
        }
      } catch (err) { logError(TAG, `Failed to read core/${file}`, err); }
    }
    return parts.join("\n\n");
  }

  /** Read all 5 session bundle files from core/. Single file-read owner
   *  (#1869): truthful always, never suppressed — operator views and the
   *  model-bound composition both start here. */
  getSessionBundle(): { soul: string; profile: string; notes: string; memoryTools: string; coreFacts: string } {
    return readCoreParts(this.config.memoryDir);
  }

  /**
   * Model-bound view of the core parts (#1869). Under `MEMORY_TEST=ON` every
   * memory-derived part is empty except `memoryTools`. Harnesses assembling a
   * prompt consume this, never the raw files. #1859: the notes part is
   * bounded by the 8 KiB session budget with a visible omission marker.
   */
  getSessionParts(): CoreParts {
    this.requirePersonalHydration();
    const parts = readCoreParts(this.config.memoryDir);
    if (isMemoryTestMode()) return suppressCoreParts(parts);
    const view = applyNotesReadBudget(parts.notes);
    if (view.truncated) {
      logWarn(TAG, `agent_notes.md over session budget (${view.totalBytes} bytes > ${AGENT_NOTES_BUDGET_BYTES}) — injecting bounded excerpt with omission marker`);
    }
    return { ...parts, notes: view.text };
  }

  getStats(userId?: string): {
    totalMessages: number; extractedMemories: number; extractedByType: Record<string, number>;
    consolidationFiles: { daily: number; weekly: number; quarterly: number };
    ingestedDocuments: number; preservedKeywords: number; dbSizeBytes: number;
    rejectedByScanner: number;
  } | null {
    if (!this.db) return null;
    try {
      const cw = userId !== undefined ? " WHERE user_id = ?" : "";
      const cp = userId !== undefined ? [userId] : [];

      const totalMessages = (this.db.prepare(`SELECT COUNT(*) as cnt FROM messages${cw}`).get(...cp) as { cnt: number }).cnt;
      const extractedMemories = (this.db.prepare(`SELECT COUNT(*) as cnt FROM extracted_memories${cw}`).get(...cp) as { cnt: number }).cnt;

      const typeRows = this.db.prepare(`SELECT memory_type, COUNT(*) as cnt FROM extracted_memories${cw} GROUP BY memory_type`).all(...cp) as Array<{ memory_type: string; cnt: number }>;
      const extractedByType: Record<string, number> = {};
      for (const row of typeRows) extractedByType[row.memory_type] = row.cnt;

      const consolidationFiles = { daily: 0, weekly: 0, quarterly: 0 };
      for (const tier of ["daily", "weekly", "quarterly"] as const) {
        try { consolidationFiles[tier] = readdirSync(join(this.config.memoryDir, tier)).filter(f => f.endsWith(".md")).length; } catch { /* */ }
      }

      const ingestedDocuments = (this.db.prepare(`SELECT COUNT(*) as cnt FROM ingested_documents${cw}`).get(...cp) as { cnt: number }).cnt;
      const preservedKeywords = (this.db.prepare(
        `SELECT COUNT(*) as cnt FROM extracted_memories${userId !== undefined ? " WHERE user_id = ? AND preserve_original = 1" : " WHERE preserve_original = 1"}`,
      ).get(...cp) as { cnt: number }).cnt;

      let dbSizeBytes = 0;
      try {
        const pageCount = (this.db.pragma("page_count") as Array<{ page_count: number }>)[0]?.page_count ?? 0;
        const pageSize = (this.db.pragma("page_size") as Array<{ page_size: number }>)[0]?.page_size ?? 4096;
        dbSizeBytes = pageCount * pageSize;
      } catch { /* */ }

      return { totalMessages, extractedMemories, extractedByType, consolidationFiles, ingestedDocuments, preservedKeywords, dbSizeBytes, rejectedByScanner: this.store?.rejectedByScanner ?? 0 };
    } catch (err) {
      logError(TAG, "Failed to get stats", err);
      return null;
    }
  }

  close(): void {
    try {
      this.operationalService?.close();
      this.db?.close();
      logInfo(TAG, "Memory manager closed");
    } catch (err) {
      logError(TAG, "Failed to close database", err);
    } finally {
      this.db = null;
      this.operationalStore = null;
      this.operationalService = null;
      this.operationalApi = null;
    }
  }

  // ── Sleep data access ───────────────────────────────────────────────────

  getSleepData(): import("./sleep-data-access.js").SleepDataAccess {
    if (!this.db) throw new Error("Database not initialized");

    return new SleepDataAccess(this.db, this.ownerSnapshot);
  }

  // ── Dashboard / recall ──────────────────────────────────────────────────

  getDistinctUserIds(): string[] {
    return this.store?.getDistinctUserIds() ?? [];
  }

  async recall(
    request: import("./owned-recall-contract.js").OwnedRecallRequest,
    opts?: import("./owned-recall.js").OwnedRecallOptions,
  ): Promise<import("./owned-recall-contract.js").OwnedRecallPacket> {
    if (!this.db || !this.memoryIndex) throw new Error("Memory not initialized");
    requirePersonalRoute(this.db, "recall");
    const { ownedRecall } = await import("./owned-recall.js");
    return ownedRecall(this, request, opts);
  }

  // ── Maintenance methods (for sleep addon / external tools) ──────────────

  buildWakeUp(userId: string, maxChars?: number, opts?: { suppressFlashback?: boolean }): string {
    this.requirePersonalHydration();
    return buildWakeUp(this.db, userId, maxChars, opts);
  }

  private requirePersonalHydration(): void {
    if (!this.db) return;
    requirePersonalRoute(this.db, "hydration");
    if (this.db.prepare("SELECT 1 FROM forget_operations WHERE state = 'pending' LIMIT 1").get()) throw new Error("personal hydration refused: forgetting cleanup pending");
  }

  runWalCheckpoint(): boolean {
    if (!this.db) return false;
    try { this.db.pragma("wal_checkpoint(TRUNCATE)"); return true; } catch { return false; }
  }

  rebuildFtsIndexes(): { rebuilt: string[] } {
    if (!this.db) return { rebuilt: [] };
    const rebuilt: string[] = [];
    for (const table of ["extracted_memories_fts", "content_en_trigram", "content_original_trigram"]) {
      try { this.db.exec(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`); }
      catch {
        try { this.db.exec(`INSERT INTO ${table}(${table}) VALUES('rebuild')`); rebuilt.push(table); }
        catch { /* table may not exist */ }
      }
    }
    return { rebuilt };
  }

  cleanupOldMessages(opts: { maxCount: number; maxAgeDays: number; garbageHours: number; targetExchanges?: number }): { deleted: number } {
    if (!this.db) return { deleted: 0 };
    // #1930 C3: every automatic deletion route enforces the single
    // coverage/evidence-aware owner predicate. Fail-closed until verified
    // readiness; otherwise only exchange-prunable rows are deleted. The old
    // unconditional age/count sweep is retired.
    try {
      if (!isPersonalReady(this.db)) return { deleted: 0 };
    } catch {
      return { deleted: 0 };
    }
    let deleted = 0;
    try {
      void opts.maxCount;
      void opts.maxAgeDays;
      for (const principal of listPersonalPrincipals(this.db)) {
        const { messageIds } = selectPrunableMessageIds(this.db, principal, { targetExchanges: opts.targetExchanges });
        if (messageIds.length === 0) continue;
        const placeholders = messageIds.map(() => "?").join(",");
        deleted += this.db.prepare(`DELETE FROM messages WHERE id IN (${placeholders}) AND user_id = ?`).run(...messageIds, principal).changes;
      }
    } catch { /* retain on error */ }
    return { deleted };
  }

  /**
   * #173 — boot-time dimension assertion. Refuses to start the memory manager
   * if the DB contains embeddings of a different dimension than the configured
   * provider. Prevents silent recall degradation on provider switches.
   */
  private assertEmbeddingDimensionsMatch(db: Database.Database, provider: IEmbeddingProvider): void {
    const row = db.prepare("SELECT embedding FROM extracted_memories WHERE embedding IS NOT NULL LIMIT 1").get() as { embedding: Buffer } | undefined;
    if (!row) return; // no embeddings yet — fresh install or nothing embedded, no mismatch possible
    const dbDims = row.embedding.byteLength / 4; // Float32 = 4 bytes per component
    if (dbDims !== provider.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: DB has ${dbDims}-dim vectors, ` +
        `provider '${provider.name}' configured for ${provider.dimensions}-dim ` +
        `(EMBEDDING_DIMENSIONS=${provider.dimensions}). ` +
        `Stored embeddings are frozen legacy data; reconfigure the provider to match.`
      );
    }
  }

  deduplicateMessages(): { removed: number } {
    if (!this.db) return { removed: 0 };
    try {
      const dupes = this.db.prepare(`
        SELECT b.id FROM messages a JOIN messages b
        ON a.user_id = b.user_id AND a.role = b.role
        AND TRIM(a.content) = TRIM(b.content)
        AND b.id > a.id
        AND NOT EXISTS (
          SELECT 1 FROM messages m WHERE m.user_id = a.user_id AND m.id > a.id AND m.id < b.id AND m.role = a.role
        )
      `).all() as Array<{ id: number }>;
      if (dupes.length > 0) {
        this.db.prepare(`DELETE FROM messages WHERE id IN (${dupes.map(d => d.id).join(",")})`).run();
        return { removed: dupes.length };
      }
    } catch { /* */ }
    return { removed: 0 };
  }
}

/**
 * #1448: Package-internal access to the underlying SQLite handle.
 *
 * The public surface (index.ts / IMemorySystem) never exposes raw database
 * handles — the legacy public getDatabase()/getDb() accessors were removed.
 * This module-level accessor is for abmind-internal consumers only: it is not
 * re-exported from index.ts and the package `exports` map blocks deep imports,
 * so external packages cannot reach it. Ordinary TS private is compile-time
 * only — this is API encapsulation, not a security boundary.
 */
export function getMemoryDb(manager: MemoryManager): Database.Database | null {
  return (manager as unknown as { db: Database.Database | null }).db;
}

/**
 * #1928: Package-internal access to the configured memory directory.
 *
 * Same encapsulation as getMemoryDb: abmind-internal only, never
 * re-exported from index.ts. The owned S6 summary search needs the
 * on-disk summary roots.
 */
export function getMemoryDir(manager: MemoryManager): string | null {
  return (manager as unknown as { config?: { memoryDir?: string } }).config?.memoryDir ?? null;
}
