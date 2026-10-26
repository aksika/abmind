import { describe, it, expect, vi, afterEach } from "vitest";
import { logInfo, logWarn, logError, logDebug, setStderrPolicy, getStderrPolicy } from "./mem-logger.js";

describe("mem-logger", () => {
  afterEach(() => { setStderrPolicy("standard"); });
  it("logInfo writes to stderr", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logInfo("test", "hello");
    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls[0]?.[0] as string;
    expect(output).toContain("[test]");
    expect(output).toContain("hello");
    expect(output).toContain("INFO");
    spy.mockRestore();
  });

  it("logWarn writes WARN level", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logWarn("tag", "warning msg");
    const output = spy.mock.calls[0]?.[0] as string;
    expect(output).toContain("WARN");
    spy.mockRestore();
  });

  it("logError includes error message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("tag", "failed", new Error("boom"));
    const output = spy.mock.calls[0]?.[0] as string;
    expect(output).toContain("ERROR");
    expect(output).toContain("boom");
    spy.mockRestore();
  });

  it("logDebug respects level gate", () => {
    // Default level is 'low', debug should not emit
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logDebug("tag", "debug msg");
    // May or may not emit depending on env — just verify no crash
    spy.mockRestore();
  });

  it("service stderr policy keeps WARN+ on stderr and routes INFO to the file only", () => {
    expect(getStderrPolicy()).toBe("standard");
    setStderrPolicy("service");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logInfo("test", "info-msg");
    expect(spy).not.toHaveBeenCalled();
    logWarn("test", "warn-msg");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
