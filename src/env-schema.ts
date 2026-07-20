/**
 * env-schema.ts — Central env var schema for abmind.
 * Single source of truth. All env access goes through getAbmindEnv().
 */

import { logInfo, logWarn } from "./mem-logger.js";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Parsing helpers ─────────────────────────────────────────────────────────

function intSafe(raw: string, name: string, fallback: number): number {
  const n = parseInt(raw, 10);
  if (isNaN(n)) { logWarn("env", `Invalid ${name}: "${raw}" — using default ${fallback}`); return fallback; }
  return n;
}

function floatSafe(raw: string, name: string, fallback: number): number {
  const n = parseFloat(raw);
  if (isNaN(n)) { logWarn("env", `Invalid ${name}: "${raw}" — using default ${fallback}`); return fallback; }
  return n;
}

function clamp(val: number, min: number, max: number, name: string, fallback: number): number {
  if (val < min || val > max) { logWarn("env", `${name}=${val} out of range [${min},${max}] — using default ${fallback}`); return fallback; }
  return val;
}

// ── Config type ─────────────────────────────────────────────────────────────

export interface AbmindEnvConfig {
  readonly abmindHome: string;
  readonly memoryDir: string;
  readonly memorySearchMode: string;
  readonly memoryMaxDbSizeMb: number;
  readonly memoryOriginalTtlDays: number;
  readonly memoryEnglishTtlDays: number;
  readonly memoryAgingEnabled: boolean;
  readonly memoryBackend: string;
  /** Local daemon endpoint socket path (#1380). */
  readonly localEndpoint: string;
  readonly embeddingEnabled: boolean;
  readonly embeddingProvider: "ollama" | "openai";
  readonly embeddingModel: string;
  readonly embeddingUrl: string;
  readonly embeddingApiKey: string;
  readonly embeddingDimensions: number;
  readonly embeddingSimilarityThreshold: number;
  readonly signatureBits: number;
  readonly recallDecayDays: number;
  readonly recallDecayFloor: number;
  readonly recallEmotionBoost: number;
  readonly abmlMinChars: number;
  readonly abmlVersion: "plain" | "v0" | "v1" | "v2";
  // #348 — three-tier context assembly
  readonly contextTierEnabled: boolean;
  readonly contextTierTail: number;
  readonly contextTierMiddle: number;
  readonly compactionLlmEnabled: boolean;
  readonly sleepQuality: string | undefined;
  readonly sleepTimeoutMin: number;
  readonly sleepMaxLlmCalls: number;
  readonly sleepCurationDay: string;
  readonly sleepModelName: string;
  readonly sleepCtxWindow: number;
  readonly keyFile: string;
  readonly passphrase: string | undefined;
  readonly username: string | undefined;
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _env: Readonly<AbmindEnvConfig> | null = null;

/** Get parsed env config. Auto-initializes on first call. */
export function getAbmindEnv(): Readonly<AbmindEnvConfig> {
  if (!_env) initAbmindEnv();
  return _env!;
}

/** Initialize env config from process.env. Call once at boot or auto-called by getAbmindEnv(). */
export function initAbmindEnv(): Readonly<AbmindEnvConfig> {
  const read = (k: string): string | undefined => process.env[k]?.trim() || undefined;
  const readOr = (k: string, d: string): string => read(k) ?? d;

  const abmindHome = readOr("ABMIND_HOME", join(homedir(), ".abmind"));

  const env: AbmindEnvConfig = {
    abmindHome,
    memoryDir: readOr("MEMORY_DIR", join(abmindHome, "memory")),
    memorySearchMode: readOr("MEMORY_SEARCH_MODE", "hybrid"),
    memoryMaxDbSizeMb: intSafe(readOr("MEMORY_MAX_DB_SIZE_MB", "4096"), "MEMORY_MAX_DB_SIZE_MB", 4096),
    memoryOriginalTtlDays: intSafe(readOr("MEMORY_ORIGINAL_TTL_DAYS", "90"), "MEMORY_ORIGINAL_TTL_DAYS", 90),
    memoryEnglishTtlDays: intSafe(readOr("MEMORY_ENGLISH_TTL_DAYS", "14"), "MEMORY_ENGLISH_TTL_DAYS", 14),
    memoryAgingEnabled: read("MEMORY_AGING_ENABLED") !== "false",
    memoryBackend: readOr("MEMORY_BACKEND", "sqlite"),
    localEndpoint: readOr("ABMIND_ENDPOINT", join(abmindHome, "run", "abmind.sock")),
    embeddingEnabled: read("EMBEDDING_ENABLED") !== "false",
    embeddingProvider: ((): "ollama" | "openai" => {
      const v = readOr("EMBEDDING_PROVIDER", "ollama").toLowerCase();
      return v === "openai" ? "openai" : "ollama";
    })(),
    embeddingModel: readOr("EMBEDDING_MODEL", "nomic-embed-text"),
    embeddingUrl: readOr("EMBEDDING_URL", "http://localhost:11434"),
    embeddingApiKey: readOr("EMBEDDING_API_KEY", ""),
    embeddingDimensions: intSafe(readOr("EMBEDDING_DIMENSIONS", "768"), "EMBEDDING_DIMENSIONS", 768),
    embeddingSimilarityThreshold: clamp(
      floatSafe(readOr("EMBEDDING_SIMILARITY_THRESHOLD", "0.5"), "EMBEDDING_SIMILARITY_THRESHOLD", 0.5),
      0, 1, "EMBEDDING_SIMILARITY_THRESHOLD", 0.5,
    ),
    signatureBits: intSafe(readOr("SIGNATURE_BITS", "256"), "SIGNATURE_BITS", 256),
    recallDecayDays: intSafe(readOr("RECALL_DECAY_DAYS", "365"), "RECALL_DECAY_DAYS", 365),
    recallDecayFloor: clamp(
      floatSafe(readOr("RECALL_DECAY_FLOOR", "0.3"), "RECALL_DECAY_FLOOR", 0.3),
      0, 1, "RECALL_DECAY_FLOOR", 0.3,
    ),
    recallEmotionBoost: floatSafe(readOr("RECALL_EMOTION_BOOST", "0.1"), "RECALL_EMOTION_BOOST", 0.1),
    abmlMinChars: intSafe(readOr("ABML_MIN_CHARS", "100"), "ABML_MIN_CHARS", 100),
    abmlVersion: ((): "plain" | "v0" | "v1" | "v2" => { const v = readOr("ABML_VERSION", "plain"); if (v === "v2") return "v2"; if (v === "v1") return "v1"; if (v === "v0") return "v0"; return "plain"; })(),
    // #348 — three-tier context assembly
    contextTierEnabled: readOr("CONTEXT_TIER_ENABLED", "true").toLowerCase() !== "false",
    contextTierTail: intSafe(readOr("CONTEXT_TIER_TAIL", "20"), "CONTEXT_TIER_TAIL", 20),
    contextTierMiddle: intSafe(readOr("CONTEXT_TIER_MIDDLE", "50"), "CONTEXT_TIER_MIDDLE", 50),
    compactionLlmEnabled: readOr("COMPACTION_LLM_ENABLED", "false").toLowerCase() === "true",
    sleepQuality: read("SLEEP_QUALITY"),
    sleepTimeoutMin: intSafe(readOr("SLEEP_TIMEOUT_MIN", "55"), "SLEEP_TIMEOUT_MIN", 55),
    sleepMaxLlmCalls: Math.min(intSafe(readOr("SLEEP_MAX_LLM_CALLS", "18"), "SLEEP_MAX_LLM_CALLS", 18), 50),
    sleepCurationDay: readOr("SLEEP_CURATION_DAY", "sunday").toLowerCase(),
    sleepModelName: readOr("SLEEP_MODEL_NAME", "unknown"),
    sleepCtxWindow: intSafe(readOr("AGENT_SLEEP_CTX_WINDOW", "128000"), "AGENT_SLEEP_CTX_WINDOW", 128000),
    keyFile: readOr("ABMIND_KEY_FILE", join(abmindHome, "secret", "abmind.key")),
    passphrase: read("ABTARS_PASS"),
    username: read("ABMIND_USER"),
  };

  logInfo("env", `${Object.keys(env).length} vars loaded`);
  _env = Object.freeze(env);
  return _env;
}

/** Reset singleton (for tests only). */
export function _resetAbmindEnv(): void { _env = null; }
