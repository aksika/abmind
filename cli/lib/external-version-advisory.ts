/**
 * external-version-advisory.ts — check-only ollama version hints for `abmind deps`.
 *
 * Advisory only: this module never installs, updates, or spawns anything. Every
 * probe is best-effort with a short timeout; any failure degrades to "unknown"
 * and the installed side is still shown. A failing advisory never fails `deps`.
 */

import { spawnSync } from "node:child_process";
import { loadMemoryEnvFile } from "../../src/mem-config-env.js";
import { getAbmindEnv } from "../../src/env-schema.js";

const GITHUB_OLLAMA_LATEST_URL = "https://api.github.com/repos/ollama/ollama/releases/latest";

export interface ExternalAdvisoryInput {
  readonly embeddingProvider: string;
  readonly embeddingModel: string;
  readonly ollamaCli: string | null;
  readonly ollamaServer: string | null;
  readonly ollamaLatest: string | null;
  readonly embeddingModelPresent: boolean | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parse `ollama --version` output ("ollama version is 0.11.4"). */
export function parseOllamaCliVersion(output: string): string | null {
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(output);
  return match?.[1] ?? null;
}

/** Parse GitHub latest-release JSON (`tag_name`, leading "v" stripped). */
export function parseGithubOllamaLatest(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const tag = asNonEmptyString(payload["tag_name"]);
  if (tag === null) return null;
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/** Parse ollama `/api/version` (`{"version": "0.11.4"}`). */
export function parseOllamaServerVersion(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return asNonEmptyString(payload["version"]);
}

/**
 * Check ollama `/api/tags` for the expected embedding model.
 * Null when ollama is unreachable or the payload is unusable — distinct from absent.
 */
export function parseOllamaModelPresent(payload: unknown, expectedModel: string): boolean | null {
  if (!isRecord(payload)) return null;
  const models = payload["models"];
  if (!Array.isArray(models)) return null;
  for (const entry of models) {
    if (!isRecord(entry)) continue;
    const name = asNonEmptyString(entry["name"]);
    if (name !== null && (name === expectedModel || name.startsWith(`${expectedModel}:`))) return true;
  }
  return false;
}

/**
 * Numeric dot-version comparison. Null when either side is not a plain
 * dotted-number version — the caller then shows both without an update nudge.
 */
export function compareVersions(installed: string, latest: string): number | null {
  const parts = (v: string): number[] | null => {
    const out: number[] = [];
    for (const piece of v.split(".")) {
      if (!/^\d+$/.test(piece)) return null;
      out.push(parseInt(piece, 10));
    }
    return out.length > 0 ? out : null;
  };
  const a = parts(installed);
  const b = parts(latest);
  if (a === null || b === null) return null;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function runCapture(cmd: string, args: readonly string[], timeoutMs: number): string | null {
  try {
    const result = spawnSync(cmd, args, { encoding: "utf-8", timeout: timeoutMs });
    const out = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function curlJson(url: string, timeoutSec: number, extraArgs: readonly string[] = []): unknown | null {
  try {
    const result = spawnSync("curl", ["-sf", "--max-time", String(timeoutSec), ...extraArgs, url], {
      encoding: "utf-8",
      timeout: (timeoutSec + 2) * 1000,
    });
    const out = typeof result.stdout === "string" ? result.stdout.trim() : "";
    if (out.length === 0) return null;
    return JSON.parse(out) as unknown;
  } catch {
    return null;
  }
}

function collectExternalAdvisory(): ExternalAdvisoryInput {
  // Source .env.memory before reading config; process env keeps precedence.
  loadMemoryEnvFile();
  const env = getAbmindEnv();
  const embeddingProvider = env.embeddingProvider;
  const embeddingModel = env.embeddingModel;
  const embeddingUrl = env.embeddingUrl.replace(/\/+$/, "");

  const ollamaTags = curlJson(`${embeddingUrl}/api/tags`, 2);

  return {
    embeddingProvider,
    embeddingModel,
    ollamaCli: parseOllamaCliVersion(runCapture("ollama", ["--version"], 5000) ?? ""),
    ollamaServer: parseOllamaServerVersion(curlJson(`${embeddingUrl}/api/version`, 2)),
    ollamaLatest: parseGithubOllamaLatest(
      curlJson(GITHUB_OLLAMA_LATEST_URL, 3, ["-H", "Accept: application/vnd.github+json"]),
    ),
    embeddingModelPresent: ollamaTags === null ? null : parseOllamaModelPresent(ollamaTags, embeddingModel),
  };
}

function renderOllamaLines(input: ExternalAdvisoryInput): string[] {
  if (input.embeddingProvider !== "ollama") {
    return [`  ollama: skipped (EMBEDDING_PROVIDER=${input.embeddingProvider})`];
  }
  const lines: string[] = [];
  const server = input.ollamaServer ?? "unreachable";
  const cli = input.ollamaCli ?? "missing";
  if (input.ollamaLatest === null) {
    lines.push(`  ollama: server ${server}, cli ${cli} (latest unknown — offline?)`);
  } else {
    const basis = input.ollamaServer ?? input.ollamaCli;
    const cmp = basis !== null ? compareVersions(basis, input.ollamaLatest) : null;
    if (cmp === 0) {
      lines.push(`  ollama: up to date (${basis})`);
    } else if (basis === null) {
      lines.push(`  ollama: not installed, latest ${input.ollamaLatest} — install from ollama.com`);
    } else {
      lines.push(
        `  ollama: server ${server}, cli ${cli}, latest ${input.ollamaLatest} — update: brew upgrade ollama (macOS) or reinstall from ollama.com`,
      );
    }
  }
  if (input.embeddingModelPresent === true) {
    lines.push(`  ollama model ${input.embeddingModel}: present`);
  } else if (input.embeddingModelPresent === false) {
    lines.push(`  ollama model ${input.embeddingModel}: missing — run: ollama pull ${input.embeddingModel}`);
  }
  return lines;
}

/** Pure render: every combination of known/unknown/skipped produces hint lines, never throws. */
export function renderExternalAdvisory(input: ExternalAdvisoryInput): string {
  const lines = [...renderOllamaLines(input)];
  return `\nExternal (advisory only — deps does not manage these):\n${lines.join("\n")}\n`;
}

/** Collect + render. Never throws; worst case reports the check as unavailable. */
export function getExternalAdvisoryText(): string {
  try {
    return renderExternalAdvisory(collectExternalAdvisory());
  } catch {
    return "\nExternal (advisory only): version check unavailable\n";
  }
}
