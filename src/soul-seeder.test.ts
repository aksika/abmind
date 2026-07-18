import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverAgentName, readSoul, soulPath, templateSoulPath, writeSoulPersonalized } from "./soul-seeder.js";

const TEMPLATE_BODY = "# SOUL.md - Who am I?\n\nI am <agentName>, an autonomous AI agent.\n";

function seedTemplate(repoRoot: string): void {
  const dir = join(repoRoot, "templates", "memory", "core");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SOUL.md"), TEMPLATE_BODY);
}

describe("soul-seeder", () => {
  let repoRoot: string;
  let home: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "abmind-soul-repo-"));
    home = mkdtempSync(join(tmpdir(), "abmind-soul-home-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  describe("soulPath", () => {
    it("returns the canonical SOUL.md path inside an abmind home", () => {
      expect(soulPath("/h")).toBe("/h/memory/core/SOUL.md");
    });
  });

  describe("templateSoulPath", () => {
    it("returns the canonical template SOUL.md path inside a repo root", () => {
      expect(templateSoulPath("/r")).toBe("/r/templates/memory/core/SOUL.md");
    });
  });

  describe("readSoul", () => {
    it("returns null when SOUL.md is missing", () => {
      expect(readSoul(home)).toBeNull();
    });

    it("returns the file content when SOUL.md exists", () => {
      seedTemplate(repoRoot);
      writeSoulPersonalized(repoRoot, home, "KP");
      const content = readSoul(home);
      expect(content).toContain("I am KP,");
      expect(content).not.toContain("<agentName>");
    });
  });

  describe("writeSoulPersonalized", () => {
    it("substitutes <agentName> with the provided name", () => {
      seedTemplate(repoRoot);
      const written = writeSoulPersonalized(repoRoot, home, "Molty");
      expect(written).toBe(true);
      const content = readFileSync(soulPath(home), "utf-8");
      expect(content).toContain("I am Molty,");
      expect(content).not.toContain("<agentName>");
    });

    it("writes with 0o600 mode", () => {
      seedTemplate(repoRoot);
      writeSoulPersonalized(repoRoot, home, "KP");
      const mode = statSync(soulPath(home)).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("creates the memory/core directory if missing", () => {
      seedTemplate(repoRoot);
      expect(existsSync(join(home, "memory", "core"))).toBe(false);
      writeSoulPersonalized(repoRoot, home, "KP");
      expect(existsSync(soulPath(home))).toBe(true);
    });

    it("returns false and writes nothing when template is missing", () => {
      // no seedTemplate call
      const written = writeSoulPersonalized(repoRoot, home, "KP");
      expect(written).toBe(false);
      expect(existsSync(soulPath(home))).toBe(false);
    });

    it("is idempotent — re-running overwrites with the new name", () => {
      seedTemplate(repoRoot);
      writeSoulPersonalized(repoRoot, home, "KP");
      writeSoulPersonalized(repoRoot, home, "Molty");
      const content = readFileSync(soulPath(home), "utf-8");
      expect(content).toContain("I am Molty,");
      expect(content).not.toContain("KP");
      expect(content).not.toContain("<agentName>");
    });

    it("replaces every occurrence of the placeholder", () => {
      const dir = join(repoRoot, "templates", "memory", "core");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SOUL.md"), "Hello <agentName>, signed <agentName>.\n");
      writeSoulPersonalized(repoRoot, home, "Zeta");
      const content = readFileSync(soulPath(home), "utf-8");
      expect(content).toBe("Hello Zeta, signed Zeta.\n");
    });
  });

  describe("discoverAgentName", () => {
    let savedHome: string | undefined;
    let fakeHome: string;

    beforeEach(() => {
      savedHome = process.env["HOME"];
      // Isolated fake home so we don't read the real ~/.abtars/config/peers.json
      // (which on KP contains { "self": { "name": "KP" } } and would pollute
      // the negative tests).
      fakeHome = mkdtempSync(join(tmpdir(), "abmind-soul-home-"));
      process.env["HOME"] = fakeHome;
    });

    afterEach(() => {
      if (savedHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = savedHome;
      rmSync(fakeHome, { recursive: true, force: true });
    });

    it("returns explicit value when provided", () => {
      expect(discoverAgentName("HomeBot")).toBe("HomeBot");
    });

    it("trims whitespace from explicit value", () => {
      expect(discoverAgentName("  KP  ")).toBe("KP");
    });

    it("returns 'Agent' when no explicit value and no peers.json", () => {
      expect(discoverAgentName(undefined)).toBe("Agent");
      expect(discoverAgentName("")).toBe("Agent");
      expect(discoverAgentName("   ")).toBe("Agent");
    });

    it("reads self.name from ~/.abtars/config/peers.json when present", () => {
      const fakeHome = process.env["HOME"]!;
      const peersDir = join(fakeHome, ".abtars", "config");
      mkdirSync(peersDir, { recursive: true });
      writeFileSync(join(peersDir, "peers.json"), JSON.stringify({ self: { name: "Molty" } }));
      expect(discoverAgentName(undefined)).toBe("Molty");
    });

    it("returns 'Agent' when peers.json is malformed", () => {
      const fakeHome = process.env["HOME"]!;
      const peersDir = join(fakeHome, ".abtars", "config");
      mkdirSync(peersDir, { recursive: true });
      writeFileSync(join(peersDir, "peers.json"), "{ not valid json");
      expect(discoverAgentName(undefined)).toBe("Agent");
    });

    it("returns 'Agent' when peers.json has no self.name", () => {
      const fakeHome = process.env["HOME"]!;
      const peersDir = join(fakeHome, ".abtars", "config");
      mkdirSync(peersDir, { recursive: true });
      writeFileSync(join(peersDir, "peers.json"), JSON.stringify({ self: {} }));
      expect(discoverAgentName(undefined)).toBe("Agent");
    });
  });
});
