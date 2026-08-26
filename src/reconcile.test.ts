import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reconcile } from "./reconcile.js";

function seedTemplates(templates: string): void {
  mkdirSync(join(templates, "memory", "core"), { recursive: true });
  writeFileSync(join(templates, "memory", "core", "SOUL.md"), "I am <agentName>, autonomous.\n");
  writeFileSync(join(templates, "memory", "core", "memory-tools.md"), "# memory-tools\n");
  writeFileSync(join(templates, "memory", "core", "agent_notes.md"), "# agent_notes\n");

  mkdirSync(join(templates, "config"), { recursive: true });
  writeFileSync(join(templates, "config", ".env.memory"), "EMBEDDING_ENABLED=true\n");
  writeFileSync(join(templates, "config", "sleep.json"), JSON.stringify({ version: 1, defaults: { timeoutSec: 300 }, steps: [] }));

  mkdirSync(join(templates, "prompts", "sleep"), { recursive: true });
  writeFileSync(join(templates, "prompts", "sleep", "01-gc-noise.md"), "# gc\n");
}

describe("reconcile", () => {
  let templates: string;
  let home: string;

  beforeEach(() => {
    templates = mkdtempSync(join(tmpdir(), "abmind-recon-tpl-"));
    home = mkdtempSync(join(tmpdir(), "abmind-recon-home-"));
    seedTemplates(templates);
  });

  afterEach(() => {
    rmSync(templates, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  describe("SEED (memory/core, config)", () => {
    it("copies non-exception files on first run", () => {
      reconcile(templates, home);
      expect(existsSync(join(home, "memory", "core", "memory-tools.md"))).toBe(true);
      expect(existsSync(join(home, "memory", "core", "agent_notes.md"))).toBe(true);
      expect(existsSync(join(home, "config", ".env.memory"))).toBe(true);
    });

    it("does NOT copy SOUL.md (#1323, #1324 — personalized by soul-seeder)", () => {
      reconcile(templates, home);
      expect(existsSync(join(home, "memory", "core", "SOUL.md"))).toBe(false);
    });

    it("does not overwrite existing user-owned files", () => {
      mkdirSync(join(home, "memory", "core"), { recursive: true });
      const userFile = "# User's own notes\n";
      writeFileSync(join(home, "memory", "core", "agent_notes.md"), userFile);

      reconcile(templates, home);

      const content = readFileSync(join(home, "memory", "core", "agent_notes.md"), "utf-8");
      expect(content).toBe(userFile);
    });

    it("seeds sleep.json on first run and preserves operator edits on later runs", () => {
      // First run — absent → seeded from template.
      reconcile(templates, home);
      const seeded = join(home, "config", "sleep.json");
      expect(existsSync(seeded)).toBe(true);
      expect(readFileSync(seeded, "utf-8")).toContain('"steps":[]');

      // Operator edits the deployed file.
      const operator = JSON.stringify({ version: 1, defaults: { timeoutSec: 600 }, steps: [] });
      writeFileSync(seeded, operator);

      // Second run — SEED must preserve the operator copy.
      reconcile(templates, home);
      expect(readFileSync(seeded, "utf-8")).toBe(operator);
    });
  });

  describe("OVERWRITE (prompts/sleep)", () => {
    it("overwrites prompts/sleep on every run", () => {
      reconcile(templates, home);
      // First run seeds the dir
      expect(existsSync(join(home, "prompts", "sleep", "01-gc-noise.md"))).toBe(true);

      // Modify the deployed file
      writeFileSync(join(home, "prompts", "sleep", "01-gc-noise.md"), "USER EDIT\n");

      // Second run should restore from template
      reconcile(templates, home);
      const content = readFileSync(join(home, "prompts", "sleep", "01-gc-noise.md"), "utf-8");
      expect(content).toBe("# gc\n");
    });

    it("removes stale files in OVERWRITE dirs", () => {
      // First run
      reconcile(templates, home);
      // Add a stale file the template doesn't have
      writeFileSync(join(home, "prompts", "sleep", "stale.md"), "stale");

      reconcile(templates, home);
      expect(existsSync(join(home, "prompts", "sleep", "stale.md"))).toBe(false);
    });
  });

  describe("missing template dirs", () => {
    it("is a no-op when template dir does not exist", () => {
      rmSync(templates, { recursive: true, force: true });
      expect(() => reconcile(templates, home)).not.toThrow();
      expect(existsSync(join(home, "memory", "core"))).toBe(false);
    });
  });
});
