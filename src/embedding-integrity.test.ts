import { describe, it, expect } from "vitest";
import { classifyEmbedding } from "./embedding-integrity.js";

function float32Buffer(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) buf.writeFloatLE(values[i]!, i * 4);
  return buf;
}

describe("classifyEmbedding", () => {
  it("accepts configured-dimension float32 with finite elements", () => {
    const buf = float32Buffer(Array.from({ length: 768 }, () => 0.5));
    expect(classifyEmbedding(buf, 768)).toEqual({ valid: true, encoding: "float32" });
  });

  it("accepts configured-dimension int8", () => {
    const buf = Buffer.alloc(768, 1);
    expect(classifyEmbedding(buf, 768)).toEqual({ valid: true, encoding: "int8" });
  });

  it("accepts a 384-dimension provider configuration", () => {
    const buf = float32Buffer(Array.from({ length: 384 }, () => -0.25));
    expect(classifyEmbedding(buf, 384)).toEqual({ valid: true, encoding: "float32" });
  });

  it("rejects wrong byte lengths for the configured dimensions", () => {
    expect(classifyEmbedding(Buffer.alloc(500), 768)).toEqual({ valid: false, reason: "wrong_length" });
    expect(classifyEmbedding(Buffer.alloc(100), 384)).toEqual({ valid: false, reason: "wrong_length" });
  });

  it("rejects NaN and Infinity float32 elements as non-finite", () => {
    const nanBuf = float32Buffer(Array.from({ length: 768 }, () => 0));
    nanBuf.writeFloatLE(Number.NaN, 767 * 4);
    expect(classifyEmbedding(nanBuf, 768)).toEqual({ valid: false, reason: "non_finite" });

    const infBuf = float32Buffer(Array.from({ length: 768 }, () => 0));
    infBuf.writeFloatLE(Number.POSITIVE_INFINITY, 0);
    expect(classifyEmbedding(infBuf, 768)).toEqual({ valid: false, reason: "non_finite" });
  });

  it("rejects non-positive and non-safe dimensions at the caller boundary", () => {
    for (const dims of [0, -4, 1.5, Number.NaN]) {
      expect(() => classifyEmbedding(Buffer.alloc(10), dims)).toThrow(/invalid embedding dimensions/);
    }
  });
});
