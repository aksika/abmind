import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { isolatedChildEnv } from "./test-support/runtime-isolation.js";

const doctorScript = join(__dirname, "../dist/cli/abmind-doctor.js");

describe("abmind doctor --json", () => {
  let tmp: string;

  beforeAll(() => {
    try { execFileSync(process.execPath, [doctorScript, "--help"], { timeout: 5000 }); } catch { }
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "abmind-doctor-"));
    mkdirSync(join(tmp, "config"), { mode: 0o700 });
    mkdirSync(join(tmp, "memory"), { mode: 0o700 });
    mkdirSync(join(tmp, "memory", "core"), { mode: 0o700 });
    mkdirSync(join(tmp, "secret"), { mode: 0o700 });
    mkdirSync(join(tmp, "logs"), { mode: 0o700 });
    writeFileSync(join(tmp, "memory", "core", "SOUL.md"), "x", { mode: 0o600 });
    writeFileSync(join(tmp, "memory", "core", "user_profile.md"), "x", { mode: 0o600 });
    writeFileSync(join(tmp, "memory", "core", "agent_notes.md"), "x", { mode: 0o600 });
    writeFileSync(join(tmp, "memory", "core", "memory-tools.md"), "x", { mode: 0o600 });
  });

  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  function runDoctor(): any {
    try {
      const out = execFileSync(process.execPath, [doctorScript, "--json"], {
        encoding: "utf-8",
        env: isolatedChildEnv({ ABMIND_HOME: tmp }),
        timeout: 10000,
      });
      return JSON.parse(out);
    } catch (e: any) {
      if (e.stdout) return JSON.parse(e.stdout);
      throw e;
    }
  }

  it("produces valid JSON with checks array and summary", () => {
    const parsed = runDoctor();
    expect(parsed).toHaveProperty("checks");
    expect(parsed).toHaveProperty("summary");
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(0);
    expect(typeof parsed.summary.ok).toBe("number");
    expect(typeof parsed.summary.warn).toBe("number");
    expect(typeof parsed.summary.error).toBe("number");
  });

  it("each check has name, status, message", () => {
    const { checks } = runDoctor();
    for (const c of checks) {
      expect(c).toHaveProperty("name");
      expect(c).toHaveProperty("status");
      expect(c).toHaveProperty("message");
      expect(["ok", "failed", "skipped"]).toContain(c.status);
    }
  });

  it("reports local permission checks with short labels", () => {
    const { checks } = runDoctor();
    const permCheck = checks.find((c: any) => c.name === "root ~/.abmind/");
    expect(permCheck).toBeDefined();
    expect(permCheck.name).toContain("root");
    expect(["ok", "failed", "skipped"]).toContain(permCheck.status);
  });
});
