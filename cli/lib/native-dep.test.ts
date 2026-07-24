import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempHome = "";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => tempHome };
});

describe("requireNativeDep", () => {
  beforeAll(() => {
    tempHome = mkdtempSync(join(tmpdir(), "native-dep-1231-"));
  });

  afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("prefers the shared native-module path", async () => {
    const staged = join(tempHome, ".local", "lib", "node_modules", "better-sqlite3");
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, "package.json"), JSON.stringify({ name: "better-sqlite3", main: "index.cjs" }));
    writeFileSync(join(staged, "index.cjs"), "module.exports = { source: 'shared' };\n");

    const { requireNativeDep } = await import("./native-dep.js");
    expect(requireNativeDep("better-sqlite3").source).toBe("shared");
  });

  it("falls back to normal module resolution", async () => {
    const { requireNativeDep } = await import("./native-dep.js");
    expect(requireNativeDep("node:path" as never).join).toBeTypeOf("function");
  });

  it("propagates an unavailable native dependency", async () => {
    const { requireNativeDep } = await import("./native-dep.js");
    expect(() => requireNativeDep("__missing_native_dep_1231__" as never)).toThrow();
  });
});
