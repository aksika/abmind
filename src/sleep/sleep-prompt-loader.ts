import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { abmindHome } from "../mem-paths.js";
import type { StateSnapshot } from "../sleep-state-gatherer.js";
import { logDebug, logWarn } from "../mem-logger.js";
import { localDate } from "../local-time.js";

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

/** A single sleep step definition. */
export interface SleepStep {
  name: string;
  filename: string;
  rawPrompt: string;
  skippable: boolean;
}

/** Resolve the package's shipped prompts/sleep/ dir.
 *  Works from both source (src/sleep/) and built dist (dist/src/sleep/). */
function packagePromptsDir(): string {
  const hereDir = dirname(fileURLToPath(import.meta.url));
  // src/sleep/ → up 2 to pkg root → prompts/sleep
  const srcSide = join(hereDir, "..", "..", "prompts", "sleep");
  if (existsSync(srcSide)) return srcSide;
  // dist/src/sleep/ → up 3 to pkg root → prompts/sleep
  return join(hereDir, "..", "..", "..", "prompts", "sleep");
}

/**
 * Load all sleep step files from prompts/sleep/ directory.
 * Returns raw templates — caller substitutes JIT with evolving vars map.
 *
 * Resolution: merge package dir (base) + user dir (overlay).
 * User files override same-named package files. Package files not in user dir still load.
 * This ensures new steps added in updates appear even if user dir exists.
 */
export function loadSleepSteps(): SleepStep[] {
  const userDir = join(abmindHome(), "prompts", "sleep");
  const packageDir = packagePromptsDir();

  // Merge: package as base, user overlays
  const fileMap = new Map<string, string>(); // filename → full path
  if (existsSync(packageDir)) {
    for (const f of readdirSync(packageDir).filter(f => /^\d+-.*\.md$/.test(f))) {
      fileMap.set(f, join(packageDir, f));
    }
  }
  if (existsSync(userDir)) {
    for (const f of readdirSync(userDir).filter(f => /^\d+-.*\.md$/.test(f))) {
      fileMap.set(f, join(userDir, f)); // override package file
    }
  }
  if (fileMap.size === 0) {
    throw new Error(`Sleep step directory not found at ${userDir} or ${packageDir}`);
  }

  const files = [...fileMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return files.map(([filename, filepath]) => {
    const raw = readFileSync(filepath, "utf-8");
    const name = filename.replace(/^\d+-/, "").replace(/\.md$/, "");
    return {
      name,
      filename,
      rawPrompt: raw,
      skippable: !name.includes("gc-noise") && !name.includes("daily-summary") && !name.includes("extract-memories") && !name.includes("retrospective"),
    };
  });
}

/**
 * Load sleeping_prompt.md template and inject state snapshot variables.
 * @deprecated Use loadSleepSteps() for multi-turn sleep.
 */
export function loadSleepPrompt(snapshot: StateSnapshot): string {
  const path = join(abmindHome(), "prompts", "sleeping_prompt.md");

  if (!existsSync(path)) {
    throw new Error(`sleeping_prompt.md not found at ${path}`);
  }
  const template = readFileSync(path, "utf-8");
  return substituteVars(template, buildSleepVars(snapshot));
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
