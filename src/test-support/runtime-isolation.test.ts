import { describe, it, expect } from "vitest";
import { currentTestSandbox, assertSandboxPath, isolatedChildEnv } from "./runtime-isolation.js";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";

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
});
