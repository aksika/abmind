import { describe, it, expect } from "vitest";
import { extractEnglishTokens } from "./query-tokenizer.js";

describe("extractEnglishTokens", () => {
  it("extracts proper noun from mixed-language prompt (production failure case)", () => {
    // The exact production bug: Hungarian prompt with one English proper noun
    // that must hit the joke memory via trigram on content_en.
    const out = extractEnglishTokens("fasza, es ki Morgenson a viccbol?");
    expect(out).toContain("Morgenson");
  });

  it("documented false-positive: ASCII Hungarian words slip through", () => {
    // "fasza" is pure ASCII length 5 → survives tokenization. That's OK —
    // false positives just fail to match anything, unlike false negatives
    // which would drop real English tokens. Documenting this so future
    // readers don't try to "fix" it with Hungarian-specific rules.
    const out = extractEnglishTokens("fasza");
    expect(out).toEqual(["fasza"]);
  });

  it("returns empty array for too-short input", () => {
    expect(extractEnglishTokens("hi")).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(extractEnglishTokens("")).toEqual([]);
  });

  it("returns empty array for null-ish input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractEnglishTokens(null as any)).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractEnglishTokens(undefined as any)).toEqual([]);
  });

  it("filters stopwords (articles, auxiliaries, pronouns)", () => {
    expect(extractEnglishTokens("the and for")).toEqual([]);
    expect(extractEnglishTokens("what you know about this")).toEqual(["know"]);
  });

  it("keeps English content words, strips stopwords", () => {
    const out = extractEnglishTokens("what do you know about Patchright?");
    expect(out).toContain("Patchright");
    expect(out).toContain("know");
    // Stopwords removed
    expect(out).not.toContain("what");
    expect(out).not.toContain("you");
    expect(out).not.toContain("about");
  });

  it("rejects tokens with Hungarian diacritics", () => {
    const out = extractEnglishTokens("váltókezelő Budapest");
    expect(out).not.toContain("váltókezelő");
    // Budapest is ASCII proper noun — kept
    expect(out).toContain("Budapest");
  });

  it("accented-free Hungarian ASCII words survive (documented noise)", () => {
    // Confirms the known tradeoff: "viccet", "mondj", "egy" are ASCII-only
    // and pass the filter despite being Hungarian. They just don't match
    // anything in content_en, so downstream recall is unharmed.
    const out = extractEnglishTokens("mondj egy viccet");
    // All three are ASCII; "egy" is length 3 so passes MIN_LEN.
    expect(out).toContain("mondj");
    expect(out).toContain("viccet");
  });

  it("preserves proper nouns even in otherwise-non-English sentence", () => {
    const out = extractEnglishTokens("ki Morgenson?");
    expect(out).toEqual(["Morgenson"]);
  });

  it("deduplicates across case (Docker vs docker kept separately by design)", () => {
    // Proper-noun path and lowercase path use different seen-keys.
    // "Docker" → kept as-is via proper-noun path.
    // "docker" → lowercased, added with key "docker". Different key from "Docker".
    // Result: both shapes appear. Harmless — each contributes to recall independently.
    const out = extractEnglishTokens("Docker docker Docker");
    // Single "Docker" from the proper-noun path (deduped on exact string),
    // single "docker" from the lowercase path.
    expect(out.filter(t => t === "Docker")).toHaveLength(1);
    expect(out.filter(t => t === "docker")).toHaveLength(1);
  });

  it("handles punctuation and commas", () => {
    const out = extractEnglishTokens("Hey, Morgenson, how are you?");
    expect(out).toContain("Morgenson");
  });

  it("real-world: single Hungarian word below MIN_LEN → empty → caller falls back", () => {
    // Caller uses `englishTokens.length > 0 ? englishTokens : [prompt]`.
    // This test documents the fallback trigger.
    expect(extractEnglishTokens("mi")).toEqual([]);
  });

  it("real-world: English prompt about a memory entity", () => {
    const out = extractEnglishTokens("what do you know about the Morgenson joke");
    expect(out).toContain("Morgenson");
    expect(out).toContain("joke");
    expect(out).toContain("know");
    // Stopwords removed
    expect(out).not.toContain("what");
    expect(out).not.toContain("the");
    expect(out).not.toContain("you");
    expect(out).not.toContain("about");
  });
});
