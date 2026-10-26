/**
 * Maximal Marginal Relevance (MMR) re-ranking.
 *
 * Iteratively selects results that balance relevance (score) with diversity
 * (low similarity to already-selected results). Uses Jaccard token similarity.
 *
 * Performance: each candidate is tokenized once per invocation, and each
 * remaining candidate keeps a running maximum similarity updated against only
 * the newly selected result. The running maximum equals the maximum
 * recomputed over the whole selected set, so ordering is identical to the
 * naive recomputation while pair work falls from cubic to quadratic growth.
 */

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
}

/** Jaccard similarity on pre-tokenized lowercased word sets. */
function jaccardSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const small = a.size <= b.size ? a : b;
  const big = small === a ? b : a;
  let intersection = 0;
  for (const t of small) if (big.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
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
  const tokenSets = remaining.map((r) => tokenize(r.content));
  const maxSim = new Array<number>(remaining.length).fill(0);
  // Alive flags keep tokenSets/maxSim indexed by original position so the
  // running maximum survives removals without reindexing.
  const alive = new Array<boolean>(remaining.length).fill(true);
  const selected: T[] = [];

  const takeFirst = (): void => {
    const idx = alive.findIndex(Boolean);
    selected.push(remaining[idx]!);
    alive[idx] = false;
    updateMaxSim(idx);
  };

  // Fold the newly selected candidate's similarities into every remaining
  // candidate's running maximum. Order of evaluation never changes.
  function updateMaxSim(selectedIdx: number): void {
    const selectedTokens = tokenSets[selectedIdx]!;
    for (let i = 0; i < remaining.length; i++) {
      if (!alive[i]) continue;
      const sim = jaccardSets(tokenSets[i]!, selectedTokens);
      if (sim > maxSim[i]!) maxSim[i] = sim;
    }
  }

  // First pick is always the highest-scoring result
  takeFirst();

  while (true) {
    let bestIdx = -1;
    let bestMMR = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      if (!alive[i]) continue;
      const candidate = remaining[i]!;
      const mmrScore = lambda * candidate.score - (1 - lambda) * maxSim[i]!;
      // Strict comparison: ties keep the earliest remaining index.
      if (mmrScore > bestMMR) { bestMMR = mmrScore; bestIdx = i; }
    }
    if (bestIdx === -1) break;

    selected.push(remaining[bestIdx]!);
    alive[bestIdx] = false;
    updateMaxSim(bestIdx);
  }

  return selected;
}
