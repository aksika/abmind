/**
 * abmind — standalone memory system.
 *
 * Public API: only what external consumers (abtars, future CLIs) need.
 * Internal modules import directly from their source files.
 */

// ── Core ────────────────────────────────────────────────────────────────────

export type { IMemoryCore, IMemorySystem, IHeartbeat } from "./imemory-system.js";
export { MemoryManager } from "./memory-manager.js";

// ── Config ──────────────────────────────────────────────────────────────────

export { loadMemoryConfig, MEMORY_CONFIG_DEFAULTS } from "./memory-config.js";
export type { MemoryConfig } from "./memory-config.js";
export { loadMemoryEnv } from "./mem-config-env.js";
export type { SearchMode, MemoryEnvConfig } from "./mem-config-env.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type {
  MessageRecord,
  SearchResult,
  SearchOptions,
  ForgetResult,
  InstantStoreParams,
  InstantStoreResult,
  EditMemoryParams,
  EditMemoryResult,
  ExtractedMemory,
  MemorySearchResult,
  HeartbeatTask,
  MemoryTier,
  VectorSearchResult,
  MemorySearchParams,
} from "./mem-types.js";

// ── Recall ──────────────────────────────────────────────────────────────────

export { recallSearch } from "./recall-engine.js";
export type { RecallParams, RecallHit, RecallResult, RecallContext } from "./recall-engine.js";

// ── Context Engine + Orchestrator ───────────────────────────────────────────

export { ContextEngine } from "./context-engine.js";
export type { ContextMessage, ContextSummary, ContextSnapshot, CompactionChunk, ContextWatermark } from "./context-engine.js";
export { CHARS_PER_TOKEN, TAIL_TOKENS, TAIL_MIN_MESSAGES, MAX_CHUNK_TOKENS, COMPACT_TRIGGER_PCT, CONDENSATION_THRESHOLD_TOKENS } from "./context-engine.js";
export { renderForContext } from "./context-tier-renderer.js";
export type { TieredContextResult, TierBreakdown } from "./context-tier-renderer.js";
export { ContextOrchestrator } from "./context-orchestrator.js";
export type { ContextOrchestratorConfig, ContextResult, SummarizeFn } from "./context-orchestrator.js";

// ── Sleep (public entry points only) ────────────────────────────────────────

export { runSleepCycle, SleepInitError, SleepTimeoutError } from "./sleep/orchestrator.js";
export type { RunOpts, RunResult } from "./sleep/orchestrator.js";
export type { SleepRuntime } from "./sleep/runtime.js";
export { type Level, parseLevel, DEFAULT_LEVEL } from "./sleep/levels.js";
export { hasSleepAuditToday } from "./sleep/trigger.js";

// ── Session context ─────────────────────────────────────────────────────────

export { buildSessionStartContext } from "./session-context.js";
export { buildMemoryContext } from "./session-memory.js";
export { renderMemory } from "./memory-renderer.js";
export { buildWakeUp } from "./wake-up-builder.js";

// ── Security ────────────────────────────────────────────────────────────────

export { scanForInjection } from "./injection-scanner.js";
export type { ScanResult, InjectionFlag } from "./injection-scanner.js";
export { redactSecrets, SECRET_PATTERNS } from "./redact-secrets.js";

// ── Utilities ───────────────────────────────────────────────────────────────

export { abmindHome } from "./mem-paths.js";
export { emojiToScore, emojiToTag, scoreFromTags, effectiveEmotion, tagFromScore } from "./emotion-utils.js";

// ── Backend (standalone/CLI use) ────────────────────────────────────────────

export { createMemoryBackend } from "./backend-factory.js";
export { SqliteBackend } from "./sqlite-backend.js";
export type { MemoryBackend } from "./memory-backend.js";

// ── IPC ─────────────────────────────────────────────────────────────────────

export { MemoryIpcServer } from "./memory-ipc-server.js";

// ── Backup ──────────────────────────────────────────────────────────────────

export { createBackup, restoreBackup } from "./backup.js";
export type { BackupResult, RestoreResult } from "./backup.js";

// Embedding health (used by abtars onboard)
export { checkEmbeddingHealth } from "./embedding-health.js";
export type { EmbeddingHealth } from "./embedding-health.js";

// Crypto (secret vault)
export { encrypt, decrypt, hasKey, getSecretsKey, getBackupKey, deriveKey, deriveFromPassphrase, writeKeyVerify, validateKey, loadKeyFromFile, _resetKeyCache } from "./crypto.js";
export { readFromKeyring, writeToKeyring } from "./keyring.js";
export { metaGet, metaGetInt, metaSet, metaIncrement } from "./meta-store.js";
