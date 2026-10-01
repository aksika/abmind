/**
 * #1894 — abmind recall CLI flag contracts, at the handler boundary.
 *
 * The check-only path must not require --translated (the original guard
 * order rejected it before reaching the check); plain recall keeps
 * requiring it. The handler is exported so the contract is testable
 * without a daemon: `runCli` returns early on import.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { executeRecallCli } from "../cli/abmind-recall.js";
import type { MemoryBackend } from "./memory-backend.js";

afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function fakeBackend() {
  const checkWorthRetrieving = vi.fn().mockResolvedValue({ verdict: "skip", corpusSize: 14, ceiling: 3 });
  const recall = vi.fn().mockResolvedValue({ results: [], stages: {}, extractedIds: [] });
  const backend = { checkWorthRetrieving, recall, close: vi.fn() } as unknown as MemoryBackend;
  return { backend, checkWorthRetrieving, recall };
}

describe("#1894 — recall CLI check-only contract", () => {
  it("runs the check without --translated", async () => {
    const { backend, checkWorthRetrieving, recall } = fakeBackend();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await executeRecallCli({ args: { "check-only": true, original: "köszi", "user-id": "u1" }, backend });

    expect(error).not.toHaveBeenCalled();
    expect(checkWorthRetrieving).toHaveBeenCalledWith(expect.objectContaining({ original: "köszi", userId: "u1" }));
    expect(recall).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ verdict: "skip", corpusSize: 14, ceiling: 3 });
  });

  it("requires --original for check-only", async () => {
    const { backend, checkWorthRetrieving, recall } = fakeBackend();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await executeRecallCli({ args: { "check-only": true, "user-id": "u1" }, backend });

    expect(checkWorthRetrieving).not.toHaveBeenCalled();
    expect(recall).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("--check-only"));
    expect(process.exitCode).toBe(1);
  });

  it("plain recall still requires --translated", async () => {
    const { backend, checkWorthRetrieving, recall } = fakeBackend();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await executeRecallCli({ args: { "user-id": "u1" }, backend });

    expect(checkWorthRetrieving).not.toHaveBeenCalled();
    expect(recall).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("--translated"));
    expect(process.exitCode).toBe(1);
  });

  it("plain recall passes explicit intent and keywords unchanged", async () => {
    const { backend, recall } = fakeBackend();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await executeRecallCli({ args: { translated: "migration, rollback", "user-id": "u1" }, backend });

    expect(recall).toHaveBeenCalledWith(expect.objectContaining({
      translated: ["migration", "rollback"],
      intent: "explicit",
      userId: "u1",
    }));
  });
});
