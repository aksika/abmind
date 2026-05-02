/**
 * Sleep level — selects the set of prompts run each night.
 *
 * - basic:    1 LLM call. Single-shot combined prompt. Frontier-model-only.
 *             Prompt: prompts/sleep/basic.md. Emits ===DAILY=== + ===MEMORIES===.
 * - budget:   ~3 LLM calls. gc-noise + daily-summary + extract-from-daily only.
 * - normal:   ~10-14 LLM calls. All eligible prompts except weekly-only
 *             (skill-review, core-knowledge, consolidation) on non-curation days;
 *             full set on curation day. Default.
 * - ultimate: ~14 LLM calls. All eligible prompts every day; candidate-driven
 *             skips still apply.
 *
 * See docs/plans/163-sleep-to-abmind.md for audience + tradeoff notes.
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
