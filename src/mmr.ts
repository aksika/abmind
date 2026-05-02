/**
 * Maximal Marginal Relevance (MMR) re-ranking.
 *
 * Iteratively selects results that balance relevance (score) with diversity
 * (low similarity to already-selected results). Uses Jaccard token similarity.
 */

/** Jaccard similarity on lowercased word tokens. */
function jaccard(a: string, b: string): number {
  const tokA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (!tokA.size || !tokB.size) return 0;
  let intersection = 0;
  for (const t of tokA) if (tokB.has(t)) intersection++;
  return intersection / (tokA.size + tokB.size - intersection);
}

/**
 * Re-rank results using MMR.
 * @param results - Pre-sorted by relevance score (descending). Each must have `content` and `score`.
 * @param lambda  - Balance: 1.0 = pure relevance, 0.0 = pure diversity. Default 0.7.
 * @returns New array in MMR order.
 */
export function applyMMR<T extends { content: string; score: number }>(results: T[], lambda = 0.7): T[] {
  if (results.length <= 1) return results;

  const remaining = [...results];
  const selected: T[] = [];

  // First pick is always the highest-scoring result
  selected.push(remaining.shift()!);

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestMMR = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      const maxSim = Math.max(...selected.map(s => jaccard(candidate.content, s.content)));
      const mmrScore = lambda * candidate.score - (1 - lambda) * maxSim;
      if (mmrScore > bestMMR) { bestMMR = mmrScore; bestIdx = i; }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]!);
  }

  return selected;
}
