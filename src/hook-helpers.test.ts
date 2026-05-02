/**
 * #344 — Kiro hook subcommands helpers + sidecar key scheme.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abmindHooksDir, hookErrorLogPath, hookSidecarKey, hookSidecarPath } from "./mem-paths.js";
import { ensureHooksDir, hooksDisabled, logHookError } from "./hook-helpers.js";

describe("#344 — hook paths", () => {
  let tmpDir: string;
  let savedHome: string | undefined;
  let savedSessionId: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hook-paths-"));
    savedHome = process.env.ABMIND_HOME;
    savedSessionId = process.env.KIRO_SESSION_ID;
    process.env.ABMIND_HOME = tmpDir;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.ABMIND_HOME;
    else process.env.ABMIND_HOME = savedHome;
    if (savedSessionId === undefined) delete process.env.KIRO_SESSION_ID;
    else process.env.KIRO_SESSION_ID = savedSessionId;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("abmindHooksDir() lives under ABMIND_HOME/hooks", () => {
    expect(abmindHooksDir()).toBe(join(tmpDir, "hooks"));
  });

  it("hookErrorLogPath() lives under hooks dir", () => {
    expect(hookErrorLogPath()).toBe(join(tmpDir, "hooks", "errors.log"));
  });

  it("hookSidecarKey uses KIRO_SESSION_ID when set", () => {
    process.env.KIRO_SESSION_ID = "test-session-abc";
    expect(hookSidecarKey()).toBe("test-session-abc");
  });

  it("hookSidecarKey falls back to cwd+date hash when KIRO_SESSION_ID is missing", () => {
    delete process.env.KIRO_SESSION_ID;
    const key = hookSidecarKey();
    expect(key).toMatch(/^fallback-[0-9a-f]{16}$/);
    // Calling twice in the same session produces the same key (deterministic within a day+cwd)
    expect(hookSidecarKey()).toBe(key);
  });

  it("hookSidecarPath combines hooks dir + key", () => {
    process.env.KIRO_SESSION_ID = "xyz";
    expect(hookSidecarPath()).toBe(join(tmpDir, "hooks", "last-prompt-xyz.txt"));
  });
});

describe("#344 — hook helpers", () => {
  let tmpDir: string;
  let savedHome: string | undefined;
  let savedDisabled: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hook-helpers-"));
    savedHome = process.env.ABMIND_HOME;
    savedDisabled = process.env.ABMIND_HOOKS_DISABLED;
    process.env.ABMIND_HOME = tmpDir;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.ABMIND_HOME;
    else process.env.ABMIND_HOME = savedHome;
    if (savedDisabled === undefined) delete process.env.ABMIND_HOOKS_DISABLED;
    else process.env.ABMIND_HOOKS_DISABLED = savedDisabled;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ensureHooksDir creates the directory", () => {
    ensureHooksDir();
    expect(existsSync(abmindHooksDir())).toBe(true);
  });

  it("logHookError writes a timestamped entry", () => {
    ensureHooksDir();
    logHookError("wakeup", new Error("db locked"));
    const log = readFileSync(hookErrorLogPath(), "utf-8");
    expect(log).toMatch(/\[wakeup\] db locked/);
    expect(log).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp prefix
  });

  it("logHookError appends across calls", () => {
    ensureHooksDir();
    logHookError("recall", new Error("first"));
    logHookError("store", new Error("second"));
    const log = readFileSync(hookErrorLogPath(), "utf-8");
    expect(log).toContain("[recall] first");
    expect(log).toContain("[store] second");
    expect(log.trim().split("\n").length).toBe(2);
  });

  it("logHookError accepts non-Error values", () => {
    ensureHooksDir();
    logHookError("wakeup", "string error");
    const log = readFileSync(hookErrorLogPath(), "utf-8");
    expect(log).toContain("[wakeup] string error");
  });

  it("logHookError never throws even if the dir can't be created", () => {
    // Force the hooks dir to an unwritable path
    process.env.ABMIND_HOME = "/dev/null/impossible";
    expect(() => logHookError("wakeup", new Error("boom"))).not.toThrow();
  });

  it("hooksDisabled returns false by default", () => {
    delete process.env.ABMIND_HOOKS_DISABLED;
    expect(hooksDisabled()).toBe(false);
  });

  it("hooksDisabled returns true for 'true', '1', 'yes'", () => {
    process.env.ABMIND_HOOKS_DISABLED = "true";
    expect(hooksDisabled()).toBe(true);
    process.env.ABMIND_HOOKS_DISABLED = "TRUE";
    expect(hooksDisabled()).toBe(true);
    process.env.ABMIND_HOOKS_DISABLED = "1";
    expect(hooksDisabled()).toBe(true);
    process.env.ABMIND_HOOKS_DISABLED = "yes";
    expect(hooksDisabled()).toBe(true);
  });

  it("hooksDisabled returns false for other values", () => {
    process.env.ABMIND_HOOKS_DISABLED = "false";
    expect(hooksDisabled()).toBe(false);
    process.env.ABMIND_HOOKS_DISABLED = "no";
    expect(hooksDisabled()).toBe(false);
    process.env.ABMIND_HOOKS_DISABLED = "";
    expect(hooksDisabled()).toBe(false);
  });
});
