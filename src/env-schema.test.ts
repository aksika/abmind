import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initAbmindEnv, getAbmindEnv, _resetAbmindEnv } from "./env-schema.js";

describe("abmind env-schema", () => {
  beforeEach(() => { _resetAbmindEnv(); });
  afterEach(() => { _resetAbmindEnv(); });

  it("returns frozen config with defaults", () => {
    const env = initAbmindEnv();
    expect(env.recallDecayDays).toBe(365);
    expect(env.recallDecayFloor).toBe(0.3);
    expect(env.sleepMaxLlmCalls).toBe(25);
    expect(env.abmlMinChars).toBe(100);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("getAbmindEnv auto-initializes", () => {
    expect(getAbmindEnv().memoryBackend).toBe("sqlite");
  });

  it("clamps RECALL_DECAY_FLOOR to [0,1]", () => {
    process.env["RECALL_DECAY_FLOOR"] = "5.0";
    const env = initAbmindEnv();
    expect(env.recallDecayFloor).toBe(0.3); // clamped to default
    delete process.env["RECALL_DECAY_FLOOR"];
  });

  it("caps SLEEP_MAX_LLM_CALLS at 50", () => {
    process.env["SLEEP_MAX_LLM_CALLS"] = "100";
    const env = initAbmindEnv();
    expect(env.sleepMaxLlmCalls).toBe(50);
    delete process.env["SLEEP_MAX_LLM_CALLS"];
  });

  it("handles NaN gracefully with warning", () => {
    process.env["RECALL_DECAY_DAYS"] = "banana";
    const env = initAbmindEnv();
    expect(env.recallDecayDays).toBe(365); // fallback
    delete process.env["RECALL_DECAY_DAYS"];
  });
});
