import { describe, expect, it } from "vitest";
import {
  parseSourceMessageIds,
  SourceMessageIdsError,
  MAX_SOURCE_MESSAGE_IDS,
} from "./source-message-ids.js";

describe("parseSourceMessageIds", () => {
  it("returns an empty list for null, undefined, and blank input", () => {
    expect(parseSourceMessageIds(null)).toEqual([]);
    expect(parseSourceMessageIds(undefined)).toEqual([]);
    expect(parseSourceMessageIds("")).toEqual([]);
    expect(parseSourceMessageIds("   ")).toEqual([]);
  });

  it("parses a canonical CSV into caller-ordered unique integers", () => {
    expect(parseSourceMessageIds("12,112,7")).toEqual([12, 112, 7]);
  });

  it("trims surrounding whitespace around tokens", () => {
    expect(parseSourceMessageIds(" 12 , 7 ")).toEqual([12, 7]);
  });

  it("never confuses ID 12 with ID 112", () => {
    expect(parseSourceMessageIds("112")).toEqual([112]);
    expect(parseSourceMessageIds("112").includes(12)).toBe(false);
    expect(parseSourceMessageIds("12,112")).toEqual([12, 112]);
  });

  it("rejects malformed tokens", () => {
    const malformed = ["1,,2", "1, 2x", "+1", "-1", "1.0", "1e2", "  ,1"];
    for (const value of malformed) {
      expect(() => parseSourceMessageIds(value), value).toThrow(SourceMessageIdsError);
    }
  });

  it("rejects zero and non-digit-only tokens", () => {
    expect(() => parseSourceMessageIds("0")).toThrow(SourceMessageIdsError);
    expect(() => parseSourceMessageIds("1,  ")).toThrow(SourceMessageIdsError);
  });

  it("rejects duplicates", () => {
    expect(() => parseSourceMessageIds("1,1")).toThrow(SourceMessageIdsError);
    expect(() => parseSourceMessageIds("7,8,7")).toThrow(SourceMessageIdsError);
  });

  it("rejects non-safe integers", () => {
    expect(() => parseSourceMessageIds(String(Number.MAX_SAFE_INTEGER + 1))).toThrow(SourceMessageIdsError);
    expect(() => parseSourceMessageIds("99999999999999999999")).toThrow(SourceMessageIdsError);
  });

  it("rejects more than the maximum number of IDs", () => {
    const tooMany = Array.from({ length: MAX_SOURCE_MESSAGE_IDS + 1 }, (_, i) => String(i + 1)).join(",");
    expect(() => parseSourceMessageIds(tooMany)).toThrow(SourceMessageIdsError);
    const atLimit = Array.from({ length: MAX_SOURCE_MESSAGE_IDS }, (_, i) => String(i + 1)).join(",");
    expect(parseSourceMessageIds(atLimit)).toHaveLength(MAX_SOURCE_MESSAGE_IDS);
  });

  it("throws an error that carries no source content", () => {
    try {
      parseSourceMessageIds("secret-content,42");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SourceMessageIdsError);
      expect((err as Error).message).not.toContain("secret-content");
    }
  });
});
