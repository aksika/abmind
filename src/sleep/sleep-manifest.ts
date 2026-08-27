/**
 * sleep/sleep-manifest.ts — single source of truth for the sleep step policy.
 *
 * Reads `~/.abmind/config/sleep.json` (seeded from `templates/config/sleep.json`
 * via reconcile's SEED path — operator edits survive `abmind update`). The
 * manifest owns the step list, per-step prompt file, per-step deadline,
 * essentiality, and eligibility (`runOn` levels + `requires` gates). It replaces
 * the previous hardcoded per-step budget table, filesystem discovery + `.sort()`,
 * the skip-eligibility heuristic, the eager essentials constant, and the
 * orchestrator's level/skip sets.
 *
 * The loader NEVER throws. Any file-level failure falls back to an in-code
 * default manifest holding today's values; per-step validation drops only the
 * offending step. A malformed manifest must not stop sleep.
 *
 * The resolved manifest is memoized for one process lifetime — edits activate
 * on the next process start. Tests use `resetSleepManifestCache()`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { abmindHome } from "../mem-paths.js";
import { logWarn } from "../mem-logger.js";
import type { Level } from "./levels.js";

const TAG = "sleep-manifest";

/** One resolved sleep step. `timeoutMs` is already clamped and converted. */
export interface SleepStepConfig {
  readonly name: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly essential: boolean;
  readonly runOn: readonly string[];
  readonly requires: readonly string[];
}

/** Pre-gathered facts the eligibility predicate needs. The orchestrator owns
 *  gathering; the predicate stays pure and table-testable. */
export interface SleepEligibilityContext {
  readonly level: Level;
  readonly isCurationDay: boolean;
  readonly hasShortMessages: boolean;
  readonly hasRecallFeedback: boolean;
  readonly hasMaintenanceCandidates: boolean;
  readonly hasTranslationIssues: boolean;
  readonly extractedMemoryCount: number;
}

/** Timeout clamp bounds (seconds). */
const MIN_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 900;

/** In-code default manifest — reproduces the shipped sleep.json exactly. */
const DEFAULT_SLEEP_MANIFEST: readonly SleepStepConfig[] = Object.freeze([
  { name: "gc-noise", prompt: "01-gc-noise.md", timeoutMs: 180_000, essential: false, runOn: ["budget", "normal", "ultimate"], requires: ["hasShortMessages"] },
  { name: "daily-summary", prompt: "02-daily-summary.md", timeoutMs: 600_000, essential: true, runOn: ["budget", "normal", "ultimate"], requires: [] },
  { name: "retrospective", prompt: "03-retrospective.md", timeoutMs: 600_000, essential: true, runOn: ["budget:curation", "normal", "ultimate"], requires: [] },
  { name: "extract-memories", prompt: "04-extract-memories.md", timeoutMs: 600_000, essential: true, runOn: ["budget", "normal", "ultimate"], requires: [] },
  { name: "contradiction-and-graph", prompt: "05-contradiction-and-graph.md", timeoutMs: 300_000, essential: false, runOn: ["normal", "ultimate"], requires: [] },
  { name: "retro-derive", prompt: "06-retro-derive.md", timeoutMs: 300_000, essential: false, runOn: ["budget:curation", "normal", "ultimate"], requires: [] },
  { name: "feedback", prompt: "07-feedback.md", timeoutMs: 180_000, essential: false, runOn: ["normal", "ultimate"], requires: ["hasRecallFeedback"] },
  { name: "memory-maintenance", prompt: "08-memory-maintenance.md", timeoutMs: 300_000, essential: false, runOn: ["normal:curation", "ultimate"], requires: ["hasMaintenanceCandidates", "minExtractedMemories:10"] },
  { name: "translation", prompt: "09-translation.md", timeoutMs: 180_000, essential: false, runOn: ["normal:curation", "ultimate"], requires: ["hasTranslationIssues"] },
  { name: "skill-review", prompt: "10-skill-review.md", timeoutMs: 300_000, essential: false, runOn: ["normal:curation", "ultimate"], requires: [] },
  { name: "consolidation", prompt: "11-consolidation.md", timeoutMs: 300_000, essential: false, runOn: ["normal:curation", "ultimate"], requires: [] },
  { name: "rem-synthesis", prompt: "12-rem-synthesis.md", timeoutMs: 300_000, essential: false, runOn: ["normal:curation", "ultimate"], requires: ["minExtractedMemories:20"] },
]);

/** Path to the runtime manifest file. */
function manifestPath(): string {
  return join(abmindHome(), "config", "sleep.json");
}

/** Path to the runtime sleep prompts directory. */
function promptsDir(): string {
  return join(abmindHome(), "prompts", "sleep");
}

let cached: readonly SleepStepConfig[] | undefined;

/** Test seam — clears the memoized manifest so a test can load twice. */
export function resetSleepManifestCache(): void {
  cached = undefined;
}

/** Ordered step list from the manifest, or the in-code default on any
 *  file-level failure. Never throws. */
export function loadSleepManifest(): readonly SleepStepConfig[] {
  if (cached !== undefined) return cached;
  cached = resolveManifest();
  return cached;
}

function resolveManifest(): readonly SleepStepConfig[] {
  const path = manifestPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    logWarn(TAG, `sleep.json not found at ${path} — using in-code default manifest`);
    return DEFAULT_SLEEP_MANIFEST;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logWarn(TAG, `sleep.json at ${path} is not valid JSON — using in-code default manifest: ${err instanceof Error ? err.message : String(err)}`);
    return DEFAULT_SLEEP_MANIFEST;
  }

  if (typeof parsed !== "object" || parsed === null) {
    logWarn(TAG, "sleep.json is not an object — using in-code default manifest");
    return DEFAULT_SLEEP_MANIFEST;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    logWarn(TAG, `sleep.json version ${String(obj.version)} unsupported — using in-code default manifest`);
    return DEFAULT_SLEEP_MANIFEST;
  }
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    logWarn(TAG, "sleep.json steps is missing or empty — using in-code default manifest");
    return DEFAULT_SLEEP_MANIFEST;
  }

  const defaults = resolveDefaults(obj.defaults);

  const steps: SleepStepConfig[] = [];
  const seenNames = new Set<string>();
  const seenPrompts = new Set<string>();
  const promptFiles = new Set(scanPromptFiles());

  for (const entry of obj.steps) {
    const step = validateStep(entry, defaults, seenNames, seenPrompts, promptFiles);
    if (step !== null) steps.push(step);
  }

  if (steps.length === 0) {
    logWarn(TAG, "sleep.json validated to zero usable steps — using in-code default manifest");
    return DEFAULT_SLEEP_MANIFEST;
  }

  // Drift: numbered prompt files present on disk but absent from the manifest.
  const declared = new Set(steps.map(s => s.prompt));
  for (const f of scanNumberedPromptFiles()) {
    if (!declared.has(f)) {
      logWarn(TAG, `sleep.json does not declare prompt file ${f} (present in ${promptsDir()}) — manifest drift`);
    }
  }

  return Object.freeze(steps);
}

function resolveDefaults(defaultsRaw: unknown): { timeoutSec: number; essential: boolean } {
  let timeoutSec = 300;
  let essential = false;
  if (typeof defaultsRaw === "object" && defaultsRaw !== null) {
    const d = defaultsRaw as Record<string, unknown>;
    if (d.timeoutSec !== undefined) {
      const n = numeric(d.timeoutSec);
      if (n === null) {
        logWarn(TAG, `sleep.json defaults.timeoutSec invalid — using 300`);
      } else {
        timeoutSec = n;
      }
    }
    if (d.essential !== undefined) {
      if (typeof d.essential === "boolean") essential = d.essential;
      else logWarn(TAG, `sleep.json defaults.essential invalid — using false`);
    }
  }
  return { timeoutSec, essential };
}

function numeric(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

function validateStep(
  entry: unknown,
  defaults: { timeoutSec: number; essential: boolean },
  seenNames: Set<string>,
  seenPrompts: Set<string>,
  promptFiles: Set<string>,
): SleepStepConfig | null {
  if (typeof entry !== "object" || entry === null) {
    logWarn(TAG, "sleep.json step entry is not an object — dropped");
    return null;
  }
  const e = entry as Record<string, unknown>;

  if (typeof e.name !== "string" || e.name.length === 0) {
    logWarn(TAG, "sleep.json step missing/invalid name — dropped");
    return null;
  }
  if (typeof e.prompt !== "string" || e.prompt.length === 0) {
    logWarn(TAG, `sleep.json step ${e.name} missing/invalid prompt — dropped`);
    return null;
  }
  if (seenNames.has(e.name)) {
    logWarn(TAG, `sleep.json duplicate step name ${e.name} — dropping later entry`);
    return null;
  }
  if (seenPrompts.has(e.prompt)) {
    logWarn(TAG, `sleep.json duplicate prompt ${e.prompt} — dropping later entry`);
    return null;
  }

  const runOn = validateRunOn(e.runOn, e.name);
  if (runOn === null) return null;

  let requires: string[] = [];
  if (e.requires !== undefined) {
    if (!Array.isArray(e.requires) || !e.requires.every(r => typeof r === "string")) {
      logWarn(TAG, `sleep.json step ${e.name} requires is not a string array — dropped`);
      return null;
    }
    requires = e.requires as string[];
  }

  let essential: boolean;
  if (e.essential === undefined) essential = defaults.essential;
  else if (typeof e.essential === "boolean") essential = e.essential;
  else {
    logWarn(TAG, `sleep.json step ${e.name} essential is not a boolean — dropped`);
    return null;
  }

  let timeoutSec: number;
  if (e.timeoutSec === undefined) timeoutSec = defaults.timeoutSec;
  else {
    const n = numeric(e.timeoutSec);
    if (n === null) {
      logWarn(TAG, `sleep.json step ${e.name} timeoutSec is not a finite number — dropped`);
      return null;
    }
    timeoutSec = n;
  }
  if (timeoutSec < MIN_TIMEOUT_SEC || timeoutSec > MAX_TIMEOUT_SEC) {
    logWarn(TAG, `sleep.json step ${e.name} timeoutSec ${timeoutSec} outside [${MIN_TIMEOUT_SEC},${MAX_TIMEOUT_SEC}] — clamped`);
    timeoutSec = Math.min(MAX_TIMEOUT_SEC, Math.max(MIN_TIMEOUT_SEC, timeoutSec));
  }

  if (!promptFiles.has(e.prompt)) {
    logWarn(TAG, `sleep.json step ${e.name} prompt ${e.prompt} not present in ${promptsDir()} — dropped`);
    return null;
  }

  seenNames.add(e.name);
  seenPrompts.add(e.prompt);
  return {
    name: e.name,
    prompt: e.prompt,
    timeoutMs: timeoutSec * 1000,
    essential,
    runOn,
    requires,
  };
}

/** Validate the closed `runOn` grammar. Returns the cleaned list, or null when
 *  the step must be dropped (missing/empty, or no valid tokens remain). */
function validateRunOn(raw: unknown, name: string): readonly string[] | null {
  if (raw === undefined || !Array.isArray(raw) || raw.length === 0) {
    logWarn(TAG, `sleep.json step ${name} runOn missing or empty — dropped`);
    return null;
  }
  const cleaned: string[] = [];
  for (const token of raw) {
    if (typeof token !== "string") {
      logWarn(TAG, `sleep.json step ${name} runOn token ${String(token)} is not a string — removed`);
      continue;
    }
    const valid = token === "budget" || token === "normal" || token === "ultimate"
      || token === "budget:curation" || token === "normal:curation" || token === "ultimate:curation";
    if (!valid) {
      logWarn(TAG, `sleep.json step ${name} runOn token ${token} invalid — removed`);
      continue;
    }
    cleaned.push(token);
  }
  if (cleaned.length === 0) {
    logWarn(TAG, `sleep.json step ${name} runOn has no valid tokens — dropped`);
    return null;
  }
  return cleaned;
}

function scanPromptFiles(): string[] {
  try {
    return readdirSync(promptsDir());
  } catch {
    return [];
  }
}

function scanNumberedPromptFiles(): string[] {
  return scanPromptFiles().filter(f => /^\d+-\S+\.md$/.test(f));
}

/** Look up a resolved step config by exact step name (no `catch-up-` stripping
 *  here — callers that need it strip it before calling). */
export function sleepStepConfig(stepId: string): SleepStepConfig | undefined {
  return loadSleepManifest().find(s => s.name === stepId);
}

/** Pure eligibility predicate: level/curation match plus every `requires` gate. */
export function isSleepStepEligible(step: SleepStepConfig, context: SleepEligibilityContext): boolean {
  const daily = context.level;
  const curation = `${context.level}:curation`;
  const levelMatch = step.runOn.includes(daily)
    || (context.isCurationDay && step.runOn.includes(curation));
  if (!levelMatch) return false;
  return step.requires.every(token => isGateSatisfied(token, context));
}

/** Closed `requires` registry. Unknown tokens warn and are treated as satisfied
 *  (fail-open — a typo must not silently stop memory work). */
function isGateSatisfied(token: string, context: SleepEligibilityContext): boolean {
  switch (token) {
    case "hasShortMessages": return context.hasShortMessages;
    case "hasRecallFeedback": return context.hasRecallFeedback;
    case "hasMaintenanceCandidates": return context.hasMaintenanceCandidates;
    case "hasTranslationIssues": return context.hasTranslationIssues;
    default: {
      const m = /^minExtractedMemories:(\d+)$/.exec(token);
      if (m) {
        const rawMin = m[1];
        if (rawMin === undefined) return true;
        const min = parseInt(rawMin, 10);
        return Number.isFinite(min) && context.extractedMemoryCount >= min;
      }
      logWarn(TAG, `Unknown sleep.json requires token "${token}" — treated as satisfied`);
      return true;
    }
  }
}
