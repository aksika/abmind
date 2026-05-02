/**
 * brain-patterns.ts — Brain-inspired memory enhancements.
 * Pure functions used by recall, store, and sleep steps.
 */

/** E1: Flashbulb protection — is this memory protected from decay/aging? */
export function isFlashbulb(emotionScore: number, importanceFlags: string): boolean {
  if (Math.abs(emotionScore) < 4) return false;
  return importanceFlags.includes("pivot") || importanceFlags.includes("correction");
}

/** E1: Is this memory protected from aging (broader than flashbulb)? */
export function isAgingProtected(emotionScore: number, recallCount: number, tier: string): boolean {
  if (Math.abs(emotionScore) >= 4) return true;
  if (recallCount >= 3) return true;
  if (tier === "core") return true;
  return false;
}

/**
 * E2: Spaced repetition decay — compute effective confidence.
 * Confidence decays over time unless the memory is recalled at intervals.
 * Per-category profiles: facts/decisions/events never decay, preferences decay slowly, observations decay fast.
 */
export function effectiveConfidence(
  baseConfidence: number,
  daysSinceLastRecall: number,
  recallCount: number,
  memoryType?: string,
): number {
  // No-decay types: confidence only drops via contradiction (external edit)
  if (memoryType === "fact" || memoryType === "decision" || memoryType === "event" || memoryType === "story") {
    return baseConfidence;
  }

  // Fast decay: observations (agent-inferred) — 60-day half-life, floor 0.3 (on 1-5 scale → floor ~1)
  if (memoryType === "observation") {
    const decay = Math.max(0, 1 - daysSinceLastRecall / 120);
    return Math.max(1, Math.round(baseConfidence * decay * 10) / 10);
  }

  // Slow decay: preferences, lessons, feedback — 730-day half-life
  if (memoryType === "preference" || memoryType === "lesson" || memoryType === "feedback") {
    if (recallCount === 0) {
      const decay = Math.max(0, 1 - daysSinceLastRecall / 365);
      return Math.max(2, Math.round(baseConfidence * decay * 10) / 10);
    }
    const stability = Math.min(1, Math.log2(recallCount + 1) / 3);
    const decay = Math.max(0, 1 - (daysSinceLastRecall / (365 + stability * 365)));
    return Math.max(2, Math.round(baseConfidence * decay * 10) / 10);
  }

  // Default fallback (unknown types): original formula
  if (recallCount === 0) {
    const decay = Math.max(0, 1 - daysSinceLastRecall / 90);
    return Math.round(baseConfidence * decay * 10) / 10;
  }
  const stability = Math.min(1, Math.log2(recallCount + 1) / 3);
  const decay = Math.max(0, 1 - (daysSinceLastRecall / (90 + stability * 270)));
  return Math.round(baseConfidence * decay * 10) / 10;
}

/**
 * E6: Interference detection — check if two memories might cause confusion.
 * Same topic, high keyword overlap, but different content.
 */
export function detectInterference(
  contentA: string,
  contentB: string,
  topicA: string,
  topicB: string,
): boolean {
  if (topicA !== topicB) return false;

  const wordsA = new Set(contentA.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const wordsB = new Set(contentB.toLowerCase().match(/[a-z]{3,}/g) ?? []);

  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;

  const overlapRatio = overlap / Math.min(wordsA.size, wordsB.size);

  // High overlap (>60%) but not identical = potential interference
  return overlapRatio > 0.6 && contentA !== contentB;
}
