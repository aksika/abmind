/** Emotion tag type — the 25 recognized emotion categories. */
export type EmotionTag =
  | "joy" | "trust" | "hope" | "fear" | "grief" | "anger"
  | "doubt" | "relief" | "pride" | "curiosity" | "frustration"
  | "surprise" | "determination" | "exhaustion" | "anxiety"
  | "gratitude" | "love" | "humor" | "vulnerability" | "conviction"
  | "peace" | "confusion" | "excitement" | "tenderness" | "raw_honesty";

/** Clamp a value to [-5, +5]. Non-integer or missing values default to 0. */
export function clampEmotionScore(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isInteger(n)) return 0;
  return Math.max(-5, Math.min(5, n));
}

// ── Tag valence map (positive/negative weight per tag) ──────────────────────

const TAG_VALENCE: Record<string, number> = {
  joy: 4, love: 5, gratitude: 3, pride: 4, excitement: 4, humor: 3,
  peace: 2, tenderness: 3, trust: 2, conviction: 3, determination: 3,
  hope: 3, relief: 3, surprise: 2, curiosity: 2,
  fear: -3, anxiety: -3, anger: -4, frustration: -3, confusion: -2,
  grief: -5, doubt: -2, exhaustion: -3, vulnerability: -2, raw_honesty: -1,
};

/** Derive emotion_score from tags using max absolute valence. */
export function scoreFromTags(tags: string): number {
  if (!tags) return 0;
  let maxAbs = 0;
  let maxVal = 0;
  for (const tag of tags.split(",")) {
    const v = TAG_VALENCE[tag.trim()];
    if (v !== undefined && Math.abs(v) > maxAbs) { maxAbs = Math.abs(v); maxVal = v; }
  }
  return clampEmotionScore(maxVal);
}
