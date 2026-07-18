import { describe, it, expect } from "vitest";
import { encodeFrame, decodeFrameHead, createFrameAccumulator, FrameCodecError, FRAME_MAX_PAYLOAD_BYTES } from "./abmind-frame-codec.js";

describe("FrameCodec", () => {
  it("encodes and decodes a frame", () => {
    const payload = Buffer.from('{"hello":"world"}', "utf-8");
    const frame = encodeFrame(payload);
    const head = decodeFrameHead(frame);
    expect(head).not.toBeNull();
    if (head) expect(head.length).toBe(payload.length);
  });

  it("rejects oversized payload", () => {
    const big = Buffer.alloc(FRAME_MAX_PAYLOAD_BYTES + 1);
    expect(() => encodeFrame(big)).toThrow(FrameCodecError);
  });

  it("decodeFrameHead returns null for partial header", () => {
    const partial = Buffer.alloc(2);
    expect(decodeFrameHead(partial)).toBeNull();
  });

  it("rejects zero-length frame", () => {
    const frame = Buffer.alloc(4);
    expect(() => decodeFrameHead(frame)).toThrow(FrameCodecError);
  });

  it("rejects excessive declared length", () => {
    const frame = Buffer.alloc(8);
    frame.writeUInt32BE(FRAME_MAX_PAYLOAD_BYTES + 1);
    expect(() => decodeFrameHead(frame)).toThrow(FrameCodecError);
  });

  it("accumulator assembles frames from chunks", () => {
    const acc = createFrameAccumulator();
    const payload = Buffer.from("test-payload", "utf-8");
    const frame = encodeFrame(payload);
    const half = Math.floor(frame.length / 2);
    acc.push(frame.subarray(0, half));
    expect(acc.readFrame()).toBeNull();
    acc.push(frame.subarray(half));
    const result = acc.readFrame();
    expect(result).not.toBeNull();
    if (result) expect(result.payload.toString()).toBe("test-payload");
  });

  it("accumulator handles multiple frames", () => {
    const acc = createFrameAccumulator();
    const f1 = encodeFrame(Buffer.from("a"));
    const f2 = encodeFrame(Buffer.from("b"));
    acc.push(Buffer.concat([f1, f2]));
    const r1 = acc.readFrame();
    const r2 = acc.readFrame();
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    if (r1) expect(r1.payload.toString()).toBe("a");
    if (r2) expect(r2.payload.toString()).toBe("b");
    expect(acc.readFrame()).toBeNull();
  });
});
