/**
 * embedding-integrity.ts — Pure, package-internal embedding validator
 * parameterized by the configured embedding dimension (#1659).
 *
 * Replaces three independent hardcoded implementations (maintenance preflight
 * used 384, operator diagnostics and repair used 768). The helper never reads
 * environment variables and never mutates a row.
 */

export type EmbeddingIntegrity =
  | { readonly valid: true; readonly encoding: "float32" | "int8" }
  | { readonly valid: false; readonly reason: "wrong_length" | "non_finite" };

/**
 * Classify an embedding buffer against the configured dimensions.
 *
 * - `dimensions * 4` bytes is interpreted as little-endian float32; every
 *   element must be finite (`Number.isFinite`, not only non-NaN).
 * - `dimensions` bytes is treated as valid int8.
 * - Every other byte length is `wrong_length`.
 *
 * Throws for non-positive or non-safe dimensions — callers must reject those
 * at their boundary before inspecting any row.
 */
export function classifyEmbedding(embedding: Buffer, dimensions: number): EmbeddingIntegrity {
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
    throw new Error(`invalid embedding dimensions: ${dimensions}`);
  }
  const int8Bytes = dimensions;
  if (embedding.byteLength === int8Bytes) return { valid: true, encoding: "int8" };
  const float32Bytes = dimensions * 4;
  if (embedding.byteLength !== float32Bytes) return { valid: false, reason: "wrong_length" };
  const bytes = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < dimensions; i++) {
    if (!Number.isFinite(view.getFloat32(i * 4, true))) return { valid: false, reason: "non_finite" };
  }
  return { valid: true, encoding: "float32" };
}
