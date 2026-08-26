import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { abmindHome } from "../mem-paths.js";
import type { StateSnapshot } from "../sleep-state-gatherer.js";
import { logDebug, logWarn } from "../mem-logger.js";
import { localDate } from "../local-time.js";
import { loadSleepManifest, type SleepStepConfig } from "./sleep-manifest.js";

const TAG = "sleep-prompt-loader";

/** Build the variable map used for template substitution. */
export function buildSleepVars(snapshot: StateSnapshot): Record<string, string> {
  const now = new Date();
  const dateStr = localDate().replace(/-/g, "");
  const timeStr = now.toTimeString().slice(0, 5).replace(/:/g, "");
  return {
    TIMESTAMP: snapshot.timestamp,
    LAST_SLEEP_AUDIT: snapshot.lastSleepAudit ?? "none",
    LAST_SLEEP_TS: snapshot.lastSleepTimestamp ? String(snapshot.lastSleepTimestamp) : "0",
    CURRENT_TS: String(Date.now()),
    WAKEUP_DATE: snapshot.wakeupDate ?? localDate(),
    STATE_SNAPSHOT: buildSnapshotBlock(snapshot),
    FTS_MESSAGES: snapshot.fts5Health.messages_fts,
    FTS_EXTRACTED: snapshot.fts5Health.extracted_memories_fts,
    FTS_ORIGINAL: snapshot.fts5Health.extracted_memories_original_fts,
    DISK_USAGE_MB: (snapshot.diskUsageBytes / 1024 / 1024).toFixed(1),
    DISK_BUDGET_MB: (snapshot.diskBudgetBytes / 1024 / 1024).toFixed(0),
    TODO_CONTENTS: snapshot.todoContents ?? "No todo list yet.",
    CRON_CONTENTS: snapshot.cronContents ?? "No cron entries.",
    TOPIC_FILES_SECTION: buildTopicSection(snapshot),
    WORKING_DIRS_SECTION: buildWorkingDirsSection(snapshot),
    AUDIT_FILENAME: `${dateStr}_${timeStr}`,
  };
}

/** Apply variable substitution to a template string. */
export function substituteVars(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`\${${key}}`, value);
  }
  const unreplaced = result.match(/\$\{[A-Z_]+\}/g);
  if (unreplaced) logWarn(TAG, `Unreplaced template variables: ${unreplaced.join(", ")}`);
  return result;
}

/** A single sleep step: manifest policy plus the loaded prompt text. */
export interface SleepStep extends SleepStepConfig {
  filename: string;
  rawPrompt: string;
}

/**
 * Load all sleep step prompts in manifest order from ~/.abmind/prompts/sleep/.
 * The manifest owns the step list (order, prompts, timeouts, essentiality,
 * eligibility); this module only attaches the raw prompt text. The throw when
 * the prompts directory is absent is kept — reconcile guarantees the dir is
 * always fresh from source.
 */
export function loadSleepSteps(): SleepStep[] {
  const dir = join(abmindHome(), "prompts", "sleep");
  if (!existsSync(dir)) {
    throw new Error(`Sleep prompts not found at ${dir}. Run 'abmind update' to reconcile.`);
  }

  const steps: SleepStep[] = [];
  for (const config of loadSleepManifest()) {
    const path = join(dir, config.prompt);
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (err) {
      logWarn(TAG, `Sleep prompt ${path} unreadable — skipping step ${config.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    steps.push({ ...config, filename: config.prompt, rawPrompt: raw });
  }
  return steps;
}

function buildSnapshotBlock(s: StateSnapshot): string {
  return [
    `- Messages in DB: ${s.dbStats.messageCount}`,
    `- Extracted memories: ${s.dbStats.extractedMemoryCount}`,
    `- Embeddings: ${s.dbStats.embeddingCount}/${s.dbStats.extractedMemoryCount}${s.dbStats.nullEmbeddingCount > 0 ? ` (${s.dbStats.nullEmbeddingCount} missing)` : ""}`,
    `- Working dirs: ${s.workingDirs.length}`,
    `- Disk: ${(s.diskUsageBytes / 1024 / 1024).toFixed(1)} MB / ${(s.diskBudgetBytes / 1024 / 1024).toFixed(0)} MB`,
  ].join("\n");
}

function buildTopicSection(s: StateSnapshot): string {
  if (s.topicFiles.length === 0) return "No topic files.";
  return s.topicFiles
    .map((t) => `- \`${t.name}\` (${(t.sizeBytes / 1024).toFixed(1)} KB, modified ${t.lastModified.slice(0, 10)})`)
    .join("\n");
}

function buildWorkingDirsSection(s: StateSnapshot): string {
  if (s.workingDirs.length === 0) return "No working directories.";
  return s.workingDirs
    .map((d) => `- \`${d.date}\` (${d.files.length} files)`)
    .join("\n");
}
