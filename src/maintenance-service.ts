import { getAbmindEnv } from "./env-schema.js";
import { writeFileSync, existsSync, statSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import type { MemoryIndex } from "./memory-index.js";
import type { MemoryEditor } from "./memory-editor.js";
import type { MemoryManager } from "./memory-manager.js";
import type { SleepDataAccess } from "./sleep-data-access.js";
import { logError, logInfo, logWarn } from "./mem-logger.js";
import { readGcMarks, writeGcMarks, type GcMarks } from "./sleep/gc-codec.js";
import { writeReceipts } from "./sleep/receipts.js";
import { hashKnowledgeBytes } from "./sleep/proposals.js";

const TAG = "maintenance";

/** #1859: best-effort durable receipts for deterministic pre-sleep writes.
 *  A persistence failure is logged, never fatal to housekeeping — unlike
 *  proposal steps, settlement does not gate on wired-task receipts. */
function emitDeterministicReceipts(
  memoryDir: string,
  runId: string,
  step: string,
  principal: string,
  entries: Array<{ opId: string; op: string; disposition: "accepted"; memoryId?: number; knowledgeFile?: string; knowledgeVersion?: string }>,
): void {
  try {
    writeReceipts(memoryDir, entries.map((e) => ({ runId, step, principal, ...e, at: Date.now() })));
  } catch (err) {
    logWarn(TAG, `[PRE-SLEEP] deterministic receipt write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export type PreSleepResults = {
  purged: number; deduped: number; embedded: number; anomaliesFixed: number;
  walOk: boolean; ftsOk: boolean; sleepFilesDeleted: number; profileSectionRemoved: boolean;
};

/** #1937 D3: remove the generated "Emotional Patterns (auto-generated)"
 *  section (heading through the line before the next heading). Returns null
 *  when the section is absent. The junction is normalized to exactly one blank
 *  line when content follows; every other byte of the file is preserved. */
function stripGeneratedEmotionalProfile(content: string): string | null {
  const lines = content.split("\n");
  const startHeading = lines.findIndex((line) => line.trim() === "## Emotional Patterns (auto-generated)");
  if (startHeading < 0) return null;
  let end = lines.length;
  for (let i = startHeading + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) { end = i; break; }
  }
  // Absorb the section's own surrounding blank lines, then keep exactly one
  // separator when content follows. Nothing outside this span is rewritten.
  let start = startHeading;
  while (start > 0 && lines[start - 1]!.trim() === "") start--;
  while (end < lines.length && lines[end]!.trim() === "") end++;
  const tail = lines.slice(end);
  if (tail.length === 0) return lines.slice(0, start).join("\n");
  return [...lines.slice(0, start), "", ...tail].join("\n");
}

/** Handles disk budget, backup pruning, auto-compact, and forget operations. */
export class MaintenanceService {
  constructor(
    private readonly db: Database.Database,
    private readonly config: MemoryConfig,
    private readonly memoryIndex: MemoryIndex,
    private readonly editor: MemoryEditor,
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

  /** Run SQLite integrity check (B-tree + FTS5). Returns "ok" or error description. */
  checkIntegrity(): string {
    try {
      const result = this.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
      const btree = result?.integrity_check ?? "unknown";
      if (btree !== "ok") return btree;
      // FTS5 internal checksums (PRAGMA misses these)
      // #1939 stage 3: legacy extracted/trigram FTS dropped; check the recall projection FTS.
      for (const t of ["recall_fts", "recall_trigram_en", "recall_trigram_orig"]) {
        try { this.db.exec(`INSERT INTO ${t}(${t}) VALUES('integrity-check')`); }
        catch (e) { return `fts5: ${e instanceof Error ? e.message : "corrupt"} for table "${t}"`; }
      }
      return "ok";
    } catch (e) {
      return e instanceof Error ? e.message : "error";
    }
  }

  /** Pre-sleep housekeeping — memory-side tasks. Returns results summary.
   *  #1859: with `receipts` (runId), deterministic memory/knowledge writes
   *  (emotion arcs, emotional-profile rewrite) leave the same durable
   *  receipts as proposal-applied writes. Receipt failure is logged, never
   *  fatal to housekeeping. */
  async runPreSleepTasks(memory: MemoryManager, sleepData: SleepDataAccess, primaryUserId: string, receipts?: { runId: string }): Promise<PreSleepResults> {
    const memoryDir = this.config.memoryDir;
    const r: PreSleepResults = { purged: 0, deduped: 0, embedded: 0, anomaliesFixed: 0, walOk: false, ftsOk: false, sleepFilesDeleted: 0, profileSectionRemoved: false };

    // 1. Purge expired garbage (#1807: shared strict codec — incompatible
    // shapes are left untouched and only warned, never converted).
    try {
      const status = readGcMarks(memoryDir);
      if (status.kind === "ok") {
        const cutoff = Date.now() - 7 * 86400000;
        const expired = [...status.marks.entries()].filter(([, ts]) => new Date(ts).getTime() < cutoff);
        if (expired.length > 0) {
          const ids = expired.map(([id]) => id);
          sleepData.deleteMessagesByIds(ids);
          const remaining: GcMarks = new Map(status.marks);
          for (const [id] of expired) remaining.delete(id);
          writeGcMarks(memoryDir, remaining);
          r.purged = expired.length;
        }
      } else if (status.kind === "incompatible") {
        logWarn(TAG, `[PRE-SLEEP] garbage artifact incompatible (${status.detail}) — left unchanged`);
      }
    } catch (err) { logWarn(TAG, `[PRE-SLEEP] garbage purge: ${err instanceof Error ? err.message : String(err)}`); }

    // 2. Dedup consecutive exact messages
    try { r.deduped = memory.deduplicateMessages().removed; } catch (err) { logWarn(TAG, `[PRE-SLEEP] dedup: ${err instanceof Error ? err.message : String(err)}`); }

    // 3. WAL checkpoint
    r.walOk = memory.runWalCheckpoint();

    // 4. FTS rebuild if corrupt
    try { const { rebuilt } = memory.rebuildFtsIndexes(); r.ftsOk = true; for (const t of rebuilt) logInfo(TAG, `[PRE-SLEEP] Rebuilt FTS: ${t}`); } catch (err) { logWarn(TAG, `[PRE-SLEEP] FTS: ${err instanceof Error ? err.message : String(err)}`); }

    // 5. (removed #1939 2b: no embedding backfill or legacy default repairs)

    // 7. Delete old sleep step-log directories (> 3 days). Lock files are
    // run receipts (#1905) and are retained, never age-deleted.
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
        }
      }
    } catch (err) { logWarn(TAG, `[PRE-SLEEP] sleep cleanup: ${err instanceof Error ? err.message : String(err)}`); }

    // 8. #1937 D3: one-time removal of the generated emotional-profile
    // section from user_profile.md. Durables carry no emotion data so the
    // section has no source; later runs never write it. Idempotent: the
    // section's exact line span is spliced out and every other byte is kept.
    try {
      const profilePath = join(memoryDir, "core", "user_profile.md");
      if (existsSync(profilePath)) {
        const content = readFileSync(profilePath, "utf-8");
        const stripped = stripGeneratedEmotionalProfile(content);
        if (stripped !== null && stripped !== content) {
          writeFileSync(profilePath, stripped, "utf-8");
          r.profileSectionRemoved = true;
          logInfo(TAG, `[PRE-SLEEP] Removed generated emotional-profile section from user_profile.md`);
          if (receipts) {
            const version = hashKnowledgeBytes(stripped).slice(0, 12);
            emitDeterministicReceipts(memoryDir, receipts.runId, "wired-pre-tasks", primaryUserId, [{
              opId: `${receipts.runId}/wired-pre-tasks/profile-section-removed`,
              op: "profile_section_removed", disposition: "accepted" as const,
              knowledgeFile: "user_profile.md", knowledgeVersion: version,
            }]);
          }
        }
      }
    } catch (err) { logWarn(TAG, `[PRE-SLEEP] emotional profile removal: ${err instanceof Error ? err.message : String(err)}`); }

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
