import { describe, it, expect } from "vitest";
import { stripMediaPayloads, sanitizeForSummary } from "./media-sanitizer.js";

describe("stripMediaPayloads", () => {
  it("returns text unchanged when no media", () => {
    expect(stripMediaPayloads("Hello world")).toBe("Hello world");
  });

  it("strips base64 data URLs", () => {
    const input = "Check this image: data:image/png;base64,iVBORw0KGgoAAAANSUhEUg== done";
    const result = stripMediaPayloads(input);
    expect(result).toContain("[embedded media omitted]");
    expect(result).not.toContain("iVBORw0");
  });

  it("strips MEDIA:/ paths", () => {
    expect(stripMediaPayloads("MEDIA:/Users/akos/photo.jpg")).toBe("[Media attachment]");
  });

  it("strips binary-looking lines", () => {
    const binary = "AAAA".repeat(64); // 256 chars, all base64
    expect(stripMediaPayloads(binary)).toBe("[Media attachment]");
  });

  it("preserves normal multiline text", () => {
    const input = "Line 1\nLine 2\nLine 3";
    expect(stripMediaPayloads(input)).toBe(input);
  });

  it("returns [Media attachment] for empty content", () => {
    expect(stripMediaPayloads("")).toBe("");
  });
});

describe("sanitizeForSummary", () => {
  it("returns text unchanged when no media", () => {
    expect(sanitizeForSummary("Hello")).toBe("Hello");
  });

  it("returns [Media attachment] for media-only path", () => {
    expect(sanitizeForSummary("MEDIA:/photo.jpg")).toBe("[Media attachment]");
  });
});
