/**
 * abmind — standalone memory system.
 *
 * Public API: IMemorySystem interface + MemoryManager implementation.
 * All consumers should import from this index.
 */

// Interface
export type { IMemoryCore, IMemorySystem, IHeartbeat } from "./imemory-system.js";

// Implementation
export { MemoryManager } from "./memory-manager.js";

// Config
export { loadMemoryConfig, MEMORY_CONFIG_DEFAULTS } from "./memory-config.js";
export type { MemoryConfig } from "./memory-config.js";

// Backend (for CLIs that need direct access)
export { createMemoryBackend } from "./backend-factory.js";
export { SqliteBackend } from "./sqlite-backend.js";
export type { MemoryBackend } from "./memory-backend.js";

// IPC (for embedding abmind in a host process)
export { MemoryIpcServer } from "./memory-ipc-server.js";

// Types
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

// Utilities (for standalone use)
export { setLogger } from "./mem-logger.js";
export { abmindHome } from "./mem-paths.js";
export { redactSecrets, SECRET_PATTERNS } from "./redact-secrets.js";

// Sleep state (for sleep CLI)
export { SleepStateGatherer } from "./sleep-state-gatherer.js";
export type { StateSnapshot } from "./sleep-state-gatherer.js";
export { SleepDataAccess } from "./sleep-data-access.js";
export type { SleepCandidateLists, EmotionalProfileEntry } from "./sleep-data-access.js";

// Recall engine (for search controller)
export { recallSearch } from "./recall-engine.js";
export type { RecallParams, RecallHit, RecallResult, RecallContext } from "./recall-engine.js";
export { applyContextBoost } from "./recall-engine.js";

// Emotion utils
export { emojiToScore, emojiToTag, scoreFromTags, effectiveEmotion, tagFromScore } from "./emotion-utils.js";

// Session context
export { buildSessionStartContext } from "./session-context.js";
export { buildMemoryContext } from "./session-memory.js";

// Media
export { sanitizeForSummary } from "./media-sanitizer.js";

// Context engine
export { ContextEngine } from "./context-engine.js";
export type { ContextMessage, ContextSummary, ContextSnapshot, CompactionChunk, ContextWatermark } from "./context-engine.js";
export { CHARS_PER_TOKEN, TAIL_TOKENS, TAIL_MIN_MESSAGES, MAX_CHUNK_TOKENS, COMPACTION_THRESHOLD_PCT, CONDENSATION_THRESHOLD_TOKENS } from "./context-engine.js";
export { renderForContext, renderMiddleTurn, determineTier, refineMiddleTierBatch } from "./context-tier-renderer.js";
export type { TieredContextResult, TierBreakdown, Tier, MessageWithHints } from "./context-tier-renderer.js";
export { LlmRefinementCache } from "./tier-llm-refinement.js";
export type { RefineLlmFn } from "./tier-llm-refinement.js";
export { classifyTurn, typeCodeToFull } from "./turn-classifier.js";
export type { TurnHints } from "./turn-classifier.js";

// Ingest pipeline
export { IngestPipeline } from "./ingest-pipeline.js";
export type { IngestMetadata, IngestResult } from "./ingest-pipeline.js";

// Backup/restore
export { createBackup, restoreBackup } from "./backup.js";
export type { BackupResult, RestoreResult } from "./backup.js";

// Embedding
export { loadEmbedConfig, batchEmbed, embedText } from "./ollama-embed.js";

// ABM v2 — store-time enrichment
export { detectEmotions } from "./emotion-tagger.js";
export type { EmotionTag } from "./emotion-tagger.js";
export { detectFlags } from "./importance-flagger.js";
export type { ImportanceFlag } from "./importance-flagger.js";
export { compress } from "./memory-compressor.js";
export { renderMemory } from "./memory-renderer.js";
export { TYPE_EMOJI, TOPIC_EMOJI, EMOTION_EMOJI, confidenceMarker } from "./abm-v2-vocab.js";
export { generateSignature, hammingDistance, hammingSimilarity } from "./signature-generator.js";

// ABM v2 — sleep-time intelligence
export { buildArc } from "./emotion-arc.js";
export { checkContradiction } from "./contradiction-checker.js";
export { buildTimelines, buildCrossTopicTimelines, renderTimeline, renderCrossTopicTimeline, renderTimelines } from "./timeline-builder.js";
export type { Timeline, RenderedTimeline, TimelineMemory } from "./timeline-builder.js";

// ABM v2 — session start
export { buildWakeUp } from "./wake-up-builder.js";

// ABM v2 — brain patterns
export { isFlashbulb, isAgingProtected, effectiveConfidence, detectInterference } from "./brain-patterns.js";

// Security — prompt injection detection
export { scanForInjection } from "./injection-scanner.js";
export type { ScanResult, InjectionFlag } from "./injection-scanner.js";

// ABM v2 — config
export { loadMemoryEnv } from "./mem-config-env.js";
export type { SearchMode, MemoryEnvConfig } from "./mem-config-env.js";

// ABM v2 — compression level 2
export { renderWakeUp, compressDailySummary, compressSoul, pickLevel } from "./wake-up-renderer.js";
export type { CompressionLevel } from "./wake-up-renderer.js";

// ABM v2 — embedding quantization
export { quantizeToInt8, cosineSimInt8 } from "./embedding-quantize.js";
export { checkEmbeddingHealth } from "./embedding-health.js";
export type { EmbeddingHealth } from "./embedding-health.js";

// Sleep pipeline
export { loadSleepSteps, buildSleepVars, substituteVars } from "./sleep-pipeline.js";
export type { SleepStep } from "./sleep-pipeline.js";
export { buildDailySummary, writeDailyFile } from "./sleep-pipeline.js";
export { extractFromDaily } from "./sleep-pipeline.js";

// Sleep orchestrator (moved from agentbridge in #163)
export { runSleepCycle, SleepInitError, SleepTimeoutError } from "./sleep/orchestrator.js";
export type { RunOpts, RunResult } from "./sleep/orchestrator.js";
export type { SleepRuntime } from "./sleep/runtime.js";
export { type Level, parseLevel, DEFAULT_LEVEL } from "./sleep/levels.js";
export { runBasicCycle, parseBasicResponse } from "./sleep/basic.js";
export type { BasicOpts, BasicResult } from "./sleep/basic.js";
export { hasSleepAuditToday } from "./sleep/trigger.js";
export { MaintenanceService, type PreSleepResults } from "./maintenance-service.js";
