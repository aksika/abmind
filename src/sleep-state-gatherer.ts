import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import type { IMemorySystem } from "./imemory-system.js";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { localISO } from "./local-time.js";
import { logInfo, logWarn, logError } from "./mem-logger.js";
import { recallProjectionStatus } from "./recall-projection-build.js";
import { isSuppressedByForget } from "./personal-forget.js";

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
  durableMemoryCount: number;
  compressionRatio: number;
}

export interface RecallProjectionHealth {
  state: string;
  servingGeneration: number | null;
  indexedDocuments: number;
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
  recallProjection: RecallProjectionHealth;
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
    const recallProjection = this.checkRecallProjection();
    const diskUsageBytes = this.calculateDiskUsage();
    const topicFiles = this.listTopicFiles();

    const snapshot: StateSnapshot = {
      timestamp,
      workingDirs,
      dbStats,
      recallProjection,
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

    // #1658: all user-data aggregates use the same owner scope when a
    // principal is supplied. Leaving this global makes the compression ratio
    // compare one owner's extracted rows with every user's messages.
    const messageCount = userId
      ? countWhereParams("messages", "user_id = ?", [userId])
      : count("messages");
    // #1608: user-scoped — `>` matches getMessagesAfter()'s retro window, so
    // the guard, retrospective, and daily-summary all agree on what counts.
    const messagesSinceLastSleep = lastSleepTimestamp !== null
      ? userId
        ? countWhereParams("messages", "timestamp > ? AND user_id = ?", [lastSleepTimestamp, userId])
        : countWhere("messages", `timestamp >= ${lastSleepTimestamp}`)
      : userId
        ? countWhereParams("messages", "user_id = ?", [userId])
        : messageCount;
    // #1937: durable count replaces the legacy extracted count. Owner-scoped
    // when a principal is supplied; eligible durables only.
    let durableMemoryCount = 0;
    try {
      if (userId) {
        const rows = this.db.prepare(
          `SELECT id FROM long_term_memories WHERE user_id = ?
           AND superseded_by_id IS NULL AND classification <= 2 AND encrypted = 0
           AND sealed_format_version = 0
           AND (valid_to IS NULL OR valid_to > strftime('%Y-%m-%d','now','localtime'))
           LIMIT 5000`,
        ).all(userId) as Array<{ id: number }>;
        for (const r of rows) {
          try {
            if (!isSuppressedByForget(this.db, userId, { durableId: r.id })) durableMemoryCount++;
          } catch { /* fail-closed: skip on forget errors */ }
        }
      } else {
        const row = this.db.prepare(
          `SELECT COUNT(*) as cnt FROM long_term_memories WHERE superseded_by_id IS NULL`,
        ).get() as { cnt: number };
        durableMemoryCount = row.cnt;
      }
    } catch { durableMemoryCount = 0; }

    return {
      messageCount,
      messagesSinceLastSleep,
      durableMemoryCount,
      compressionRatio: messageCount > 0 ? Math.round((durableMemoryCount / messageCount) * 100) / 100 : 0,
    };
  }

  /** #1937: report the #1928 recall projection status instead of legacy FTS health. */
  private checkRecallProjection(): RecallProjectionHealth {
    try {
      const status = recallProjectionStatus(this.db);
      return {
        state: status.state,
        servingGeneration: status.servingGeneration,
        indexedDocuments: status.indexedDocuments,
      };
    } catch {
      return { state: "unknown", servingGeneration: null, indexedDocuments: 0 };
    }
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
