// #1308 — abmind update CLI argument parsing.
// parseArgs lives in a side-effect-free module (abmind-update.ts is dispatched
// via import-side-effects, so it cannot be imported in a test without firing
// run()/process.exit). These tests lock the pull-vs-manual decision and the
// multi-channel rejection.
import { describe, it, expect } from "vitest";
import { parseArgs } from "../cli/abmind-update-args.js";

describe("abmind update parseArgs", () => {
  it("--dev with no dir → pull mode (localDir undefined)", () => {
    expect(parseArgs(["--dev"])).toEqual({ channel: "dev", localDir: undefined });
  });

  it("--dev <DIR> → manual mode (raw token kept, not resolved)", () => {
    expect(parseArgs(["--dev", "/abs/path"])).toEqual({ channel: "dev", localDir: "/abs/path" });
    // relative tokens are preserved verbatim — resolution is the caller's job
    expect(parseArgs(["--dev", "relative/path"])).toEqual({ channel: "dev", localDir: "relative/path" });
    expect(parseArgs(["--dev", "./x"])).toEqual({ channel: "dev", localDir: "./x" });
  });

  it("--dev followed by another flag → pull mode, flag not consumed as dir", () => {
    // --foo is not a real channel → the loop hits the else branch → error.
    // The key assertion: --foo is NOT swallowed as <DIR>, so we never enter
    // manual mode with localDir="--foo".
    expect(parseArgs(["--dev", "--foo"])).toBe("error");
  });

  it("--dev --alpha → error (multiple channels rejected, not reinterpreted)", () => {
    expect(parseArgs(["--dev", "--alpha"])).toBe("error");
  });

  it("--dev --stable → error", () => {
    expect(parseArgs(["--dev", "--stable"])).toBe("error");
  });

  it("--alpha alone → alpha channel", () => {
    expect(parseArgs(["--alpha"])).toEqual({ channel: "alpha", localDir: undefined });
  });

  it("--stable alone → stable channel", () => {
    expect(parseArgs(["--stable"])).toEqual({ channel: "stable", localDir: undefined });
  });

  it("no channel → error", () => {
    expect(parseArgs([])).toBe("error");
  });

  it("unknown flag → error", () => {
    expect(parseArgs(["--foo"])).toBe("error");
  });

  it("--help / -h → help", () => {
    expect(parseArgs(["--help"])).toBe("help");
    expect(parseArgs(["-h"])).toBe("help");
  });
});
