import { describe, it, expect } from "vitest";
import { quantizeToInt8, cosineSimInt8 } from "./embedding-quantize.js";

describe("embedding-quantize", () => {
  it("quantizes float32 to int8", () => {
    const float32 = new Float32Array([0.0, 0.5, 1.0, -0.5, -1.0]);
    const int8 = quantizeToInt8(float32);
    expect(int8).toBeInstanceOf(Int8Array);
    expect(int8.length).toBe(5);
  });

  it("int8 is 4× smaller than float32", () => {
    const float32 = new Float32Array(384);
    for (let i = 0; i < 384; i++) float32[i] = Math.random() * 2 - 1;
    const int8 = quantizeToInt8(float32);
    expect(int8.byteLength).toBe(384);
    expect(float32.byteLength).toBe(1536);
  });

  it("preserves relative similarity", () => {
    // Two similar vectors
    const a = new Float32Array(64);
    const b = new Float32Array(64);
    const c = new Float32Array(64);
    for (let i = 0; i < 64; i++) {
      a[i] = Math.random();
      b[i] = a[i]! + (Math.random() - 0.5) * 0.1; // similar to a
      c[i] = Math.random(); // random, different
    }
    const qa = quantizeToInt8(a);
    const qb = quantizeToInt8(b);
    const qc = quantizeToInt8(c);

    const simAB = cosineSimInt8(qa, qb);
    const simAC = cosineSimInt8(qa, qc);
    // a-b should be more similar than a-c
    expect(simAB).toBeGreaterThan(simAC);
  });

  it("identical vectors have similarity ~1", () => {
    const a = new Float32Array(64);
    for (let i = 0; i < 64; i++) a[i] = Math.random();
    const qa = quantizeToInt8(a);
    expect(cosineSimInt8(qa, qa)).toBeCloseTo(1, 1);
  });
});
