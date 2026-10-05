import { describe, expect, it } from "vitest";
import {
  compareVersions,
  parseGithubOllamaLatest,
  parseLayaHealth,
  parseOllamaCliVersion,
  parseOllamaModelPresent,
  parseOllamaServerVersion,
  parsePipShowVersion,
  parsePyPiLatest,
  renderExternalAdvisory,
  type ExternalAdvisoryInput,
} from "./external-version-advisory.js";

const BASE: ExternalAdvisoryInput = {
  system1: "laya",
  embeddingProvider: "ollama",
  embeddingModel: "nomic-embed-text",
  layaSidecarVersion: "0.3.21",
  layaInstalled: "0.3.21",
  layaLatest: "0.3.28",
  layaVenvPresent: true,
  ollamaCli: "0.11.4",
  ollamaServer: "0.11.4",
  ollamaLatest: "0.35.1",
  embeddingModelPresent: true,
};

describe("parsePipShowVersion", () => {
  it("reads the Version field", () => {
    expect(parsePipShowVersion("Name: laya\nVersion: 0.3.21\nSummary: x\n")).toBe("0.3.21");
  });

  it("returns null when absent", () => {
    expect(parsePipShowVersion("Name: laya\n")).toBeNull();
    expect(parsePipShowVersion("")).toBeNull();
  });
});

describe("parseOllamaCliVersion", () => {
  it("reads the version number", () => {
    expect(parseOllamaCliVersion("ollama version is 0.11.4\n")).toBe("0.11.4");
  });

  it("returns null when missing", () => {
    expect(parseOllamaCliVersion("")).toBeNull();
    expect(parseOllamaCliVersion("no version here")).toBeNull();
  });
});

describe("payload parsers reject unusable ingress", () => {
  it("PyPI latest needs info.version", () => {
    expect(parsePyPiLatest({ info: { version: "0.3.28" } })).toBe("0.3.28");
    expect(parsePyPiLatest({ info: {} })).toBeNull();
    expect(parsePyPiLatest(null)).toBeNull();
    expect(parsePyPiLatest("0.3.28")).toBeNull();
  });

  it("GitHub latest strips the v prefix", () => {
    expect(parseGithubOllamaLatest({ tag_name: "v0.35.1" })).toBe("0.35.1");
    expect(parseGithubOllamaLatest({ tag_name: "0.35.1" })).toBe("0.35.1");
    expect(parseGithubOllamaLatest({})).toBeNull();
    expect(parseGithubOllamaLatest(null)).toBeNull();
  });

  it("ollama server version needs a version string", () => {
    expect(parseOllamaServerVersion({ version: "0.11.4" })).toBe("0.11.4");
    expect(parseOllamaServerVersion({})).toBeNull();
    expect(parseOllamaServerVersion(null)).toBeNull();
  });

  it("laya health tolerates a warming (null) version", () => {
    expect(parseLayaHealth({ layaVersion: "0.3.21" })).toEqual({ layaVersion: "0.3.21" });
    expect(parseLayaHealth({ layaVersion: null })).toEqual({ layaVersion: null });
    expect(parseLayaHealth(null)).toEqual({ layaVersion: null });
  });

  it("model presence distinguishes absent from unreachable", () => {
    const tags = { models: [{ name: "nomic-embed-text:latest" }] };
    expect(parseOllamaModelPresent(tags, "nomic-embed-text")).toBe(true);
    expect(parseOllamaModelPresent({ models: [{ name: "other" }] }, "nomic-embed-text")).toBe(false);
    expect(parseOllamaModelPresent(null, "nomic-embed-text")).toBeNull();
    expect(parseOllamaModelPresent({}, "nomic-embed-text")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders dotted versions", () => {
    expect(compareVersions("0.3.21", "0.3.28")).toBe(-1);
    expect(compareVersions("0.35.1", "0.11.4")).toBe(1);
    expect(compareVersions("0.3.21", "0.3.21")).toBe(0);
  });

  it("returns null for non-numeric versions", () => {
    expect(compareVersions("unknown", "0.3.28")).toBeNull();
    expect(compareVersions("0.3.21", "")).toBeNull();
  });
});

describe("renderExternalAdvisory", () => {
  it("nudges with the exact separate update commands when stale", () => {
    const text = renderExternalAdvisory(BASE);
    expect(text).toContain("laya: installed 0.3.21, latest 0.3.28");
    expect(text).toContain("~/.laya-venv/bin/pip install -U laya && abmind service restart");
    expect(text).toContain("latest 0.35.1");
    expect(text).toContain("ollama model nomic-embed-text: present");
  });

  it("reports up to date without an update nudge", () => {
    const text = renderExternalAdvisory({ ...BASE, layaSidecarVersion: "0.3.28", layaInstalled: "0.3.28" });
    expect(text).toContain("laya: up to date (0.3.28)");
    expect(text).not.toContain("pip install -U laya");
  });

  it("degrades to installed-only when offline", () => {
    const text = renderExternalAdvisory({ ...BASE, layaLatest: null, ollamaLatest: null, embeddingModelPresent: null });
    expect(text).toContain("laya: installed 0.3.21 (latest unknown — offline?)");
    expect(text).toContain("latest unknown — offline?");
  });

  it("skips laya when the backend is not laya and ollama when the provider is not ollama", () => {
    const text = renderExternalAdvisory({ ...BASE, system1: "jev", embeddingProvider: "openai" });
    expect(text).toContain("laya: skipped (SYSTEM1=jev)");
    expect(text).toContain("ollama: skipped (EMBEDDING_PROVIDER=openai)");
  });

  it("points at the missing embedding model pull command", () => {
    const text = renderExternalAdvisory({ ...BASE, embeddingModelPresent: false });
    expect(text).toContain("ollama model nomic-embed-text: missing — run: ollama pull nomic-embed-text");
  });

  it("reports a missing venv with the setup pointer", () => {
    const text = renderExternalAdvisory({
      ...BASE,
      layaSidecarVersion: null,
      layaInstalled: null,
      layaVenvPresent: false,
    });
    expect(text).toContain("laya: not installed (no ~/.laya-venv)");
    expect(text).toContain("docs/wiki/laya.md");
  });
});
