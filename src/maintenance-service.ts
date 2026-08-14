import { getAbmindEnv } from "./env-schema.js";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, statSync, readFileSync, readdirSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import type { CascadeDeleteResultV1 } from "./mem-types.js";
import type { MemoryIndex } from "./memory-index.js";
import type { MemoryEditor } from "./memory-editor.js";
import type { MemoryManager } from "./memory-manager.js";
import type { SleepDataAccess } from "./sleep-data-access.js";
import { logError, logInfo, logWarn } from "./mem-logger.js";
import { localDate } from "./mem-env.js";
import { redactSecrets } from "./redact-secrets.js";
import { classifyEmbedding } from "./embedding-integrity.js";

const TAG = "maintenance";
const CASCADE_BATCH_SIZE = 512;

export type PreSleepResults = {
  purged: number; deduped: number; embedded: number; anomaliesFixed: number;
  walOk: boolean; ftsOk: boolean; sleepFilesDeleted: number; darwinismCandidates: number; emotionArcs: number;
};

/** Handles disk budget, backup pruning, auto-compact, and forget operations. */
export class MaintenanceService {
  constructor(
    private readonly db: Database.Database,
    private readonly config: MemoryConfig,
    private readonly memoryIndex: MemoryIndex,
    private readonly editor: MemoryEditor,
    private readonly getEmbeddingDimensions: () => number,
  ) {}

  /** Enforce disk budget by checking DB size against configured limit. */
  enforceDiskBudget(): void {
    try {
      const dbPath = join(this.config.memoryDir, "memory.db");
      if (existsSync(dbPath)) {
        const dbSize = statSync(dbPath).size;
        if (dbSize > this.config.diskBudgetBytes) {
          logWarn(TAG, `DB size ${(dbSize / 1024 / 1024).toFixed(1)}MB exceeds budget ${(this.config.diskBudgetBytes / 1024 / 1024).toFixed(0)}MB`);
        }
      }
    } catch (err) {
      logError(TAG, "Disk budget enforcement failed", err);
    }
  }

  /**
   * Async, library-native memory preflight (#1353). Replaces the old
   * synchronous `execSync("abmind doctor --fix")` subprocess call: nulls out
   * corrupted embedding rows (wrong byte length or NaN) so they get
   * re-embedded on the next backfill pass. Never blocks the host event loop
   * and never shells out. Non-blocking best-effort — a failure here must not
   * stop the sleep cycle.
   */
  async runPreflight(): Promise<{ corruptedEmbeddingsFixed: number }> {
    let corruptedEmbeddingsFixed = 0;
    try {
      const dimensions = this.getEmbeddingDimensions();
      const rows = this.db.prepare(
        "SELECT id, user_id, semantic_revision, length(embedding) as len, embedding FROM extracted_memories WHERE embedding IS NOT NULL LIMIT 200",
      ).all() as Array<{ id: number; user_id: string; semantic_revision: number; len: number; embedding: Buffer }>;
      const corrupted: Array<{ id: number; userId: string; revision: number }> = [];
      for (const r of rows) {
        if (!classifyEmbedding(r.embedding, dimensions).valid) corrupted.push({ id: r.id, userId: r.user_id, revision: r.semantic_revision });
      }
      if (corrupted.length > 0) {
        const stmt = this.db.prepare("UPDATE extracted_memories SET embedding = NULL WHERE id = ? AND user_id = ? AND semantic_revision = ?");
        for (const row of corrupted) stmt.run(row.id, row.userId, row.revision);
        corruptedEmbeddingsFixed = corrupted.length;
        logInfo(TAG, `[PREFLIGHT] Nulled ${corruptedEmbeddingsFixed} corrupted embedding(s) for re-embed`);
      }
    } catch (err) { logWarn(TAG, `[PREFLIGHT] embedding check failed: ${err instanceof Error ? err.message : String(err)}`); }
    return { corruptedEmbeddingsFixed };
  }

  /** Check if context exceeds threshold and write safety-net transcript. */
  async checkAutoCompact(params: {
    userId: string; sessionId: string; contextPercent: number;
    sendCompactCommand: (sessionKey: string, command: string) => Promise<string>;
  }): Promise<void> {
    const threshold = this.config.searchEnhancements.compactThresholdPct;
    if (params.contextPercent < threshold) return;

    logInfo(TAG, `Auto-compact triggered for chat ${params.userId} (context ${params.contextPercent}% >= ${threshold}%)`);

    try {
      const messages = this.db.prepare(
        "SELECT role, content FROM messages WHERE user_id = ? AND session_id = ? ORDER BY timestamp ASC",
      ).all(params.userId, params.sessionId) as Array<{ role: string; content: string }>;

      if (messages.length > 0) {
        const workingDir = join(this.config.memoryDir, "working", localDate());
        mkdirSync(workingDir, { recursive: true });
        const safetyPath = join(workingDir, `transcript_${params.userId}.chat`);
        const rawContent = messages.map(m => `[${m.role}] ${m.content}`).join("\n");
        const safeContent = redactSecrets(rawContent);
        if (existsSync(safetyPath)) appendFileSync(safetyPath, `\n---\n\n${safeContent}`);
        else writeFileSync(safetyPath, safeContent);
        logInfo(TAG, `Safety-net transcript written to ${safetyPath}`);
      }

      await params.sendCompactCommand(params.sessionId, "/compact");
    } catch (err) {
      logError(TAG, `Auto-compact failed for chat ${params.userId}`, err);
    }
  }

  /** Forget all memories semantically related to a topic. */
  async forgetTopic(userId: string, topic: string, threshold?: number): Promise<CascadeDeleteResultV1> {
    const empty: CascadeDeleteResultV1 = { messagesRemoved: 0, linkedMemoriesRemoved: 0, embeddingsRemoved: 0 };
    try {
      const effectiveThreshold = threshold ?? this.config.forgetThreshold;
      const searchResults = this.memoryIndex.search(topic, { userId, limit: 100 });
      const relevant = searchResults.filter(r => r.score >= effectiveThreshold);
      if (relevant.length === 0) return empty;

      const messageIds: number[] = [];
      for (const r of relevant) {
        const row = this.db.prepare(
          "SELECT id FROM messages WHERE user_id = ? AND session_id = ? AND timestamp = ? AND role = ?",
        ).get(r.record.userId, r.record.sessionId, r.record.timestamp, r.record.role) as { id: number } | undefined;
        if (row) messageIds.push(row.id);
      }
      if (messageIds.length === 0) return empty;

      const result = this.cascadeFor(userId, "maintenance:forget-topic", messageIds);
      logInfo(TAG, `forgetTopic: removed ${result.messagesRemoved} messages for topic "${topic}"`);
      return result;
    } catch (err) {
      logError(TAG, `forgetTopic failed for chat ${userId}`, err);
      throw err;
    }
  }

  /** Forget all memories within a date range. */
  forgetRange(userId: string, startDate: Date, endDate: Date): CascadeDeleteResultV1 {
    const empty: CascadeDeleteResultV1 = { messagesRemoved: 0, linkedMemoriesRemoved: 0, embeddingsRemoved: 0 };
    try {
      const rows = this.db.prepare(
        "SELECT id FROM messages WHERE user_id = ? AND timestamp >= ? AND timestamp <= ?",
      ).all(userId, startDate.getTime(), endDate.getTime()) as Array<{ id: number }>;
      if (rows.length === 0) return empty;
      return this.cascadeFor(userId, "maintenance:forget-range", rows.map(r => r.id));
    } catch (err) {
      logError(TAG, `forgetRange failed for chat ${userId}`, err);
      throw err;
    }
  }

  /** Forget all memories for a specific session. */
  forgetSession(userId: string, sessionId: string): CascadeDeleteResultV1 {
    const empty: CascadeDeleteResultV1 = { messagesRemoved: 0, linkedMemoriesRemoved: 0, embeddingsRemoved: 0 };
    try {
      const rows = this.db.prepare(
        "SELECT id FROM messages WHERE user_id = ? AND session_id = ?",
      ).all(userId, sessionId) as Array<{ id: number }>;
      if (rows.length === 0) return empty;
      return this.cascadeFor(userId, "maintenance:forget-session", rows.map(r => r.id));
    } catch (err) {
      logError(TAG, `forgetSession failed for chat ${userId}`, err);
      throw err;
    }
  }

  /** Shared owner-scoped cascade through the revision-safe mutation store. */
  private cascadeFor(userId: string, operationKey: string, messageIds: number[]): CascadeDeleteResultV1 {
    const store = this.editor.getMutationStore();
    const context = { userId, actorId: "maintenance", operationKey, canDeclassifySecret: false, origin: "internal" as const };
    const transaction = this.db.transaction(() => {
      const total: CascadeDeleteResultV1 = { messagesRemoved: 0, linkedMemoriesRemoved: 0, embeddingsRemoved: 0 };
      for (let offset = 0; offset < messageIds.length; offset += CASCADE_BATCH_SIZE) {
        const result = store.cascadeDelete(context, {
          userId,
          messageIds: messageIds.slice(offset, offset + CASCADE_BATCH_SIZE),
        });
        total.messagesRemoved += result.messagesRemoved;
        total.linkedMemoriesRemoved += result.linkedMemoriesRemoved;
        total.embeddingsRemoved += result.embeddingsRemoved;
      }
      return total;
    });
    return transaction();
  }

  /** Run SQLite integrity check (B-tree + FTS5). Returns "ok" or error description. */
  checkIntegrity(): string {
    try {
      const result = this.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
      const btree = result?.integrity_check ?? "unknown";
      if (btree !== "ok") return btree;
      // FTS5 internal checksums (PRAGMA misses these)
      for (const t of ["extracted_memories_fts", "content_en_trigram", "content_original_trigram"]) {
        try { this.db.exec(`INSERT INTO ${t}(${t}) VALUES('integrity-check')`); }
        catch (e) { return `fts5: ${e instanceof Error ? e.message : "corrupt"} for table "${t}"`; }
      }
      return "ok";
    } catch (e) {
      return e instanceof Error ? e.message : "error";
    }
  }

  /** Pre-sleep housekeeping — memory-side tasks. Returns results summary. */
  async runPreSleepTasks(memory: MemoryManager, sleepData: SleepDataAccess, primaryUserId: string): Promise<PreSleepResults> {
    const memoryDir = this.config.memoryDir;
    const r: PreSleepResults = { purged: 0, deduped: 0, embedded: 0, anomaliesFixed: 0, walOk: false, ftsOk: false, sleepFilesDeleted: 0, darwinismCandidates: 0, emotionArcs: 0 };

    // 1. Purge expired garbage
    try {
      const garbagePath = join(memoryDir, "garbage.json");
      if (existsSync(garbagePath)) {
        const garbage = JSON.parse(readFileSync(garbagePath, "utf-8")) as Record<string, string>;
        const cutoff = Date.now() - 7 * 86400000;
        const expired = Object.entries(garbage).filter(([, ts]) => new Date(ts).getTime() < cutoff);
        if (expired.length > 0) {
          const ids = expired.map(([id]) => parseInt(id, 10)).filter(n => Number.isFinite(n));
          if (ids.length > 0) sleepData.deleteMessagesByIds(ids);
          for (const [id] of expired) delete garbage[id];
          writeFileSync(garbagePath, JSON.stringify(garbage));
          r.purged = expired.length;
        }
      }
    } catch (err) { logWarn(TAG, `[PRE-SLEEP] garbage purge: ${err instanceof Error ? err.message : String(err)}`); }

    // 2. Dedup consecutive exact messages
    try { r.deduped = memory.deduplicateMessages().removed; } catch (err) { logWarn(TAG, `[PRE-SLEEP] dedup: ${err instanceof Error ? err.message : String(err)}`); }

    // 3. WAL checkpoint
    r.walOk = memory.runWalCheckpoint();

    // 4. FTS rebuild if corrupt
    try { const { rebuilt } = memory.rebuildFtsIndexes(); r.ftsOk = true; for (const t of rebuilt) logInfo(TAG, `[PRE-SLEEP] Rebuilt FTS: ${t}`); } catch (err) { logWarn(TAG, `[PRE-SLEEP] FTS: ${err instanceof Error ? err.message : String(err)}`); }

    // 5. Batch embed NULL embeddings
    try {
      if (getAbmindEnv().embeddingEnabled) {
        const provider = memory.getEmbeddingProvider();
        if (provider) r.embedded = (await memory.backfillEmbeddings(provider)).embedded;
      }
    } catch (err) { logWarn(TAG, `[PRE-SLEEP] embed: ${err instanceof Error ? err.message : String(err)}`); }

    // 6. Anomaly auto-fixes
    try { r.anomaliesFixed = memory.fixMemoryDefaults().fixed; } catch (err) { logWarn(TAG, `[PRE-SLEEP] anomalies: ${err instanceof Error ? err.message : String(err)}`); }

    // 7. Delete old sleep files (locks + step logs > 3 days)
    try {
      const sleepDir = join(memoryDir, "sleep");
      if (existsSync(sleepDir)) {
        const cutoff = Date.now() - 3 * 86400000;
        for (const f of readdirSync(sleepDir)) {
          const match = f.match(/^(?:sleep_)?(\d{4})(\d{2})(\d{2})/);
          if (!match) continue;
          if (new Date(`${match[1]}-${match[2]}-${match[3]}`).getTime() >= cutoff) continue;
          const fullPath = join(sleepDir, f);
          const stat = statSync(fullPath);
          if (stat.isDirectory()) { rmSync(fullPath, { recursive: true, force: true }); r.sleepFilesDeleted++; }
          else if (f.endsWith(".lock")) { unlinkSync(fullPath); r.sleepFilesDeleted++; }
        }
      }
    } catch (err) { logWarn(TAG, `[PRE-SLEEP] sleep cleanup: ${err instanceof Error ? err.message : String(err)}`); }

    // 8. Darwinism candidates
    try {
      const candidates = await memory.computeDecayedConfidence();
      if (candidates.length > 0) {
        writeFileSync(join(memoryDir, "sleep", "darwinism-candidates.json"), JSON.stringify(candidates, null, 2));
        r.darwinismCandidates = candidates.length;
      }
    } catch (err) { logWarn(TAG, `[PRE-SLEEP] darwinism: ${err instanceof Error ? err.message : String(err)}`); }

    // 9. Emotion arcs
    try { const n = sleepData.buildEmotionArcs(); r.emotionArcs = n; } catch (err) { logWarn(TAG, `[PRE-SLEEP] emotion arcs: ${err instanceof Error ? err.message : String(err)}`); }

    // 10. Emotional profile → user_profile.md (strict-owner: primary user only)
    try {
      const entries = sleepData.getEmotionalProfileData(primaryUserId);
      if (entries.length > 0) {
        const lines: string[] = ["## Emotional Patterns (auto-generated)", ""];
        for (const e of entries) {
          const topTags = e.topTags.map((t: { tag: string; count: number }) => `${t.tag}(${t.count})`);
          const ratio = e.positive + e.negative > 0 ? Math.round(e.positive / (e.positive + e.negative) * 100) : 50;
          lines.push(`- **${e.topic}**: ${ratio}% positive. Top: ${topTags.join(", ")}${e.topContexts.length > 0 ? `. Triggers: ${e.topContexts.join(", ")}` : ""}`);
        }
        const profilePath = join(memoryDir, "core", "user_profile.md");
        if (existsSync(profilePath)) {
          let content = readFileSync(profilePath, "utf-8");
          const marker = "## Emotional Patterns (auto-generated)";
          const idx = content.indexOf(marker);
          if (idx >= 0) content = content.slice(0, idx).trimEnd();
          writeFileSync(profilePath, content + "\n\n" + lines.join("\n") + "\n", "utf-8");
        }
      }
    } catch (err) { logWarn(TAG, `[PRE-SLEEP] emotional profile: ${err instanceof Error ? err.message : String(err)}`); }

    // Prune working dirs older than 7 days
    try {
      const workingRoot = join(this.config.memoryDir, "working");
      if (existsSync(workingRoot)) {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        let pruned = 0;
        for (const name of readdirSync(workingRoot)) {
          const ts = new Date(name).getTime();
          if (!isNaN(ts) && ts < cutoff) {
            rmSync(join(workingRoot, name), { recursive: true, force: true });
            pruned++;
          }
        }
        if (pruned > 0) logInfo(TAG, `Pruned ${pruned} working dir(s) older than 7 days`);
      }
    } catch (err) { logWarn(TAG, `[POST-SLEEP] working dir prune: ${err instanceof Error ? err.message : String(err)}`); }

    return r;
  }
}
