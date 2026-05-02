import { getAbmindEnv } from "./env-schema.js";
import { join } from "node:path";
import { parseBoolEnv, parseNumberEnv } from "./mem-env.js";
import { abmindHome } from "./mem-paths.js";
import { loadMemoryEnv } from "./mem-config-env.js";

/** Configuration for the local memory layer. */
export type MemoryConfig = {
  memoryEnabled: boolean;
  memoryDir: string;
  maxMessagesPerChat: number;
  diskBudgetBytes: number;
  stalenessThresholdMs: number;
  restoreMessageCount: number;
  /** Maximum token size per ingestion chunk. */
  ingestChunkMaxTokens: number;
  /** Embedding model name for hot-swap detection. */
  embeddingModel: string;
  /** Relevance threshold for topic-based forgetting. */
  forgetThreshold: number;
  /** Search enhancement configuration for temporal decay, MMR, and timeouts. */
  searchEnhancements: {
    searchTimeoutMs: number;
    decayHalflifeDays: number;
    mmrLambda: number;
    compactThresholdPct: number;
  };
};

/** Default values for all memory configuration fields. */
export const MEMORY_CONFIG_DEFAULTS: MemoryConfig = {
  memoryEnabled: true,
  memoryDir: join(abmindHome(), "memory"),
  maxMessagesPerChat: 1000,
  diskBudgetBytes: 500 * 1024 * 1024,
  stalenessThresholdMs: 24 * 3600_000,
  restoreMessageCount: 50,
  ingestChunkMaxTokens: 512,
  embeddingModel: "nomic-embed-text",
  forgetThreshold: 0.8,
  searchEnhancements: {
    searchTimeoutMs: 1000,
    decayHalflifeDays: 30,
    mmrLambda: 0.7,
    compactThresholdPct: 85,
  },
};

/**
 * Load memory configuration from `process.env` with sensible defaults.
 * Invalid values produce a warning and fall back to defaults (never throws).
 */
export function loadMemoryConfig(): MemoryConfig {
  // Source ~/.abmind/config/.env.memory into process.env before reading.
  // Host env wins via ?? semantics. Eliminates the bug class where callers
  // (CLI/MCP/plugin) would forget to invoke the loader. See #210.
  loadMemoryEnv();

  const memoryEnabled = parseBoolEnv("MEMORY_ENABLED", MEMORY_CONFIG_DEFAULTS.memoryEnabled);
  const memoryDir = getAbmindEnv().memoryDir;

  const maxMessagesPerChat = parseNumberEnv(
    "MEMORY_MAX_MESSAGES_PER_CHAT",
    MEMORY_CONFIG_DEFAULTS.maxMessagesPerChat,
  );
  const diskBudgetMb = parseNumberEnv("MEMORY_DISK_BUDGET_MB", 500);
  const diskBudgetBytes = diskBudgetMb * 1024 * 1024;

  const stalenessHours = parseNumberEnv("MEMORY_STALENESS_HOURS", 24);
  const stalenessThresholdMs = stalenessHours * 3_600_000;

  const restoreMessageCount = parseNumberEnv(
    "MEMORY_RESTORE_MESSAGES",
    MEMORY_CONFIG_DEFAULTS.restoreMessageCount,
  );

  const ingestChunkMaxTokens = parseNumberEnv(
    "MEMORY_INGEST_CHUNK_MAX_TOKENS",
    MEMORY_CONFIG_DEFAULTS.ingestChunkMaxTokens,
  );

  const embeddingModel = getAbmindEnv().embeddingModel;

  const forgetThreshold = parseNumberEnv("MEMORY_FORGET_THRESHOLD", MEMORY_CONFIG_DEFAULTS.forgetThreshold);

  return {
    memoryEnabled,
    memoryDir,
    maxMessagesPerChat,
    diskBudgetBytes,
    stalenessThresholdMs,
    restoreMessageCount,
    ingestChunkMaxTokens,
    embeddingModel,
    forgetThreshold,
    searchEnhancements: {
      searchTimeoutMs: parseNumberEnv("MEMORY_SEARCH_TIMEOUT_MS", MEMORY_CONFIG_DEFAULTS.searchEnhancements.searchTimeoutMs),
      decayHalflifeDays: parseNumberEnv("MEMORY_DECAY_HALFLIFE_DAYS", MEMORY_CONFIG_DEFAULTS.searchEnhancements.decayHalflifeDays),
      mmrLambda: parseNumberEnv("MEMORY_MMR_LAMBDA", MEMORY_CONFIG_DEFAULTS.searchEnhancements.mmrLambda),
      compactThresholdPct: parseNumberEnv("MEMORY_COMPACT_THRESHOLD_PCT", MEMORY_CONFIG_DEFAULTS.searchEnhancements.compactThresholdPct),
    },
  };
}
