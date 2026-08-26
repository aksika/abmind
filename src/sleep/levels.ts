/**
 * Sleep level — selects the set of prompts run each night.
 *
 * - basic:    1 LLM call. Single-shot combined prompt. Frontier-model-only.
 *             Prompt: prompts/sleep/basic.md. Emits ===DAILY=== + ===MEMORIES===.
 * - budget:   ~3 calls daily, ~5 on curation day (adds retro + derive).
 * - normal:   ~7 calls daily, ~12 on curation day. Default.
 *             Daily: gc-noise, daily-summary, retrospective, extract-memories,
 *             contradiction-and-graph, retro-derive, feedback.
 *             Curation adds: memory-maintenance, translation, skill-review,
 *             consolidation, rem-synthesis.
 * - ultimate: ~12 calls every night. All steps, no weekly gating.
 *
 * The exact step set per level/curation-day combination is defined by the
 * `sleep.json` manifest (`runOn` + `requires`); the counts above are the
 * all-gates-satisfied resolution. See docs/plans/163-sleep-to-abmind.md for
 * audience + tradeoff notes.
 */
export type Level = "basic" | "budget" | "normal" | "ultimate" | "native";

const LEVELS: readonly Level[] = ["basic", "budget", "normal", "ultimate", "native"] as const;

/** Parse a string into a Level; throw if unrecognized. */
export function parseLevel(s: string): Level {
  const lower = s.toLowerCase();
  if ((LEVELS as readonly string[]).includes(lower)) return lower as Level;
  throw new Error(`Invalid sleep level '${s}' — expected one of: ${LEVELS.join(", ")}`);
}

/** Default level when caller provides neither `level` nor `SLEEP_QUALITY` env. */
export const DEFAULT_LEVEL: Level = "normal";
