/**
 * citation-detector.ts — Detect which recalled memories the agent actually used in its response.
 * Pure functions, no LLM, ~1ms per recall set.
 */

export interface RecallMemoryRef {
  id: number;
  contentEn: string;
}

/**
 * Detect which recalled memories are cited in the agent's response.
 * Primary: substring match (≥20 chars). Fallback: ≥5 overlapping substantive keywords.
 */
export function detectCitations(response: string, memories: RecallMemoryRef[]): number[] {
  if (!response || memories.length === 0) return [];
  const responseLower = response.toLowerCase();
  const cited: number[] = [];

  for (const mem of memories) {
    if (!mem.contentEn) continue;
    if (hasSubstringMatch(responseLower, mem.contentEn.toLowerCase())) {
      cited.push(mem.id);
    } else if (hasKeywordOverlap(responseLower, mem.contentEn.toLowerCase())) {
      cited.push(mem.id);
    }
  }
  return cited;
}

/** Check if response contains a ≥20 char substring from the memory. */
function hasSubstringMatch(responseLower: string, memLower: string): boolean {
  // Slide 20-char windows from the memory and check presence in response
  if (memLower.length < 20) return false;
  const step = 10; // check every 10 chars for performance
  for (let i = 0; i <= memLower.length - 20; i += step) {
    const window = memLower.slice(i, i + 20);
    if (responseLower.includes(window)) return true;
  }
  return false;
}

/** Check if response has ≥5 overlapping substantive keywords with the memory. */
function hasKeywordOverlap(responseLower: string, memLower: string): boolean {
  const memWords = extractKeywords(memLower);
  if (memWords.size < 5) return false; // memory too short for keyword signal
  const responseWords = extractKeywords(responseLower);
  let overlap = 0;
  for (const w of memWords) {
    if (responseWords.has(w)) overlap++;
    if (overlap >= 5) return true;
  }
  return false;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "have", "has", "had",
  "was", "were", "been", "are", "not", "but", "they", "their", "what", "when",
  "which", "will", "would", "could", "should", "about", "into", "more", "some",
  "than", "them", "then", "there", "these", "those", "very", "also", "just",
]);

function extractKeywords(text: string): Set<string> {
  const words = text.match(/[a-z]{4,}/g) ?? [];
  return new Set(words.filter(w => !STOP_WORDS.has(w)));
}
