/**
 * Focused tests for the shared daily-file viability predicate (#1653) —
 * usable, short, missing, and unreadable boundaries live here once, not
 * duplicated across orchestrator suites.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasAppendedDailyArtifact, readDailyArtifact, readDailyArtifactRaw, extractFromDaily, DAILY_FILE_MIN_CHARS } from "./sleep-extract-daily.js";

function makeDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "abmind-extract-daily-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const LONG = "x".repeat(DAILY_FILE_MIN_CHARS + 10);

describe("readDailyArtifact (#1653 shared viability predicate)", () => {
  it("classifies a file above the floor as usable and returns its trimmed content", () => {
    const { dir, cleanup } = makeDir();
    try {
      const p = join(dir, "daily.md");
      writeFileSync(p, `  ${LONG}  `, "utf-8");
      const read = readDailyArtifact(p);
      expect(read.usable).toBe(true);
      expect(read.content).toBe(LONG);
    } finally { cleanup(); }
  });

  it("classifies a short file as unusable", () => {
    const { dir, cleanup } = makeDir();
    try {
      const p = join(dir, "daily.md");
      writeFileSync(p, "x".repeat(DAILY_FILE_MIN_CHARS - 1), "utf-8");
      expect(readDailyArtifact(p).usable).toBe(false);
    } finally { cleanup(); }
  });

  it("classifies a missing file as unusable without throwing", () => {
    const { dir, cleanup } = makeDir();
    try {
      expect(readDailyArtifact(join(dir, "does-not-exist.md")).usable).toBe(false);
    } finally { cleanup(); }
  });

  it("classifies an unreadable file as unusable without throwing", () => {
    const { dir, cleanup } = makeDir();
    try {
      const p = join(dir, "daily.md");
      writeFileSync(p, LONG, "utf-8");
      chmodSync(p, 0o000);
      try {
        expect(readDailyArtifact(p).usable).toBe(false);
      } finally {
        chmodSync(p, 0o600);
      }
    } finally { cleanup(); }
  });
});

describe("hasAppendedDailyArtifact (#1752 R9 postcondition)", () => {
  it("requires the exact prior content to remain intact with non-whitespace appended", () => {
    const { dir, cleanup } = makeDir();
    try {
      const p = join(dir, "daily.md");
      const before = `# Daily Summary\n\n${LONG}\n`;
      writeFileSync(p, before, "utf-8");

      expect(readDailyArtifactRaw(p)).toBe(before);
      expect(hasAppendedDailyArtifact(p, before)).toBe(false);

      writeFileSync(p, `${before}\n## Retrospective\nA useful reflection.\n`, "utf-8");
      expect(hasAppendedDailyArtifact(p, before)).toBe(true);

      writeFileSync(p, `${before}   \n\t`, "utf-8");
      expect(hasAppendedDailyArtifact(p, before), "whitespace alone is not a completed retrospective").toBe(false);

      writeFileSync(p, `rewritten\n${before}`, "utf-8");
      expect(hasAppendedDailyArtifact(p, before), "a rewrite is not an append").toBe(false);
    } finally { cleanup(); }
  });

  it("returns false when the bound artifact disappears", () => {
    const { dir, cleanup } = makeDir();
    try {
      const p = join(dir, "daily.md");
      expect(hasAppendedDailyArtifact(p, "existing content")).toBe(false);
    } finally { cleanup(); }
  });
});

describe("extractFromDaily (#1653 shared helper wiring)", () => {
  it("returns the existing empty-marker string for a short file — no prompt, no model call", async () => {
    const { dir, cleanup } = makeDir();
    try {
      const p = join(dir, "daily.md");
      writeFileSync(p, "too short", "utf-8");
      let called = false;
      const result = await extractFromDaily(p, "master", async () => { called = true; return "unreachable"; });
      expect(result).toBe("0 memories (daily file empty)");
      expect(called).toBe(false);
    } finally { cleanup(); }
  });

  it("returns the existing empty-marker string for a missing file instead of throwing", async () => {
    const { dir, cleanup } = makeDir();
    try {
      const result = await extractFromDaily(join(dir, "missing.md"), "master", async () => "unreachable");
      expect(result).toBe("0 memories (daily file empty)");
    } finally { cleanup(); }
  });

  it("uses the file content when usable and returns the trimmed model response", async () => {
    const { dir, cleanup } = makeDir();
    try {
      const p = join(dir, "daily.md");
      writeFileSync(p, LONG, "utf-8");
      const result = await extractFromDaily(p, "master", async (prompt) => {
        expect(prompt).toContain(LONG);
        return "  3 memories stored  ";
      });
      expect(result).toBe("3 memories stored");
    } finally { cleanup(); }
  });
});
