/**
 * step-prepare.ts — shared sleep input preparation boundary (#1807 R1).
 *
 * Used at each prompt-driven dispatch by normal orchestration and catch-up.
 * Templates are data: referenced `${NAME}` bindings are scanned from the raw
 * template, substitution is single-pass (inserted content is never rescanned),
 * and every referenced variable needs a binding. Missing required bindings
 * are preparation failures — never provider failures, never model retries.
 *
 * Legitimate optional absence is represented by an explicit section/value
 * defined by the step, never a prose error smuggled into a path variable.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseDailyHeading,
  parseDailyWrittenAt,
  parseLegacyDailyDay,
  parseLegacyDailyWriteTs,
} from "./sleep-daily-summary.js";

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** All `${NAME}` references in a raw template, in first-seen order. */
export function scanTemplateVars(rawPrompt: string): string[] {
  const seen: string[] = [];
  const known = new Set<string>();
  VAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VAR_RE.exec(rawPrompt)) !== null) {
    if (!known.has(m[1]!)) {
      known.add(m[1]!);
      seen.push(m[1]!);
    }
  }
  return seen;
}

export type StepPreparation =
  | { status: "ready"; prompt: string }
  | { status: "no_work"; reason: string }
  | { status: "preparation_failed"; detail: string };

/**
 * Single-pass render over caller-supplied bindings. Every referenced
 * variable must be bound; unbound references fail preparation. Inserted
 * values are data — `${...}` inside them survives unchanged.
 */
export function prepareStepDispatch(
  stepName: string,
  rawPrompt: string,
  bindings: Record<string, string>,
): StepPreparation {
  const missing = scanTemplateVars(rawPrompt).filter((name) => !(name in bindings));
  if (missing.length > 0) {
    return {
      status: "preparation_failed",
      detail: `step ${stepName} has unbound template variables: ${missing.join(", ")}`,
    };
  }
  VAR_RE.lastIndex = 0;
  const prompt = rawPrompt.replace(VAR_RE, (_whole, name: string) => bindings[name]!);
  return { status: "ready", prompt };
}

// ── Retro-derive inputs ────────────────────────────────────────────────────

/**
 * Bound as RETRO_CONTENT when no readable retrospective artifact exists.
 * The prompt skips derivation on this marker while retaining promotions.
 */
export const RETRO_ABSENT_MARKER =
  "ABSENT — no readable retrospective artifact; skip knowledge derivation, report the skip, continue promotions.";

export interface KnowledgeFileInput {
  name: string;
  path: string;
  exists: boolean;
  readable: boolean;
}

/** Absolute knowledge paths under `<memoryDir>/core` with explicit availability. */
export function knowledgeFileInputs(memoryDir: string): KnowledgeFileInput[] {
  return ["agent_notes.md", "user_profile.md", "core_facts.md"].map((name) => {
    const path = join(memoryDir, "core", name);
    let readable = false;
    try {
      readFileSync(path, "utf-8");
      readable = true;
    } catch { /* absent or unreadable */ }
    return { name, path, exists: existsSync(path), readable };
  });
}

/**
 * Availability section for the retro-derive prompt. Missing files skip only
 * their updates; unreadable existing files are errors (reported via the
 * returned detail, not silently treated as empty).
 */
export function knowledgeAvailabilitySection(files: KnowledgeFileInput[]): { section: string; unreadable: string[] } {
  const unreadable = files.filter((f) => f.exists && !f.readable).map((f) => f.name);
  const lines = files.map((f) => {
    if (!f.exists) return `- ${f.path}: ABSENT — skip its update, report the skip, continue other work.`;
    if (!f.readable) return `- ${f.path}: UNREADABLE — report failure for this file, continue other work.`;
    return `- ${f.path}: available.`;
  });
  return {
    section: `Knowledge files (absolute paths — read and update exactly these, no discovery):\n${lines.join("\n")}`,
    unreadable,
  };
}

export interface ConsolidationSelection {
  listSection: string;
  coveredRange: string;
  missingDates: string[];
  selected: Array<{ date: string; path: string }>;
}

function toLocalDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Deterministic consolidation inputs: daily files resolved through their
 * heading periods (#1821), enumerated nonrecursively from the configured
 * daily directory. Weekly covers the seven local calendar dates ending on the
 * logical cycle date, inclusive. Quarterly covers the previous complete
 * calendar quarter.
 */
export function consolidationInputs(
  memoryDir: string,
  logicalDate: Date,
  quarterly: boolean,
): ConsolidationSelection {
  const wanted: string[] = [];
  if (quarterly) {
    const q = Math.floor(logicalDate.getMonth() / 3);
    const prevQ = (q + 3) % 4;
    const year = logicalDate.getFullYear() - (q === 0 ? 1 : 0);
    const startMonth = prevQ * 3;
    for (let m = startMonth; m < startMonth + 3; m++) {
      for (let d = 1; d <= new Date(year, m + 1, 0).getDate(); d++) {
        wanted.push(`${year}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
      }
    }
  } else {
    for (let back = 6; back >= 0; back--) {
      wanted.push(toLocalDateKey(new Date(logicalDate.getTime() - back * 86_400_000)));
    }
  }
  const dailyDir = join(memoryDir, "daily");
  const selected = wanted
    .map((date) => {
      const path = newestDailyCoveringDate(dailyDir, date);
      return path === null ? null : { date, path };
    })
    .filter((s): s is { date: string; path: string } => s !== null);
  const missingDates = wanted.filter((date) => newestDailyCoveringDate(dailyDir, date) === null);
  const listSection = selected.length > 0
    ? selected.map((s) => `- ${s.date}: ${s.path}`).join("\n")
    : "ABSENT — no daily artifacts in the covered range; skip consolidation with a no-work reason.";
  return {
    listSection: `Daily inputs (absolute paths — read exactly these, no discovery):\n${listSection}`,
    coveredRange: quarterly
      ? `previous complete calendar quarter ending before ${toLocalDateKey(logicalDate)}`
      : `${wanted[0]} to ${wanted[wanted.length - 1]} (seven local dates ending on the cycle date, inclusive)`,
    missingDates,
    selected,
  };
}

/** Covered window of one daily file: heading period, or the legacy name day. */
function dailyCover(dailyDir: string, file: string): { startDay: string; endDay: string; stamp: number } | null {
  if (!file.startsWith("daily_") || !file.endsWith(".md")) return null;
  let firstLine = "";
  try {
    const raw = readFileSync(join(dailyDir, file), "utf-8");
    const newline = raw.indexOf("\n");
    firstLine = newline === -1 ? raw : raw.slice(0, newline);
  } catch {
    return null;
  }
  const period = parseDailyHeading(firstLine);
  if (period) {
    return { ...period, stamp: parseDailyWrittenAt(file) ?? -1 };
  }
  const day = parseLegacyDailyDay(file);
  if (day === null) return null;
  return { startDay: day, endDay: day, stamp: parseLegacyDailyWriteTs(file) ?? -1 };
}

/**
 * Newest daily file covering a calendar date: heading periods decide, the
 * legacy exact-name day is the fallback for heading-less files, write stamp
 * (then name) breaks ties deterministically.
 */
function newestDailyCoveringDate(dailyDir: string, date: string): string | null {
  let best: { path: string; stamp: number } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(dailyDir);
  } catch {
    return null; // missing daily dir → everything missing
  }
  for (const file of entries) {
    const cover = dailyCover(dailyDir, file);
    if (!cover || date < cover.startDay || date > cover.endDay) continue;
    const path = join(dailyDir, file);
    if (!best || cover.stamp > best.stamp || (cover.stamp === best.stamp && path > best.path)) {
      best = { path, stamp: cover.stamp };
    }
  }
  return best === null ? null : best.path;
}

/** Previous-consolidation reference: a readable path or explicit absence. */
export function previousConsolidationSection(discoveryPath: string | null): string {
  if (discoveryPath) return `Previous consolidation for reference: ${discoveryPath}`;
  return "Previous consolidation: ABSENT — no prior consolidation exists.";
}
