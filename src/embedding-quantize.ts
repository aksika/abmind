/**
 * embedding-quantize.ts — int8 quantization for embeddings.
 * Reduces float32 (1536 bytes) to int8 (384 bytes) with ~1-2% recall quality drop.
 */

/** Quantize float32 embedding to int8. 4× smaller. */
export function quantizeToInt8(float32: Float32Array): Int8Array {
  const min = float32.reduce((a, b) => Math.min(a, b), Infinity);
  const max = float32.reduce((a, b) => Math.max(a, b), -Infinity);
  const range = max - min || 1;
  const scale = 255 / range;
  const int8 = new Int8Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    int8[i] = Math.round((float32[i]! - min) * scale) - 128;
  }
  return int8;
}

/** Dequantize int8 back to float32 (approximate). Needs original min/max for exact reconstruction. */
export function dequantizeToFloat32(int8: Int8Array, min: number, max: number): Float32Array {
  const range = max - min || 1;
  const scale = range / 255;
  const float32 = new Float32Array(int8.length);
  for (let i = 0; i < int8.length; i++) {
    float32[i] = (int8[i]! + 128) * scale + min;
  }
  return float32;
}

/** Cosine similarity between two int8 vectors (approximate). */
export function cosineSimInt8(a: Int8Array, b: Int8Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
