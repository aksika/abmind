/**
 * #1812 — System One config resolver tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initAbmindEnv, _resetAbmindEnv } from "./env-schema.js";
import { resolveSystem1Config, describeSystem1Config } from "./system1-config.js";

const KEYS = [
  "SYSTEM1", "SYSTEM1_RECALL", "SYSTEM1_TIMEOUT_MS", "SYSTEM1_MAX_CANDIDATES",
  "JEV_URL", "JEV_API_KEY", "JEV_MODEL", "LAYA_URL",
];

describe("#1812 — resolveSystem1Config", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    _resetAbmindEnv();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetAbmindEnv();
  });

  it("defaults to laya with recall on (#1813 owns the default)", () => {
    const cfg = resolveSystem1Config(initAbmindEnv());
    expect(cfg.state).toBe("on");
    if (cfg.state !== "on" || cfg.backend !== "laya") throw new Error("expected on/laya");
    expect(cfg.recallEnabled).toBe(true);
    expect(cfg.fastpathEnabled).toBe(false);
    expect(cfg.endpoint).toBe("127.0.0.1:8765");
  });

  it("honors explicit off", () => {
    process.env.SYSTEM1 = "off";
    const cfg = resolveSystem1Config(initAbmindEnv());
    // Backend off; recall default stays on (#1813) and is reported, not applied.
    expect(cfg).toEqual({ state: "off", recallRequested: true });
  });

  it("accepts jev with key, model, and recall flag", () => {
    process.env.SYSTEM1 = "jev";
    process.env.JEV_API_KEY = "sk-test";
    process.env.SYSTEM1_RECALL = "on";
    const cfg = resolveSystem1Config(initAbmindEnv());
    expect(cfg).toEqual({
      state: "on", backend: "jev",
      recallEnabled: true, fastpathEnabled: false, timeoutMs: 1500, maxCandidates: 20,
      url: "https://api.typesafe.ai/", endpoint: "api.typesafe.ai",
      model: "jev-1.13.0", keyPresent: true,
    });
  });

  it("is case-insensitive on the selector", () => {
    process.env.SYSTEM1 = "Laya";
    const cfg = resolveSystem1Config(initAbmindEnv());
    expect(cfg.state).toBe("on");
    if (cfg.state === "on") expect(cfg.backend).toBe("laya");
  });

  it("rejects jev without a key, naming the backend", () => {
    process.env.SYSTEM1 = "jev";
    const cfg = resolveSystem1Config(initAbmindEnv());
    expect(cfg.state).toBe("invalid");
    if (cfg.state === "invalid") {
      expect(cfg.backend).toBe("jev");
      expect(cfg.reason).toContain("JEV_API_KEY");
    }
  });

  it("rejects unknown selectors without echoing the value", () => {
    process.env.SYSTEM1 = "sk-super-secret-pasted-by-mistake";
    const cfg = resolveSystem1Config(initAbmindEnv());
    expect(cfg.state).toBe("invalid");
    if (cfg.state === "invalid") {
      expect(cfg.backend).toBeNull();
      expect(cfg.reason).not.toContain("sk-super-secret");
    }
  });

  it("rejects unpinned jev models", () => {
    process.env.SYSTEM1 = "jev";
    process.env.JEV_API_KEY = "sk-test";
    process.env.JEV_MODEL = "jev-latest";
    const cfg = resolveSystem1Config(initAbmindEnv());
    expect(cfg.state).toBe("invalid");
  });

  it("rejects non-https, credentialed, and decorated jev URLs", () => {
    process.env.SYSTEM1 = "jev";
    process.env.JEV_API_KEY = "sk-test";
    for (const bad of [
      "http://api.typesafe.ai",
      "https://user:pass@api.typesafe.ai",
      "https://api.typesafe.ai/v1?key=x",
      "https://api.typesafe.ai#frag",
      "not a url",
    ]) {
      process.env.JEV_URL = bad;
      expect(resolveSystem1Config(initAbmindEnv()).state, bad).toBe("invalid");
    }
  });

  it("accepts loopback laya URLs and rejects the rest", () => {
    process.env.SYSTEM1 = "laya";
    for (const good of ["http://127.0.0.1:8765", "http://localhost:9999/", "http://[::1]:8765"]) {
      process.env.LAYA_URL = good;
      const cfg = resolveSystem1Config(initAbmindEnv());
      expect(cfg.state, good).toBe("on");
    }
    for (const bad of ["http://example.com/", "http://127.0.0.1:8765/?x=1", "http://u@127.0.0.1:8765"]) {
      process.env.LAYA_URL = bad;
      const cfg = resolveSystem1Config(initAbmindEnv());
      expect(cfg.state, bad).toBe("invalid");
      if (cfg.state === "invalid") expect(cfg.backend).toBe("laya");
    }
  });

  it("falls back to defaults on out-of-range timeout and candidate bounds", () => {
    process.env.SYSTEM1 = "laya";
    process.env.SYSTEM1_TIMEOUT_MS = "5";
    process.env.SYSTEM1_MAX_CANDIDATES = "99";
    const cfg = resolveSystem1Config(initAbmindEnv());
    if (cfg.state !== "on") throw new Error("expected on");
    // env-schema clamp semantics: out of range returns the default.
    expect(cfg.timeoutMs).toBe(1500);
    expect(cfg.maxCandidates).toBe(20);
    process.env.SYSTEM1_TIMEOUT_MS = "500";
    process.env.SYSTEM1_MAX_CANDIDATES = "10";
    const wide = resolveSystem1Config(initAbmindEnv());
    if (wide.state !== "on") throw new Error("expected on");
    expect(wide.timeoutMs).toBe(500);
    expect(wide.maxCandidates).toBe(10);
  });

  it("treats an unrecognized recall flag as off (fail-safe)", () => {
    process.env.SYSTEM1 = "laya";
    process.env.SYSTEM1_RECALL = "yes";
    const cfg = resolveSystem1Config(initAbmindEnv());
    if (cfg.state !== "on") throw new Error("expected on");
    expect(cfg.recallEnabled).toBe(false);
    process.env.SYSTEM1_RECALL = "ON";
    const upper = resolveSystem1Config(initAbmindEnv());
    if (upper.state !== "on") throw new Error("expected on");
    expect(upper.recallEnabled).toBe(true);
  });

  it("describeSystem1Config never prints secrets", () => {
    process.env.SYSTEM1 = "jev";
    process.env.JEV_API_KEY = "sk-super-secret-key-12345";
    const line = describeSystem1Config(resolveSystem1Config(initAbmindEnv()));
    expect(line).toContain("jev-1.13.0");
    expect(line).not.toContain("sk-super-secret");
  });

  it("describeSystem1Config covers off, on, and invalid", () => {
    process.env.SYSTEM1 = "off";
    expect(describeSystem1Config(resolveSystem1Config(initAbmindEnv()))).toContain("off");
    process.env.SYSTEM1 = "laya";
    process.env.SYSTEM1_RECALL = "on";
    expect(describeSystem1Config(resolveSystem1Config(initAbmindEnv()))).toContain("127.0.0.1:8765");
    process.env.SYSTEM1 = "bogus";
    const invalid = describeSystem1Config(resolveSystem1Config(initAbmindEnv()));
    expect(invalid).toContain("unavailable");
    expect(invalid).toContain("recall requested on");
    process.env.SYSTEM1_RECALL = "off";
    expect(describeSystem1Config(resolveSystem1Config(initAbmindEnv()))).toContain("recall off");
  });
});
