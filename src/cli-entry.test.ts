import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isDirectRun } from "./cli-entry.js";

describe("isDirectRun", () => {
  let savedArgv: string[];
  beforeEach(() => { savedArgv = [...process.argv]; });
  afterEach(() => { process.argv = savedArgv; });

  it("true when argv[1] ends with /abmind (unified dispatcher)", () => {
    process.argv[1] = "/usr/local/bin/abmind";
    expect(isDirectRun("file:///somewhere/abmind-store.js")).toBe(true);
  });

  it("true when argv[1] ends with /abmind.js (dispatcher via direct node path)", () => {
    process.argv[1] = "/home/test/abmind/dist/cli/abmind.js";
    expect(isDirectRun("file:///home/test/abmind/dist/cli/abmind-store.js")).toBe(true);
  });

  it("true when argv[1] ends with /abmind.ts (dispatcher via tsx)", () => {
    process.argv[1] = "/home/test/abmind/cli/abmind.ts";
    expect(isDirectRun("file:///home/test/abmind/cli/abmind-store.ts")).toBe(true);
  });

  it("true when argv[1] file URL matches importMetaUrl (direct script)", () => {
    process.argv[1] = "/home/test/abmind/dist/cli/abmind-store.js";
    expect(isDirectRun("file:///home/test/abmind/dist/cli/abmind-store.js")).toBe(true);
  });

  it("false when imported by another module (argv differs)", () => {
    process.argv[1] = "/home/test/abmind/node_modules/vitest/vitest.mjs";
    expect(isDirectRun("file:///home/test/abmind/dist/cli/abmind-store.js")).toBe(false);
  });

  it("false when argv[1] is empty", () => {
    process.argv[1] = "";
    expect(isDirectRun("file:///x.js")).toBe(false);
  });
});
