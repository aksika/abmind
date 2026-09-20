/**
 * #1813 — profile matching tests. Pin the active/inactive matrix: repeat
 * passes only for the exact fitted Jev pin, lookup has no passing profile on
 * any backend (bypass inactive by construction), attribution is advisory.
 */

import { describe, it, expect } from "vitest";
import { matchJudgmentProfile, describeJudgmentProfiles } from "./judgment-profiles.js";

describe("#1813 — matchJudgmentProfile", () => {
  it("matches the fitted Jev repeat profile only on the exact model pin", () => {
    const hit = matchJudgmentProfile("jev", "jev-1.13.0", "repeat-v1");
    expect(hit?.repeatGate?.addsThreshold).toBe(0.7);
    expect(matchJudgmentProfile("jev", "jev-1.14.0", "repeat-v1")).toBeNull();
    expect(matchJudgmentProfile("jev", "jev-latest", "repeat-v1")).toBeNull();
  });

  it("matches no lookup profile on either backend (bypass stays inactive)", () => {
    expect(matchJudgmentProfile("jev", "jev-1.13.0", "lookup-v1")).toBeNull();
    expect(matchJudgmentProfile("laya", "laya-sidecar", "lookup-v1")).toBeNull();
  });

  it("matches no repeat profile for laya (held-out failure keeps it inactive)", () => {
    expect(matchJudgmentProfile("laya", "laya-sidecar", "repeat-v1")).toBeNull();
  });

  it("matches advisory attribution profiles without gates", () => {
    expect(matchJudgmentProfile("jev", "jev-1.13.0", "attribution-v1")).not.toBeNull();
    expect(matchJudgmentProfile("laya", "anything", "attribution-v1")).not.toBeNull();
  });

  it("rejects unknown backends", () => {
    expect(matchJudgmentProfile("scripted", "repeat-v1", "repeat-v1")).toBeNull();
  });

  it("describes implemented profiles for status/doctor", () => {
    const text = describeJudgmentProfiles();
    expect(text).toContain("repeat-v1");
    expect(text).toContain("attribution-v1");
  });
});
