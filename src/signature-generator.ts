/**
 * signature-generator.ts — Binary signatures via Random Indexing.
 * 256-bit (32-byte) semantic hash. Hamming distance for similarity search.
 * No external dependency, no embedding model needed.
 */

const SIGNATURE_BYTES = 32; // 256 bits
const SEED = 42;

/** Simple seeded PRNG (mulberry32) for reproducible hyperplanes. */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tokenize text into lowercase word tokens. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z0-9_-]{1,}/g) ?? [];
}

// Pre-generate random vectors for hashing (one per bit position).
// Each "hyperplane" is a map from token hash → +1/-1 weight.
const rng = mulberry32(SEED);
const HYPERPLANES: Float32Array[] = Array.from({ length: SIGNATURE_BYTES * 8 }, () => {
  const plane = new Float32Array(256);
  for (let i = 0; i < 256; i++) plane[i] = rng() < 0.5 ? -1 : 1;
  return plane;
});

/** Hash a token string to a bucket index (0-255). */
function tokenHash(token: string): number {
  let h = 0;
  for (let i = 0; i < token.length; i++) {
    h = ((h << 5) - h + token.charCodeAt(i)) | 0;
  }
  return (h & 0x7FFFFFFF) % 256;
}

/**
 * Generate a 256-bit binary signature for text via Random Indexing.
 * Semantically similar texts produce signatures with small Hamming distance.
 */
export function generateSignature(text: string): Uint8Array {
  const tokens = tokenize(text);
  if (tokens.length === 0) return new Uint8Array(SIGNATURE_BYTES);

  const sig = new Uint8Array(SIGNATURE_BYTES);
  const sums = new Float32Array(SIGNATURE_BYTES * 8);

  for (const token of tokens) {
    const bucket = tokenHash(token);
    for (let bit = 0; bit < SIGNATURE_BYTES * 8; bit++) {
      sums[bit]! += HYPERPLANES[bit]![bucket]!;
    }
  }

  for (let bit = 0; bit < SIGNATURE_BYTES * 8; bit++) {
    if (sums[bit]! > 0) sig[bit >> 3]! |= (1 << (bit & 7));
  }

  return sig;
}

/** Hamming distance between two signatures (number of differing bits). */
export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let xor = (a[i]! ^ b[i]!) & 0xFF;
    while (xor) { dist++; xor &= xor - 1; }
  }
  return dist;
}

/** Similarity score from Hamming distance (0-1, higher = more similar). */
export function hammingSimilarity(a: Uint8Array, b: Uint8Array): number {
  const maxBits = a.length * 8;
  return 1 - (hammingDistance(a, b) / maxBits);
}
