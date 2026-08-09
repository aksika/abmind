import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import type { IMemorySystem } from "./imemory-system.js";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { localISO } from "./local-time.js";
import { logInfo, logWarn, logError } from "./mem-logger.js";

const TAG = "sleep-state-gatherer";

export interface WorkingDirEntry {
  date: string; // YYYY-MM-DD
  path: string; // full path
  files: Array<{
    name: string;
    sizeBytes: number;
  }>;
}

export interface DbStats {
  messageCount: number;
  messagesSinceLastSleep: number;
  embeddingCount: number;
  nullEmbeddingCount: number;
  extractedMemoryCount: number;
  compressionRatio: number;
  darwinism: {
    avgRecallCount: number;
    avgRelevanceScore: number;
    neverRecalled: number;
    recalledLast30d: number;
  };
}

export interface Fts5Health {
  messages_fts: "ok" | "corrupt" | "dropped";
  extracted_memories_fts: "ok" | "corrupt";
  extracted_memories_original_fts: "ok" | "corrupt" | "dropped";
}

export interface TopicFileEntry {
  name: string;
  sizeBytes: number;
  lastModified: string; // ISO 8601
}

export interface StateSnapshot {
  timestamp: string; // ISO 8601
  workingDirs: WorkingDirEntry[];
  dbStats: DbStats;
  fts5Health: Fts5Health;
  diskUsageBytes: number;
  diskBudgetBytes: number;
  topicFiles: TopicFileEntry[];
  lastSleepAudit: string | null;
  lastSleepTimestamp: number | null;
  wakeupDate: string | null;
  todoContents: string | null;
  cronContents: string | null;
}

export class SleepStateGatherer {
  private db: Database.Database;
  private cronContentsFn: (() => string | null) | null;
  constructor(
    memory: IMemorySystem,
    private config: MemoryConfig,
    cronContentsFn?: () => string | null,
  ) {
    this.db = memory.getSleepData().getDb();
    this.cronContentsFn = cronContentsFn ?? null;
  }

  /**
   * #1608: `userId` scopes the no-work message count to the primary user so
   * the guard matches the retrospective/daily-summary user filters. When
   * omitted, the count stays user-agnostic (backward-compatible).
   */
  async gather(userId?: string): Promise<StateSnapshot> {
    const timestamp = localISO();
    logInfo(TAG, "Gathering system state snapshot");

    const workingDirs = this.scanWorkingDirs();
    const lastSleepTimestamp = this.getLastSleepTimestamp();
    const dbStats = this.queryDbStats(lastSleepTimestamp, userId);
    const fts5Health = this.checkFts5Health();
    const diskUsageBytes = this.calculateDiskUsage();
    const topicFiles = this.listTopicFiles();

    const snapshot: StateSnapshot = {
      timestamp,
      workingDirs,
      dbStats,
      fts5Health,
      diskUsageBytes,
      diskBudgetBytes: this.config.diskBudgetBytes,
      topicFiles,
      lastSleepAudit: this.getLastSleepAudit(),
      lastSleepTimestamp,
      wakeupDate: this.getWakeupDate(),
      todoContents: this.readFileOrNull(join(dirname(this.config.memoryDir), "memory", "todo.md")),
      cronContents: this.cronContentsFn ? this.cronContentsFn() : null,
    };

    logInfo(
      TAG,
      `State snapshot gathered: ${workingDirs.length} working dirs, ` +
        `${dbStats.messageCount} messages, ${topicFiles.length} topic files, ` +
        `${(diskUsageBytes / 1024 / 1024).toFixed(1)} MB disk usage`,
    );

    return snapshot;
  }

  /** Scan working directories under {memoryDir}/working/ */
  private scanWorkingDirs(): WorkingDirEntry[] {
    const workingRoot = join(this.config.memoryDir, "working");
    if (!existsSync(workingRoot)) {
      logWarn(TAG, `Working directory not found: ${workingRoot}`);
      return [];
    }

    const entries: WorkingDirEntry[] = [];
    try {
      const dirs = readdirSync(workingRoot, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        // Expect YYYY-MM-DD format
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dir.name)) continue;

        const dirPath = join(workingRoot, dir.name);
        const files: WorkingDirEntry["files"] = [];
        try {
          const fileEntries = readdirSync(dirPath, { withFileTypes: true });
          for (const file of fileEntries) {
            if (!file.isFile()) continue;
            try {
              const fileStat = statSync(join(dirPath, file.name));
              files.push({ name: file.name, sizeBytes: fileStat.size });
            } catch (err) {
              logWarn(TAG, `Failed to stat file ${join(dirPath, file.name)}: ${err}`);
            }
          }
        } catch (err) {
          logWarn(TAG, `Failed to read working directory ${dirPath}: ${err}`);
        }

        entries.push({ date: dir.name, path: dirPath, files });
      }
    } catch (err) {
      logWarn(TAG, `Failed to scan working root ${workingRoot}: ${err}`);
    }

    return entries.sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Query DB for aggregate statistics. */
  private queryDbStats(lastSleepTimestamp: number | null, userId?: string): DbStats {
    const count = (table: string): number => {
      try {
        const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number };
        return row.cnt;
      } catch (err) {
        logError(TAG, `Failed to count rows in ${table}`, err);
        throw err;
      }
    };

    const countWhere = (table: string, where: string): number => {
      try {
        const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${where}`).get() as { cnt: number };
        return row.cnt;
      } catch { return 0; }
    };

    const countWhereParams = (table: string, where: string, params: unknown[]): number => {
      try {
        const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${where}`).get(...params) as { cnt: number };
        return row.cnt;
      } catch { return 0; }
    };

    const messageCount = count("messages");
    // #1608: user-scoped — `>` matches getMessagesAfter()'s retro window, so
    // the guard, retrospective, and daily-summary all agree on what counts.
    const messagesSinceLastSleep = lastSleepTimestamp !== null
      ? userId
        ? countWhereParams("messages", "timestamp > ? AND user_id = ?", [lastSleepTimestamp, userId])
        : countWhere("messages", `timestamp >= ${lastSleepTimestamp}`)
      : userId
        ? countWhereParams("messages", "user_id = ?", [userId])
        : messageCount;
    const extractedMemoryCount = count("extracted_memories");

    // Darwinism stats
    let darwinism = { avgRecallCount: 0, avgRelevanceScore: 0, neverRecalled: 0, recalledLast30d: 0 };
    try {
      const stats = this.db.prepare(`
        SELECT COALESCE(AVG(recall_count), 0) as avgRecall,
               COALESCE(AVG(relevance_score), 0) as avgRelevance,
               SUM(CASE WHEN COALESCE(recall_count, 0) = 0 THEN 1 ELSE 0 END) as neverRecalled,
               SUM(CASE WHEN last_recalled_at > ? THEN 1 ELSE 0 END) as recalledLast30d
        FROM extracted_memories
      `).get(Date.now() - 30 * 86400000) as { avgRecall: number; avgRelevance: number; neverRecalled: number; recalledLast30d: number };
      darwinism = {
        avgRecallCount: Math.round(stats.avgRecall * 10) / 10,
        avgRelevanceScore: Math.round(stats.avgRelevance * 10) / 10,
        neverRecalled: stats.neverRecalled ?? 0,
        recalledLast30d: stats.recalledLast30d ?? 0,
      };
    } catch { /* columns may not exist yet */ }

    return {
      messageCount,
      messagesSinceLastSleep,
      embeddingCount: countWhere("extracted_memories", "embedding IS NOT NULL"),
      nullEmbeddingCount: countWhere("extracted_memories", "embedding IS NULL"),
      extractedMemoryCount,
      compressionRatio: messageCount > 0 ? Math.round((extractedMemoryCount / messageCount) * 100) / 100 : 0,
      darwinism,
    };
  }

  /** Execute FTS5 integrity-check on each virtual table. */
  private checkFts5Health(): Fts5Health {
    const check = (table: string): "ok" | "corrupt" => {
      try {
        // FTS5 integrity-check: throws if the index is corrupt
        this.db.exec(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`);
        return "ok";
      } catch {
        return "corrupt";
      }
    };
    const checkDropped = (table: string): "ok" | "corrupt" | "dropped" => {
      try {
        this.db.exec(`SELECT count(*) FROM ${table} LIMIT 1`);
        return check(table);
      } catch { return "dropped"; }
    };

    return {
      messages_fts: checkDropped("messages_fts"),
      extracted_memories_fts: check("extracted_memories_fts"),
      extracted_memories_original_fts: checkDropped("extracted_memories_original_fts"),
    };
  }

  /** Calculate total disk usage across the memory directory tree. */
  private calculateDiskUsage(): number {
    let totalBytes = 0;

    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile()) {
            try {
              totalBytes += statSync(fullPath).size;
            } catch {
              // skip unreadable files
            }
          }
        }
      } catch {
        // skip unreadable directories
      }
    };

    walk(this.config.memoryDir);
    return totalBytes;
  }

  /** List topic files in {abmindHome}/topics/ with metadata. */
  private listTopicFiles(): TopicFileEntry[] {
    // Topics dir is at the abmind root level, one level up from memoryDir
    // memoryDir = ~/.abmind/memory → topics = ~/.abmind/topics
    const topicsDir = join(dirname(this.config.memoryDir), "topics");
    if (!existsSync(topicsDir)) {
      logWarn(TAG, `Topics directory not found: ${topicsDir}`);
      return [];
    }

    const entries: TopicFileEntry[] = [];
    try {
      const files = readdirSync(topicsDir, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".md")) continue;
        try {
          const fileStat = statSync(join(topicsDir, file.name));
          entries.push({
            name: file.name,
            sizeBytes: fileStat.size,
            lastModified: localISO(fileStat.mtime),
          });
        } catch (err) {
          logWarn(TAG, `Failed to stat topic file ${file.name}: ${err}`);
        }
      }
    } catch (err) {
      logWarn(TAG, `Failed to read topics directory ${topicsDir}: ${err}`);
    }

    return entries;
  }

  /** Read a file's contents or return null if missing. */
  private readFileOrNull(path: string): string | null {
    try {
      return existsSync(path) ? readFileSync(path, "utf-8") : null;
    } catch {
      return null;
    }
  }

  /** Get ISO timestamp of the most recent sleep audit file. */
  private getLastSleepAudit(): string | null {
    const auditDir = join(this.config.memoryDir, "sleep");
    if (!existsSync(auditDir)) return null;
    try {
      const files = readdirSync(auditDir)
        .filter((f) => /^sleep_\d{8}_\d{4,6}\.md$/.test(f))
        .sort()
        .reverse();
      if (files.length === 0) return null;
      const match = files[0]!.match(/^sleep_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})?\.md$/);
      if (!match) return null;
      const [, y, mo, d, h, mi, s] = match;
      return localISO(new Date(+y!, +mo! - 1, +d!, +h!, +mi!, +(s ?? 0)));
    } catch {
      return null;
    }
  }

  /** Derive wake-up date from last sleep audit (the date portion). */
  private getWakeupDate(): string | null {
    const audit = this.getLastSleepAudit();
    return audit ? audit.slice(0, 10) : null;
  }

  /** Get last sleep audit as epoch ms (for DB timestamp queries). */
  private getLastSleepTimestamp(): number | null {
    const audit = this.getLastSleepAudit();
    if (!audit) return null;
    const ts = new Date(audit).getTime();
    return Number.isFinite(ts) ? ts : null;
  }

  /** List transcript files with message counts. */
}
