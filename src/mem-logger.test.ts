import { describe, it, expect, vi, afterEach } from "vitest";
import { setLogger, logInfo, logWarn, logError } from "./mem-logger.js";

describe("mem-logger — standalone logger with injection", () => {
  afterEach(() => {
    // Reset to defaults
    setLogger({
      logInfo: (tag, msg) => console.log(`[${tag}] ${msg}`),
      logWarn: (tag, msg) => console.warn(`[${tag}] ${msg}`),
      logError: (tag, msg) => { console.error(`[${tag}] ${msg}`); },
    });
  });

  it("defaults to console output", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logInfo("test", "hello");
    expect(spy).toHaveBeenCalledWith("[test] hello");
    spy.mockRestore();
  });

  it("setLogger replaces all log functions", () => {
    const calls: string[] = [];
    setLogger({
      logInfo: (_t, m) => calls.push(`info:${m}`),
      logWarn: (_t, m) => calls.push(`warn:${m}`),
      logError: (_t, m) => calls.push(`error:${m}`),
    });

    logInfo("t", "a");
    logWarn("t", "b");
    logError("t", "c");

    expect(calls).toEqual(["info:a", "warn:b", "error:c"]);
  });
});
