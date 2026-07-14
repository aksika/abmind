import { describe, it, expect } from "vitest";
import { currentTestSandbox, assertSandboxPath, isolatedChildEnv, restoreEnvSnapshot } from "./runtime-isolation.js";
import { resolve, join } from "node:path";
import { existsSync, statSync } from "node:fs";

describe("runtime-isolation sandbox", () => {
  it("provides a sandbox with all expected directories", () => {
    const s = currentTestSandbox();
    expect(s.root).toBeTruthy();
    expect(s.home).toBeTruthy();
    expect(s.abmindHome).toBeTruthy();
    expect(existsSync(s.home)).toBe(true);
    expect(existsSync(s.abmindHome)).toBe(true);
  });

  it("sets HOME and ABMIND_HOME to sandbox paths", () => {
    const s = currentTestSandbox();
    expect(process.env.HOME).toBe(s.home);
    expect(process.env.ABMIND_HOME).toBe(s.abmindHome);
    expect(process.env.AB_TEST_SANDBOX_ROOT).toBe(s.root);
  });

  it("assertSandboxPath accepts paths inside the sandbox", () => {
    const s = currentTestSandbox();
    const inside = join(s.abmindHome, "hooks", "test.json");
    expect(assertSandboxPath(inside)).toBe(resolve(inside));
  });

  it("assertSandboxPath rejects paths outside the sandbox", () => {
    expect(() => assertSandboxPath("/tmp")).toThrow("outside the test sandbox root");
    expect(() => assertSandboxPath("/etc/passwd")).toThrow("outside the test sandbox root");
  });

  it("assertSandboxPath rejects the sandbox root itself", () => {
    const s = currentTestSandbox();
    expect(() => assertSandboxPath(s.root)).toThrow("outside the test sandbox root");
  });

  it("isolatedChildEnv contains sandbox variables", () => {
    const env = isolatedChildEnv();
    const s = currentTestSandbox();
    expect(env.ABMIND_HOME).toBe(s.abmindHome);
    expect(env.HOME).toBe(s.home);
    expect(env.NODE_ENV).toBe("test");
  });

  it("isolatedChildEnv preserves toolchain discovery variables (PATH, NODE_PATH)", () => {
    const env = isolatedChildEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.NODE_PATH).toBe(process.env.NODE_PATH);
  });

  it("isolatedChildEnv does NOT contain secret variables", () => {
    process.env.OPENAI_API_KEY = "should-not-leak";
    try {
      const env = isolatedChildEnv();
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("isolatedChildEnv applies explicit overrides", () => {
    const env = isolatedChildEnv({ MY_KEY: "fake" });
    expect(env.MY_KEY).toBe("fake");
  });

  it("restoreEnvSnapshot deletes previously-unset keys and preserves empty-string keys", () => {
    const env: Record<string, string | undefined> = { HOME: "will-be-deleted", KEEP: "v" };
    const snap = new Map<string, { wasSet: boolean; value: string }>([
      ["HOME", { wasSet: false, value: "" }],
      ["EMPTY", { wasSet: true, value: "" }],
      ["KEEP", { wasSet: true, value: "v" }],
      ["ABSENT", { wasSet: false, value: "" }],
    ]);
    restoreEnvSnapshot(env, snap);
    expect(env).toEqual({ KEEP: "v", EMPTY: "" });
    expect("HOME" in env).toBe(false);
    expect("ABSENT" in env).toBe(false);
    expect(env.EMPTY).toBe("");
  });

  it("currentTestSandbox returns a stable reference (idempotent within the file)", () => {
    const a = currentTestSandbox();
    const b = currentTestSandbox();
    expect(a).toBe(b);
  });

  it("sandbox root and application home exist on disk (cleanup ownership)", () => {
    const s = currentTestSandbox();
    expect(statSync(s.root).isDirectory()).toBe(true);
    expect(existsSync(s.abmindHome)).toBe(true);
    expect(() => assertSandboxPath(s.root)).toThrow("outside the test sandbox root");
  });
});
