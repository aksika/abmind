import { describe, it, expect } from "vitest";
import { detectEmotions } from "./emotion-tagger.js";
import { detectFlags } from "./importance-flagger.js";
import { generateSignature, hammingDistance, hammingSimilarity } from "./signature-generator.js";
import { compress } from "./memory-compressor.js";

describe("emotion-tagger", () => {
  it("detects joy", () => {
    expect(detectEmotions("I'm so happy about this")).toContain("joy");
  });

  it("detects fear + anxiety", () => {
    const tags = detectEmotions("I'm worried about the deadline, feeling stressed");
    expect(tags).toContain("anxiety");
  });

  it("detects relief", () => {
    expect(detectEmotions("Finally got it working, phew")).toContain("relief");
  });

  it("detects conviction", () => {
    expect(detectEmotions("I've decided to go with this approach, absolutely certain")).toContain("conviction");
  });

  it("returns empty for neutral text", () => {
    expect(detectEmotions("The function returns an integer")).toEqual([]);
  });

  it("deduplicates tags", () => {
    const tags = detectEmotions("happy and glad and delighted");
    const unique = new Set(tags);
    expect(tags.length).toBe(unique.size);
  });
});

describe("importance-flagger", () => {
  it("detects decision", () => {
    expect(detectFlags("We decided to use Clerk instead of Auth0")).toContain("decision");
  });

  it("detects milestone", () => {
    expect(detectFlags("Finally shipped the new version, it works")).toContain("milestone");
  });

  it("detects technical", () => {
    expect(detectFlags("The database architecture uses SQLite with FTS5")).toContain("technical");
  });

  it("detects pivot", () => {
    expect(detectFlags("That was a turning point, changed everything")).toContain("pivot");
  });

  it("detects correction", () => {
    expect(detectFlags("Actually that was wrong, we corrected the approach")).toContain("correction");
  });

  it("returns empty for neutral text", () => {
    expect(detectFlags("The weather is nice today")).toEqual([]);
  });

  it("detects multiple flags", () => {
    const flags = detectFlags("We decided to deploy the new architecture");
    expect(flags).toContain("decision");
    expect(flags).toContain("technical");
  });
});

describe("signature-generator", () => {
  it("generates 32-byte signature", () => {
    const sig = generateSignature("hello world");
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(32);
  });

  it("identical text produces identical signature", () => {
    const a = generateSignature("We use Clerk for auth");
    const b = generateSignature("We use Clerk for auth");
    expect(hammingDistance(a, b)).toBe(0);
  });

  it("similar text produces small Hamming distance", () => {
    const a = generateSignature("We decided to use Clerk for authentication");
    const b = generateSignature("We chose Clerk for our auth system");
    const dist = hammingDistance(a, b);
    expect(dist).toBeLessThan(128); // less than half the bits differ
  });

  it("different text produces larger Hamming distance", () => {
    const a = generateSignature("We decided to use Clerk for authentication");
    const b = generateSignature("The weather in Budapest is sunny today");
    const similar = generateSignature("We chose Clerk for our auth system");
    expect(hammingDistance(a, b)).toBeGreaterThan(hammingDistance(a, similar));
  });

  it("hammingSimilarity returns 0-1 range", () => {
    const a = generateSignature("test");
    const b = generateSignature("test");
    expect(hammingSimilarity(a, b)).toBe(1);
    const c = generateSignature("completely different unrelated text about cooking");
    const sim = hammingSimilarity(a, c);
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sim).toBeLessThanOrEqual(1);
  });

  it("empty text returns zero signature", () => {
    const sig = generateSignature("");
    expect(sig.every(b => b === 0)).toBe(true);
  });
});

describe("memory-compressor (ABM-L v2)", () => {
  it("uses memory_type as primary flag", () => {
    const result = compress({
      content_en: "We decided to use Clerk instead of Auth0 because pricing is better",
      topic: "coding", emotion_tags: "conviction", importance_flags: "decision",
      memory_type: "decision", confidence: 5, date: "2026-01",
    });
    expect(result).toMatch(/^\[D\|coding\|/);
  });

  it("lesson type gets L flag, not detected flags", () => {
    const result = compress({
      content_en: "Be honest about actions: Don't claim to have done something I haven't actually done",
      topic: "general", emotion_tags: "", importance_flags: "correction,milestone",
      memory_type: "lesson",
    });
    expect(result).toMatch(/^\[LC?M?\|/); // L primary, C and M secondary
    expect(result).not.toMatch(/^\[CM\|/); // NOT CM without L
  });

  it("preference type gets P flag", () => {
    const result = compress({
      content_en: "User prefers dark mode and minimal code",
      topic: "personal", emotion_tags: "", importance_flags: "preference",
      memory_type: "preference", confidence: 4,
    });
    expect(result).toMatch(/^\[P\|personal\|/);
  });

  it("preserves paths", () => {
    const result = compress({
      content_en: "The deploy script is at /home/user/scripts/deploy.sh",
      topic: "coding", emotion_tags: "", importance_flags: "technical",
      memory_type: "fact",
    });
    expect(result).toContain("/home/user/scripts/deploy.sh");
  });

  it("preserves URLs", () => {
    const result = compress({
      content_en: "API endpoint is https://openrouter.ai/api/v1",
      topic: "coding", emotion_tags: "", importance_flags: "technical",
      memory_type: "fact",
    });
    expect(result).toContain("https://openrouter.ai/api/v1");
  });

  it("preserves negations and pronouns", () => {
    const result = compress({
      content_en: "Don't claim to have done something I haven't done",
      topic: "personal", emotion_tags: "", importance_flags: "",
      memory_type: "lesson",
    });
    expect(result).toContain("Don't");
    expect(result).toContain("I");
    expect(result).toContain("haven't");
  });

  it("does not @reference unknown capitalized words", () => {
    const result = compress({
      content_en: "Vincent story - ask who it is, don't make things up",
      topic: "personal", emotion_tags: "", importance_flags: "",
      memory_type: "lesson",
    });
    expect(result).not.toContain("@vincent");
  });

  it("abbreviates platform names", () => {
    const result = compress({
      content_en: "Telegram poller failed, Discord back-online send failed",
      topic: "coding", emotion_tags: "", importance_flags: "",
      memory_type: "event",
    });
    expect(result).toContain("TG");
    expect(result).toContain("DC");
  });

  it("infers topic from content", () => {
    const result = compress({
      content_en: "The database architecture uses SQLite with FTS5",
      topic: "general", emotion_tags: "", importance_flags: "technical",
      memory_type: "fact",
    });
    expect(result).toMatch(/\|coding\|/);
  });

  it("no truncation — long content preserved", () => {
    const long = "Bug report: " + "issue description ".repeat(20);
    const result = compress({
      content_en: long, topic: "coding",
      emotion_tags: "", importance_flags: "",
      memory_type: "event",
    });
    expect(result).not.toContain("...");
  });
});

describe("store integration — v2 columns populated", () => {
  it("instant-store populates emotion_tags, importance_flags, signature", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { MemoryManager } = await import("./memory-manager.js");
    const { makeMemoryTestConfig } = await import("./test-helpers.js");

    const tmpDir = mkdtempSync(join(tmpdir(), "abm-v2-store-"));
    const mm = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await mm.initialize({ skipEmbeddingCheck: true });

    await mm.editor.instantStore({
      userId: "user-1", contentEn: "We decided to use Clerk instead of Auth0",
      contentOriginal: "Clerk-et választottuk Auth0 helyett",
      memoryType: "decision", emotionScore: 3, topic: "coding",
    });

    const db = mm.getDatabase()!;
    const row = db.prepare("SELECT emotion_tags, importance_flags, signature FROM extracted_memories ORDER BY id DESC LIMIT 1").get() as {
      emotion_tags: string | null; importance_flags: string | null; signature: Buffer | null;
    };

    expect(row.emotion_tags).toBeTruthy();
    expect(row.importance_flags).toContain("decision");
    expect(row.signature).toBeInstanceOf(Buffer);
    expect(row.signature!.length).toBe(32);

    mm.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
