import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./memory-db.js";
import { parseArgs } from "../cli/abmind-store.js";
import { validateArgs } from "../cli/abmind-store.js";

describe("Memory Darwinism", () => {
  let tmpDir: string;
  let db: ReturnType<typeof initializeDatabase>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "darwinism-"));
    process.env.ABMIND_USER_ID = "user-100";
    db = initializeDatabase(join(tmpDir, "memory.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("abmind-store parseArgs", () => {
    it("parses --confidence flag", () => {
      const args = parseArgs(["node", "store", "--content-en", "test", "--confidence", "4"]);
      expect(args.confidence).toBe("4");
    });

    it("parses --source-ids flag", () => {
      const args = parseArgs(["node", "store", "--source-ids", "10,11,12"]);
      expect(args.sourceMessageIds).toBe("10,11,12");
    });

    it("parses --classification flag", () => {
      const args = parseArgs(["node", "store", "--classification", "3"]);
      expect(args.classification).toBe("3");
    });

    it("sealed stores require --sealed-label and accept secret type without --content-en", () => {
      const missing = validateArgs({
        contentOriginal: "hunter2", memoryType: "secret", emotionScore: "0",
        userId: "u", classification: "3",
      });
      expect(missing.ok).toBe(false);
      const sealed = validateArgs({
        contentOriginal: "hunter2", memoryType: "secret", emotionScore: "0",
        userId: "u", classification: "3", sealedLabel: "backup code", sealedKeyword: "recovery",
      });
      expect(sealed.ok).toBe(true);
      if (!sealed.ok) return;
      expect(sealed.params.sealedLabel).toBe("backup code");
      expect(sealed.params.classification).toBe(3);
    });
  });

  describe("trust + integrity + credibility fields", () => {
    it("parseArgs handles --trust --integrity --credibility", () => {
      const raw = parseArgs(["node", "store",
        "--content-en", "test", "--content-original", "teszt",
        "--memory-type", "fact", "--emotion-score", "0", "--chat-id", "123",
        "--trust", "1", "--integrity", "3", "--credibility", "4",
      ]);
      expect(raw.trust).toBe("1");
      expect(raw.integrity).toBe("3");
      expect(raw.credibility).toBe("4");
    });
  });
});
