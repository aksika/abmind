import { mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { MessageStore } from "./message-store.js";
import { MemoryEditor } from "./memory-editor.js";
import { MaintenanceService } from "./maintenance-service.js";
import { loadEmbedConfig, initVec, backfillVecIndex, vecInsert } from "./ollama-embed.js";
import { createEmbeddingProvider, type IEmbeddingProvider } from "./embedding-provider.js";
import { getAbmindEnv } from "./env-schema.js";

import type { SearchResult, SearchOptions } from "./mem-types.js";
import type { IOperationalMemoryCore } from "./imemory-system.js";
import { logError, logInfo, logWarn } from "./mem-logger.js";
import { SleepDataAccess } from "./sleep-data-access.js";
import { buildWakeUp } from "./wake-up-builder.js";
import { isFlashbulb } from "./brain-patterns.js";
import { quantizeToInt8 } from "./embedding-quantize.js";

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

  constructor(config: MemoryConfig) {
    this.config = config;
  }

  /** @internal Package-internal only. External consumers use IMemorySystem methods. */
  getMemoryIndex(): MemoryIndex | null { return this.memoryIndex; }
  getConfig(): MemoryConfig { return this.config; }

  /** The active embedding provider (null if memory disabled or not yet initialized). */
  getEmbeddingProvider(): IEmbeddingProvider | null { return this.embeddingProvider; }

  async initialize(opts?: { skipEmbeddingCheck?: boolean }): Promise<void> {
    if (!this.config.memoryEnabled) return;

    try {
      mkdirSync(this.config.memoryDir, { recursive: true });

      const dbPath = join(this.config.memoryDir, "memory.db");
      this.db = initializeDatabase(dbPath);
      this.runWalCheckpoint(); // flush pending WAL from previous crash

      // #427 — seed missing core files + run schema migrations
      const { ensureInitialized } = await import("./ensure-initialized.js");
      ensureInitialized(this.db, this.config.memoryDir);


      this.memoryIndex = new MemoryIndex(this.db);

      // Wire sub-services FIRST — message recording must not be blocked by embedding failures (#860)
      this.editor = new MemoryEditor(this.db);
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

      // #360 — sqlite-vec virtual table sized to the configured dimensions.
      try {
        initVec(this.db, this.embeddingProvider.dimensions);
        const backfilled = backfillVecIndex(this.db);
        if (backfilled > 0) logInfo(TAG, `Vec index backfilled: ${backfilled} embeddings`);
      } catch (vecErr) {
        logWarn(TAG, `Vec init/backfill failed (non-fatal): ${vecErr instanceof Error ? vecErr.message : String(vecErr)}`);
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
    return this.store.getRecentConversation(userId, since, limit);
  }

  /** Load recent messages. Delegates to store. */
  loadRecentMessages(userId: string, sessionId: string, count: number): import("./mem-types.js").MessageRecord[] {
    if (!this.config.memoryEnabled || !this.store) return [];
    return this.store.loadRecentMessages(userId, sessionId, count);
  }

  /** Update emotion by platform message ID. Delegates to store + editor. */
  updateEmotionByPlatformId(userId: string | string, platformMessageId: number | string, score: number, tag?: string): boolean {
    if (!this.store) return false;
    return this.store.updateEmotionByPlatformId(userId, platformMessageId, score, (p) => this.editor.editMemory(p), tag);
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

  /** Read user profile + agent notes from core/. */
  readCoreKnowledge(): string {
    if (!this.config.memoryEnabled) return "";
    const parts: string[] = [];
    for (const file of ["user_profile.md", "agent_notes.md"]) {
      try {
        const filePath = join(this.config.memoryDir, "core", file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, "utf-8").trim();
          if (content) parts.push(content);
        }
      } catch (err) { logError(TAG, `Failed to read core/${file}`, err); }
    }
    return parts.join("\n\n");
  }

  /** Read all 4 session bundle files from core/. */
  getSessionBundle(): { soul: string; profile: string; notes: string; memoryTools: string; coreFacts: string } {
    const coreDir = join(this.config.memoryDir, "core");
    const read = (name: string): string => {
      try {
        const p = join(coreDir, name);
        return existsSync(p) ? readFileSync(p, "utf-8").trim() : "";
      } catch { return ""; }
    };
    return { soul: read("SOUL.md"), profile: read("user_profile.md"), notes: read("agent_notes.md"), memoryTools: read("memory-tools.md"), coreFacts: read("core_facts.md") };
  }

  /** Get emotional arcs for session-start injection. Returns topics with their trajectory. */
  getEmotionalArcs(): Array<{ topic: string; arc: string }> {
    if (!this.db) return [];
    try {
      const rows = this.db.prepare(
        "SELECT topic, emotion_arc FROM extracted_memories WHERE emotion_arc IS NOT NULL AND emotion_arc != '' AND emotion_arc != '—' AND valid_to IS NULL GROUP BY topic ORDER BY created_at DESC LIMIT 10",
      ).all() as Array<{ topic: string; emotion_arc: string }>;
      return rows.map(r => ({ topic: r.topic, arc: r.emotion_arc }));
    } catch { return []; }
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
    
    return new SleepDataAccess(this.db);
  }

  // ── Dashboard / recall ──────────────────────────────────────────────────

  getDistinctUserIds(): string[] {
    return this.store?.getDistinctUserIds() ?? [];
  }

  getAllExtractedMemories(): unknown[] {
    return this.store?.getAllExtractedMemories() ?? [];
  }

  async recallSearch(params: import("./recall-engine.js").RecallParams): Promise<import("./recall-engine.js").RecallResult> {
    if (!this.db || !this.memoryIndex) throw new Error("Memory not initialized");
    const { recallSearch } = await import("./recall-engine.js");
    const deps: import("./recall-engine.js").RecallDeps = {
      db: this.db,
      index: this.memoryIndex,
      memoryDir: this.config.memoryDir,
    };
    if (this.embeddingProvider) deps.embeddingProvider = this.embeddingProvider;
    return recallSearch(deps, params);
  }

  bumpRecallCount(ids: number[]): void {
    this.memoryIndex?.bumpRecallCount(ids);
  }

  bumpCitedCount(ids: number[]): void {
    this.memoryIndex?.bumpCitedCount(ids);
  }

  bumpRejectedCount(ids: number[]): void {
    this.memoryIndex?.bumpRejectedCount(ids);
  }

  /** Principal-bound feedback guard used by the V1 service before mutation. */
  hasExtractedMemoryForUser(memoryId: number, userId: string): boolean {
    if (!this.db) return false;
    try {
      return Boolean(this.db.prepare("SELECT 1 FROM extracted_memories WHERE id = ? AND user_id = ? LIMIT 1").get(memoryId, userId));
    } catch { return false; }
  }

  // ── Maintenance methods (for sleep addon / external tools) ──────────────

  buildWakeUp(maxChars?: number): string {
    return buildWakeUp(this.db, maxChars);
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

  cleanupOldMessages(opts: { maxCount: number; maxAgeDays: number; garbageHours: number }): { deleted: number } {
    if (!this.db) return { deleted: 0 };
    let deleted = 0;
    try {
      // Age-based cleanup
      const ageCutoff = Date.now() - opts.maxAgeDays * 86400000;
      deleted += this.db.prepare("DELETE FROM messages WHERE timestamp < ?").run(ageCutoff).changes;
      // Count-based cleanup (keep newest maxCount)
      const excess = this.db.prepare("SELECT id FROM messages ORDER BY timestamp DESC LIMIT -1 OFFSET ?").all(opts.maxCount) as Array<{ id: number }>;
      if (excess.length > 0) {
        deleted += this.db.prepare(`DELETE FROM messages WHERE id IN (${excess.map(r => r.id).join(",")})`).run().changes;
      }
    } catch { /* */ }
    return { deleted };
  }

  /**
   * #173 — backfill embeddings for memories that lack them.
   * Uses provider.batchEmbed() for efficiency (OpenAI batches 100/call).
   * Also populates the vec_memories index via vecInsert.
   */
  async backfillEmbeddings(provider: IEmbeddingProvider): Promise<{ embedded: number }> {
    if (!this.db) return { embedded: 0 };
    const rows = this.db.prepare("SELECT id, user_id, semantic_revision, content_en FROM extracted_memories WHERE embedding IS NULL").all() as Array<{ id: number; user_id: string; semantic_revision: number; content_en: string }>;
    if (rows.length === 0) return { embedded: 0 };

    const vectors = await provider.batchEmbed(rows.map(r => r.content_en));
    const update = this.db.prepare("UPDATE extracted_memories SET embedding = ? WHERE id = ? AND user_id = ? AND semantic_revision = ?");
    let embedded = 0;
    for (let i = 0; i < rows.length; i++) {
      const vec = vectors[i];
      if (vec) {
        const buf = Buffer.from(vec.buffer);
        update.run(buf, rows[i]!.id, rows[i]!.user_id, rows[i]!.semantic_revision);
        vecInsert(this.db, rows[i]!.id, buf);
        embedded++;
      }
    }
    return { embedded };
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
        `Run 'abmind embed --reset' to drop all embeddings and re-embed with the new provider.`
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

  /** Age memory tiers: NULL English after englishTtlDays, NULL original after originalTtlDays. */
  ageMemoryTiers(opts: { englishTtlDays: number; originalTtlDays: number; embeddingQuantizeDays?: number }): { englishNulled: number; originalNulled: number; embeddingsQuantized: number } {
    if (!this.db) return { englishNulled: 0, originalNulled: 0, embeddingsQuantized: 0 };
    

    // content_en preserved forever — trigram search depends on it
    const englishNulled = 0;
    let originalNulled = 0;
    let embeddingsQuantized = 0;
    const originalCutoff = Date.now() - opts.originalTtlDays * 86400000;

    // Age Original (content_original) — only flashbulb protected
    const origRows = this.db.prepare(
      "SELECT id, user_id, semantic_revision, emotion_score, importance_flags FROM extracted_memories WHERE content_original IS NOT NULL AND content_en IS NOT NULL AND created_at < ?",
    ).all(originalCutoff) as Array<{ id: number; user_id: string; semantic_revision: number; emotion_score: number; importance_flags: string | null }>;
    for (const r of origRows) {
      if (isFlashbulb(r.emotion_score, r.importance_flags ?? "")) continue;
      const result = this.editor.getMutationStore().edit(
        { userId: r.user_id, actorId: "maintenance:age-original", operationKey: `age-original-${r.id}-${r.semantic_revision}`, canDeclassifySecret: false, origin: "internal" },
        { userId: r.user_id, memoryId: r.id, expectedRevision: r.semantic_revision, clearContentOriginal: true },
      );
      if (result.ok) originalNulled++;
    }

    return { englishNulled, originalNulled, embeddingsQuantized: 0 };
  }

  /** Compute decayed confidence for all memories. Returns candidates for pruning (effective confidence < 1). */
  async computeDecayedConfidence(): Promise<Array<{ id: number; confidence: number; effectiveConfidence: number; recallCount: number; daysSinceRecall: number }>> {
    if (!this.db) return [];
    const { effectiveConfidence } = await import("./brain-patterns.js");
    const now = Date.now();
    const rows = this.db.prepare(
      `SELECT id, confidence, recall_count, last_recalled_at, created_at, memory_type FROM extracted_memories WHERE valid_to IS NULL`,
    ).all() as Array<{ id: number; confidence: number; recall_count: number; last_recalled_at: number | null; created_at: number; memory_type: string | null }>;

    const candidates: Array<{ id: number; confidence: number; effectiveConfidence: number; recallCount: number; daysSinceRecall: number }> = [];
    for (const r of rows) {
      const lastRecall = r.last_recalled_at ?? r.created_at;
      const daysSinceRecall = Math.round((now - lastRecall) / 86400000);
      const eff = effectiveConfidence(r.confidence, daysSinceRecall, r.recall_count, r.memory_type ?? undefined);
      if (eff < 1) {
        candidates.push({ id: r.id, confidence: r.confidence, effectiveConfidence: eff, recallCount: r.recall_count, daysSinceRecall });
      }
    }
    return candidates.sort((a, b) => a.effectiveConfidence - b.effectiveConfidence);
  }

  fixMemoryDefaults(): { fixed: number } {
    if (!this.db) return { fixed: 0 };
    let fixed = 0;
    try {
      const cutoff = Date.now() - 7 * 86400000;
      const rows = this.db.prepare(
        "SELECT id, user_id, semantic_revision, memory_type, trust, classification, credibility, integrity, created_at FROM extracted_memories",
      ).all() as Array<{ id: number; user_id: string; semantic_revision: number; memory_type: string; trust: number; classification: number; credibility: number; integrity: number; created_at: number }>;
      for (const row of rows) {
        const patch: { trust?: number; classification?: number; credibility?: number } = {};
        if (row.memory_type === "decision" && row.trust < 2) patch.trust = 2;
        if (row.memory_type === "decision" && row.classification === 0) patch.classification = 1;
        if (row.trust === 0 && row.credibility === 6 && row.integrity === 2) patch.trust = 2;
        if (row.credibility === 6 && row.created_at < cutoff) patch.credibility = 3;
        if (Object.keys(patch).length === 0) continue;
        const result = this.editor.getMutationStore().edit(
          { userId: row.user_id, actorId: "maintenance:fix-defaults", operationKey: `fix-defaults-${row.id}-${row.semantic_revision}`, canDeclassifySecret: false, origin: "internal" },
          { userId: row.user_id, memoryId: row.id, expectedRevision: row.semantic_revision, ...patch },
        );
        if (result.ok) fixed++;
      }
    } catch { /* */ }
    return { fixed };
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
