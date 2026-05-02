import { describe, it, expect, vi } from "vitest";
import { parseFlags, FlagError, type FlagSpec } from "./cli-flags.js";

const STORE_SPECS: FlagSpec[] = [
  { name: "translated", type: "string", aliases: ["--content-en"] },
  { name: "original", type: "string", aliases: ["--content-original"] },
  { name: "chat-id", type: "string" },
  { name: "emotion-score", type: "number" },
  { name: "memory-type", type: "string" },
  { name: "boost", type: "boolean" },
];

describe("parseFlags", () => {
  it("parses string / number / boolean by canonical name", () => {
    const r = parseFlags(
      ["--translated", "hello", "--emotion-score", "3", "--boost"],
      STORE_SPECS,
    );
    expect(r["translated"]).toBe("hello");
    expect(r["emotion-score"]).toBe(3);
    expect(r["boost"]).toBe(true);
  });

  it("resolves aliases to canonical name", () => {
    const r = parseFlags(["--content-en", "aliased"], STORE_SPECS);
    expect(r["translated"]).toBe("aliased");
    expect(r["content-en"]).toBeUndefined();
  });

  it("rejects value starting with -- (args[++i] eating fix)", () => {
    expect(() => parseFlags(["--translated", "--chat-id", "1"], STORE_SPECS))
      .toThrow(FlagError);
    expect(() => parseFlags(["--translated", "--chat-id", "1"], STORE_SPECS))
      .toThrow(/flag --translated requires a value/);
  });

  it("rejects missing value at end of argv", () => {
    expect(() => parseFlags(["--translated"], STORE_SPECS)).toThrow(FlagError);
  });

  it("rejects non-numeric value for number flag", () => {
    expect(() => parseFlags(["--emotion-score", "high"], STORE_SPECS))
      .toThrow(/requires a number/);
  });

  it("warns and skips unknown flags (matches historical behavior)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = parseFlags(["--unknown", "value", "--boost"], STORE_SPECS);
    expect(r["boost"]).toBe(true);
    expect(r["unknown"]).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("unknown flag --unknown"));
    spy.mockRestore();
  });

  it("skips positional / stray tokens silently", () => {
    const r = parseFlags(["positional", "--boost", "another"], STORE_SPECS);
    expect(r["boost"]).toBe(true);
  });

  it("handles empty argv", () => {
    expect(parseFlags([], STORE_SPECS)).toEqual({});
  });
});
