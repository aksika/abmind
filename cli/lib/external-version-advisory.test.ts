import { describe, expect, it } from "vitest";
import {
  compareVersions,
  parseGithubOllamaLatest,
  parseOllamaCliVersion,
  parseOllamaModelPresent,
  parseOllamaServerVersion,
  renderExternalAdvisory,
  type ExternalAdvisoryInput,
} from "./external-version-advisory.js";

const BASE: ExternalAdvisoryInput = {
  embeddingProvider: "ollama",
  embeddingModel: "nomic-embed-text",
  ollamaCli: "0.11.4",
  ollamaServer: "0.11.4",
  ollamaLatest: "0.35.1",
  embeddingModelPresent: true,
};

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
  it("nudges with the exact update command when stale", () => {
    const text = renderExternalAdvisory(BASE);
    expect(text).toContain("latest 0.35.1");
    expect(text).toContain("ollama model nomic-embed-text: present");
  });

  it("reports up to date without an update nudge", () => {
    const text = renderExternalAdvisory({ ...BASE, ollamaServer: "0.35.1", ollamaCli: "0.35.1" });
    expect(text).toContain("ollama: up to date (0.35.1)");
  });

  it("degrades to installed-only when offline", () => {
    const text = renderExternalAdvisory({ ...BASE, ollamaLatest: null, embeddingModelPresent: null });
    expect(text).toContain("latest unknown — offline?");
  });

  it("skips ollama when the provider is not ollama", () => {
    const text = renderExternalAdvisory({ ...BASE, embeddingProvider: "openai" });
    expect(text).toContain("ollama: skipped (EMBEDDING_PROVIDER=openai)");
  });

  it("points at the missing embedding model pull command", () => {
    const text = renderExternalAdvisory({ ...BASE, embeddingModelPresent: false });
    expect(text).toContain("ollama model nomic-embed-text: missing — run: ollama pull nomic-embed-text");
  });

});
