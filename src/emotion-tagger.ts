/**
 * emotion-tagger.ts — Pattern-based emotion detection.
 * Pure function, no LLM, ~1ms per call.
 */

export type EmotionTag =
  | "joy" | "trust" | "hope" | "fear" | "grief" | "anger"
  | "doubt" | "relief" | "pride" | "curiosity" | "frustration"
  | "surprise" | "determination" | "exhaustion" | "anxiety"
  | "gratitude" | "love" | "humor" | "vulnerability" | "conviction"
  | "peace" | "confusion" | "excitement" | "tenderness" | "raw_honesty";

const PATTERNS: ReadonlyArray<readonly [RegExp, EmotionTag]> = [
  // joy / positive
  [/\b(happy|glad|delighted|wonderful|amazing|fantastic|brilliant|perfect)\b/i, "joy"],
  [/\b(love|adore|cherish|devoted)\b/i, "love"],
  [/\b(grateful|thankful|appreciate|thanks)\b/i, "gratitude"],
  [/\b(proud|pride|accomplished|nailed it)\b/i, "pride"],
  [/\b(excited|thrilled|can't wait|pumped)\b/i, "excitement"],
  [/\b(funny|hilarious|lol|lmao|haha|😂|🤣)\b/i, "humor"],
  [/\b(peaceful|calm|serene|at ease)\b/i, "peace"],
  [/\b(tender|gentle|warm|caring)\b/i, "tenderness"],

  // trust / conviction
  [/\b(trust|reliable|dependable|count on)\b/i, "trust"],
  [/\b(decided|committed|convinced|certain|absolutely)\b/i, "conviction"],
  [/\b(determined|persistent|won't give up|keep going)\b/i, "determination"],

  // hope / relief
  [/\b(hope|hopeful|optimistic|looking forward)\b/i, "hope"],
  [/\b(relief|relieved|finally|phew|thank god)\b/i, "relief"],
  [/\b(surprised|unexpected|didn't expect|wow|whoa)\b/i, "surprise"],
  [/\b(curious|wondering|interesting|intrigued|fascinated)\b/i, "curiosity"],

  // negative
  [/\b(afraid|scared|terrified|frightened|worried about)\b/i, "fear"],
  [/\b(anxious|nervous|uneasy|stressed|overwhelmed)\b/i, "anxiety"],
  [/\b(angry|furious|rage|pissed|infuriated|hate)\b/i, "anger"],
  [/\b(frustrated|annoying|irritating|ugh|damn)\b/i, "frustration"],
  [/\b(confused|lost|don't understand|makes no sense|wtf)\b/i, "confusion"],
  [/\b(sad|grief|mourning|loss|heartbroken|devastated)\b/i, "grief"],
  [/\b(doubt|uncertain|not sure|skeptical|questionable)\b/i, "doubt"],
  [/\b(exhausted|burned out|drained|tired of|fed up)\b/i, "exhaustion"],
  [/\b(vulnerable|exposed|raw|honest truth|admit)\b/i, "vulnerability"],
  [/\b(brutal honesty|hard truth|real talk|no sugar)\b/i, "raw_honesty"],
];

/** Detect emotions from text via keyword patterns. Returns deduplicated tags. */
export function detectEmotions(text: string): EmotionTag[] {
  const seen = new Set<EmotionTag>();
  for (const [pattern, tag] of PATTERNS) {
    if (pattern.test(text) && !seen.has(tag)) seen.add(tag);
  }
  return [...seen];
}
