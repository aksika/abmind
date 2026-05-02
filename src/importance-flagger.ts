/**
 * importance-flagger.ts — Pattern-based importance classification.
 * Pure function, no LLM, ~0.5ms per call.
 */

export type ImportanceFlag =
  | "decision" | "origin" | "core_belief" | "pivot"
  | "technical" | "correction" | "preference" | "milestone";

const PATTERNS: ReadonlyArray<readonly [RegExp, ImportanceFlag]> = [
  [/\b(decided|chose|picked|switched to|went with|instead of|trade-?off|over.*because)\b/i, "decision"],
  [/\b(created|founded|started|born|launched|first time|first ever|genesis)\b/i, "origin"],
  [/\b(always|never|fundamental|essential|principle|belief|core value)\b/i, "core_belief"],
  [/\b(turning point|changed everything|realized|breakthrough|epiphany|game changer)\b/i, "pivot"],
  [/\b(architecture|config|deploy|infrastructure|database|api|server|framework|stack|pipeline)\b/i, "technical"],
  [/\b(actually|was wrong|corrected|updated|no longer|used to be|changed from)\b/i, "correction"],
  [/\b(prefer|always use|never use|my rule|my style|i like to|i hate when)\b/i, "preference"],
  [/\b(shipped|deployed|released|it works|fixed|solved|completed|finished|done)\b/i, "milestone"],
];

/** Detect importance flags from text via keyword patterns. Returns deduplicated flags. */
export function detectFlags(text: string): ImportanceFlag[] {
  const seen = new Set<ImportanceFlag>();
  for (const [pattern, flag] of PATTERNS) {
    if (pattern.test(text) && !seen.has(flag)) seen.add(flag);
  }
  return [...seen];
}
