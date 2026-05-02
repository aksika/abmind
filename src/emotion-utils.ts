/** Clamp a value to [-5, +5]. Non-integer or missing values default to 0. */
export function clampEmotionScore(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isInteger(n)) return 0;
  return Math.max(-5, Math.min(5, n));
}

const EMOJI_SCORES: Record<string, number> = {
  "❤️": 4, "🔥": 4, "🎉": 3, "👏": 4, "❤": 4,
  "👍": 3, "😂": 3, "🤩": 4, "💯": 3, "⚡": 3,
  "😊": 2, "🙏": 2, "🤔": 1, "😮": 1,
  "👎": -3, "😢": -3, "😡": -4, "🤮": -4, "💩": -5,
};

/** Map a reaction emoji to an emotion score [-5, +5]. Unknown emojis default to +1. */
export function emojiToScore(emoji: string): number {
  return EMOJI_SCORES[emoji] ?? 1;
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

/** Recency-decayed emotion: recent emotions are vivid, old ones fade. */
export function effectiveEmotion(score: number, daysSinceCreated: number): number {
  const decay = Math.max(0.2, 1 - daysSinceCreated / 180); // 6-month half-life, floor 0.2
  return Math.round(score * decay * 10) / 10;
}

// ── Emoji → tags mapping ────────────────────────────────────────────────────

const EMOJI_TAGS: Record<string, string> = {
  "❤️": "love", "❤": "love", "🔥": "excitement", "🎉": "joy",
  "👏": "pride", "👍": "gratitude", "😂": "humor", "🤩": "excitement",
  "💯": "conviction", "⚡": "determination", "😊": "joy", "🙏": "gratitude",
  "🤔": "curiosity", "😮": "surprise",
  "👎": "frustration", "😢": "grief", "😡": "anger", "🤮": "anger", "💩": "frustration",
};

/** Map a reaction emoji to an emotion tag. Unknown emojis default to "gratitude". */
export function emojiToTag(emoji: string): string {
  return EMOJI_TAGS[emoji] ?? "gratitude";
}

/** Reverse-derive a default tag from a numeric score (for backfill). */
export function tagFromScore(score: number): string {
  if (score >= 4) return "pride";
  if (score >= 2) return "joy";
  if (score === 1) return "gratitude";
  if (score === 0) return "";
  if (score >= -2) return "doubt";
  if (score >= -4) return "frustration";
  return "anger";
}
