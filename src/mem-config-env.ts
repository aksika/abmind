/**
 * mem-config-env.ts — Load .env.memory into process.env before schema reads it.
 * Must be called before initAbmindEnv() / getAbmindEnv().
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { abmindHome } from "./mem-paths.js";

export type SearchMode = "hybrid" | "embedding" | "signature";

export interface MemoryEnvConfig {
  searchMode: SearchMode;
  maxDbSizeMb: number;
  originalTtlDays: number;
  englishTtlDays: number;
  agingEnabled: boolean;
  signatureBits: number;
}

/** Load .env.memory from ~/.abmind/config/.env.memory into process.env. */
export function loadMemoryEnvFile(): void {
  const envPath = join(abmindHome(), "config", ".env.memory");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && val) process.env[key] = process.env[key] ?? val;
  }
}

import { getAbmindEnv, _resetAbmindEnv } from "./env-schema.js";

/** Get memory config from schema. Kept for backward compat with callers. */
export function loadMemoryEnv(): MemoryEnvConfig {
  loadMemoryEnvFile();
  _resetAbmindEnv(); // re-read after loading .env.memory
  const env = getAbmindEnv();
  const mode = env.memorySearchMode;
  return {
    searchMode: (mode === "hybrid" || mode === "embedding" || mode === "signature") ? mode : "hybrid",
    maxDbSizeMb: env.memoryMaxDbSizeMb,
    originalTtlDays: env.memoryOriginalTtlDays,
    englishTtlDays: env.memoryEnglishTtlDays,
    agingEnabled: env.memoryAgingEnabled,
    signatureBits: env.signatureBits,
  };
}
