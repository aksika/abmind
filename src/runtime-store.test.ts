import { describe, it, expect, beforeEach } from "vitest";
import {
  registerRuntime,
  getRuntime,
  hasRuntime,
  removeRuntime,
  listRuntimes,
  _clearAllRuntimes,
} from "./runtime-store.js";

describe("runtime-store", () => {
  beforeEach(() => {
    _clearAllRuntimes();
  });

  it("registers and retrieves a runtime", () => {
    const runtime = { memoryDir: "/tmp/a", abmlVersion: "v0" };
    registerRuntime("plugin-a", runtime);
    expect(getRuntime("plugin-a")).toBe(runtime);
  });

  it("isolates runtimes across pluginIds", () => {
    const runtimeA = { memoryDir: "/tmp/a", abmlVersion: "v0" };
    const runtimeB = { memoryDir: "/tmp/b", abmlVersion: "v1" };
    registerRuntime("plugin-a", runtimeA);
    registerRuntime("plugin-b", runtimeB);
    expect(getRuntime<typeof runtimeA>("plugin-a").memoryDir).toBe("/tmp/a");
    expect(getRuntime<typeof runtimeB>("plugin-b").memoryDir).toBe("/tmp/b");
    expect(getRuntime<typeof runtimeA>("plugin-a").abmlVersion).toBe("v0");
    expect(getRuntime<typeof runtimeB>("plugin-b").abmlVersion).toBe("v1");
  });

  it("throws on double registration", () => {
    registerRuntime("plugin-a", { v: 1 });
    expect(() => registerRuntime("plugin-a", { v: 2 })).toThrow(/already registered/);
  });

  it("allows re-registration after remove", () => {
    registerRuntime("plugin-a", { v: 1 });
    removeRuntime("plugin-a");
    registerRuntime("plugin-a", { v: 2 });
    expect(getRuntime<{ v: number }>("plugin-a").v).toBe(2);
  });

  it("throws on getRuntime for unregistered pluginId", () => {
    expect(() => getRuntime("missing")).toThrow(/no runtime registered/);
  });

  it("rejects empty or non-string pluginId", () => {
    expect(() => registerRuntime("", { v: 1 })).toThrow(/non-empty string/);
    // @ts-expect-error intentional invalid input
    expect(() => registerRuntime(null, { v: 1 })).toThrow(/non-empty string/);
    // @ts-expect-error intentional invalid input
    expect(() => registerRuntime(123, { v: 1 })).toThrow(/non-empty string/);
  });

  it("hasRuntime reports presence without throwing", () => {
    expect(hasRuntime("plugin-a")).toBe(false);
    registerRuntime("plugin-a", { v: 1 });
    expect(hasRuntime("plugin-a")).toBe(true);
    removeRuntime("plugin-a");
    expect(hasRuntime("plugin-a")).toBe(false);
  });

  it("removeRuntime is idempotent", () => {
    expect(() => removeRuntime("never-registered")).not.toThrow();
    registerRuntime("plugin-a", { v: 1 });
    removeRuntime("plugin-a");
    expect(() => removeRuntime("plugin-a")).not.toThrow();
  });

  it("listRuntimes returns registered pluginIds", () => {
    expect(listRuntimes()).toEqual([]);
    registerRuntime("plugin-a", { v: 1 });
    registerRuntime("plugin-b", { v: 2 });
    expect(listRuntimes()).toEqual(["plugin-a", "plugin-b"]);
  });

  it("registry survives across module boundaries via Symbol.for", async () => {
    // Simulate what would happen if two different module resolutions
    // both imported runtime-store.ts — Symbol.for(key) returns the same
    // symbol, so both views share the same registry.
    registerRuntime("plugin-a", { marker: "written-by-first-import" });

    // Re-import via dynamic path — in a real multi-bundle scenario this
    // might be a different module copy. Symbol.for ensures shared state.
    const reimport = await import("./runtime-store.js");
    expect(reimport.getRuntime("plugin-a")).toEqual({ marker: "written-by-first-import" });
    expect(reimport.listRuntimes()).toContain("plugin-a");
  });
});
