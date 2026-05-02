/**
 * contradiction-checker.ts — Detect conflicting facts before core promotion.
 * Heuristic: same topic + overlapping keywords + negation/replacement = contradiction.
 */

export interface ContradictionHit {
  existingId: number;
  existingContent: string;
  reason: string;
}

/** Check if new content contradicts any existing core memory in the same topic. */
export function checkContradiction(
  newContent: string,
  topic: string,
  existingCore: ReadonlyArray<{ id: number; content_en: string; topic: string }>,
): ContradictionHit | null {
  const newLower = newContent.toLowerCase();
  const newWords = new Set(newLower.match(/[a-z]{3,}/g) ?? []);

  for (const existing of existingCore) {
    if (existing.topic !== topic) continue;

    const existLower = existing.content_en.toLowerCase();
    const existWords = new Set(existLower.match(/[a-z]{3,}/g) ?? []);

    // Compute keyword overlap
    let overlap = 0;
    for (const w of newWords) if (existWords.has(w)) overlap++;
    if (overlap < 2) continue; // not enough overlap to be about the same thing

    // Check for negation/replacement patterns
    const negationPatterns = [
      /\bnot\b.*\buse\b|\bno longer\b|\bstopped\b|\bswitched from\b|\breplaced\b|\binstead of\b|\bwas wrong\b|\bactually\b/,
    ];

    const hasNegation = negationPatterns.some(p => p.test(newLower));
    if (!hasNegation) continue;

    // Check if the negation targets something in the existing memory
    const overlapWords = [...newWords].filter(w => existWords.has(w));
    if (overlapWords.length >= 2) {
      return {
        existingId: existing.id,
        existingContent: existing.content_en,
        reason: `Potential contradiction: overlapping keywords [${overlapWords.slice(0, 5).join(", ")}] with negation pattern`,
      };
    }
  }

  return null;
}
