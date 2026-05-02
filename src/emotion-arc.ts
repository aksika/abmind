/**
 * emotion-arc.ts — Track emotional trajectory per topic over time.
 * Built during sleep from emotion_tags on recent memories.
 */

import type { EmotionTag } from "./emotion-tagger.js";

export type ArcDirection = "rising" | "falling" | "volatile" | "stable";

export interface EmotionArc {
  tags: EmotionTag[];
  direction: ArcDirection;
  symbol: string;
}

const VALENCE: Record<string, number> = {
  joy: 1, love: 1, gratitude: 1, pride: 1, excitement: 1, hope: 1, relief: 1,
  trust: 0.5, peace: 0.5, humor: 0.5, tenderness: 0.5, curiosity: 0.3,
  conviction: 0.5, determination: 0.3, surprise: 0,
  doubt: -0.3, confusion: -0.3, vulnerability: -0.3,
  fear: -0.5, anxiety: -0.5, frustration: -0.5, exhaustion: -0.5,
  anger: -1, grief: -1, raw_honesty: -0.2,
};

function tagValence(tag: string): number {
  return VALENCE[tag] ?? 0;
}

/** Build emotional arc from a sequence of memories (ordered by time). */
export function buildArc(memories: ReadonlyArray<{ emotion_tags: string; created_at: number }>): EmotionArc {
  if (memories.length === 0) return { tags: [], direction: "stable", symbol: "—" };

  const allTags: EmotionTag[] = [];
  const valences: number[] = [];

  for (const m of memories) {
    const tags = m.emotion_tags.split(",").map(t => t.trim()).filter(Boolean) as EmotionTag[];
    for (const t of tags) if (!allTags.includes(t)) allTags.push(t);
    const avg = tags.length > 0 ? tags.reduce((s, t) => s + tagValence(t), 0) / tags.length : 0;
    valences.push(avg);
  }

  if (valences.length < 2) return { tags: allTags, direction: "stable", symbol: "—" };

  // Compute direction from trend
  const first = valences.slice(0, Math.ceil(valences.length / 2));
  const second = valences.slice(Math.ceil(valences.length / 2));
  const avgFirst = first.reduce((a, b) => a + b, 0) / first.length;
  const avgSecond = second.reduce((a, b) => a + b, 0) / second.length;
  const diff = avgSecond - avgFirst;

  // Check volatility (standard deviation)
  const mean = valences.reduce((a, b) => a + b, 0) / valences.length;
  const variance = valences.reduce((s, v) => s + (v - mean) ** 2, 0) / valences.length;
  const stddev = Math.sqrt(variance);

  let direction: ArcDirection;
  let symbol: string;

  if (stddev > 0.8) { direction = "volatile"; symbol = "↕"; }
  else if (diff > 0.2) { direction = "rising"; symbol = "↑"; }
  else if (diff < -0.2) { direction = "falling"; symbol = "↓"; }
  else { direction = "stable"; symbol = "→"; }

  return { tags: allTags, direction, symbol };
}
