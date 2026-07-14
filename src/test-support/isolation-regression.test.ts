import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import { currentTestSandbox, assertSandboxPath } from "./runtime-isolation.js";
import { abmindHome, abmindHooksDir } from "../mem-paths.js";

/**
 * Regression guard for the #1417 isolation contract (abmind).
 *
 * Builds a decoy "live" home — what ~/.abmind looks like in production — with
 * sentinel files, then drives production default-path resolvers (which take no
 * explicit path) and asserts:
 *   1. every resolved path lands INSIDE the per-file sandbox, and
 *   2. every sentinel in the decoy home is byte-for-byte unchanged.
 *
 * If a future change re-introduces module-level path capture or hardcodes a
 * real-home default, one of these assertions fires before live state is touched.
 */

function makeExternalRoot(): { root: string; sentinels: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "abmind-regression-external-"));
  const abmind = join(root, "fake-home", ".abmind");
  mkdirSync(join(abmind, "memory"), { recursive: true });
  mkdirSync(join(abmind, "hooks"), { recursive: true });
  const sentinels: Record<string, string> = {
    [join(abmind, "memory", "memory.db")]: "SENTINEL_DB_v1",
    [join(abmind, "hooks", "errors.log")]: "SENTINEL_LOG_v1",
  };
  for (const [p, c] of Object.entries(sentinels)) writeFileSync(p, c);
  return { root, sentinels };
}

const sha = (p: string): string =>
  createHash("sha256").update(readFileSync(p)).digest("hex");

describe("isolation regression: default-path resolvers cannot reach live roots", () => {
  let external: ReturnType<typeof makeExternalRoot> | null = null;

  afterEach(() => {
    if (external) rmSync(external.root, { recursive: true, force: true });
    external = null;
  });

  it("abmindHome() resolves into the sandbox, not the decoy home", () => {
    external = makeExternalRoot();
    const sandbox = currentTestSandbox();
    expect(abmindHome()).toBe(sandbox.abmindHome);
    expect(abmindHome()).not.toContain("fake-home");
    expect(homedir()).toBe(sandbox.home);
  });

  it("a default-path hook file resolves inside the sandbox", () => {
    external = makeExternalRoot();
    const sandbox = currentTestSandbox();
    const hookPath = resolve(abmindHooksDir(), "errors.log");
    expect(hookPath.startsWith(sandbox.abmindHome)).toBe(true);
    expect(hookPath).not.toContain("fake-home");
  });

  it("a raw homedir()-joined default path also resolves inside the sandbox", () => {
    external = makeExternalRoot();
    const sandbox = currentTestSandbox();
    const defaultPath = join(homedir(), ".abmind", "memory", "memory.db");
    expect(defaultPath).toBe(join(sandbox.home, ".abmind", "memory", "memory.db"));
    expect(assertSandboxPath(defaultPath)).toBe(resolve(defaultPath));
    expect(homedir()).not.toContain("fake-home");
  });

  it("decoy sentinels stay byte-for-byte unchanged after default-path resolution", () => {
    external = makeExternalRoot();
    const before = Object.fromEntries(
      Object.keys(external.sentinels).map((p) => [p, sha(p)]),
    );
    // Touch the default-path resolvers (read-only) — no writes happen, but this
    // proves resolution never opens or creates anything in the decoy home.
    abmindHome();
    abmindHooksDir();
    for (const [p, h] of Object.entries(before)) {
      expect(existsSync(p)).toBe(true);
      expect(sha(p)).toBe(h);
    }
  });

  it("attempting to assertSandboxPath on the decoy (live) root is rejected", () => {
    external = makeExternalRoot();
    const liveTarget = join(external.root, "fake-home", ".abmind", "memory", "memory.db");
    expect(() => assertSandboxPath(liveTarget)).toThrow("outside the test sandbox root");
    expect(readFileSync(liveTarget, "utf-8")).toBe("SENTINEL_DB_v1");
  });
});
