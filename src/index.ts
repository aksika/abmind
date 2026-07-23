/**
 * abmind — standalone memory system.
 *
 * Public API: only what external consumers (abtars, future CLIs) need.
 * Internal modules import directly from their source files.
 */

// ── Core ────────────────────────────────────────────────────────────────────

export type { IMemoryCore, IMemorySystem, IOperationalMemoryCore, OperationalMemoryApi } from "./imemory-system.js";
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
  MemoryTier,
  VectorSearchResult,
  MemorySearchParams,
} from "./mem-types.js";

// ── Recall ──────────────────────────────────────────────────────────────────

export { recallSearch } from "./recall-engine.js";
export { extractEnglishTokens } from "./query-tokenizer.js";
export type { RecallParams, RecallHit, RecallResult, RecallContext } from "./recall-engine.js";
export { detectCitations } from "./citation-detector.js";
export type { RecallMemoryRef } from "./citation-detector.js";

// ── Context Engine + Orchestrator ───────────────────────────────────────────

export { ContextEngine } from "./context-engine.js";
export type { ContextMessage, ContextSummary, ContextSnapshot, CompactionChunk, ContextWatermark } from "./context-engine.js";
export { CHARS_PER_TOKEN, TAIL_TOKENS, TAIL_MIN_MESSAGES, MAX_CHUNK_TOKENS, COMPACT_TRIGGER_PCT, CONDENSATION_THRESHOLD_TOKENS } from "./context-engine.js";
export { renderForContext } from "./context-tier-renderer.js";
export type { TieredContextResult, TierBreakdown } from "./context-tier-renderer.js";
export { ContextOrchestrator } from "./context-orchestrator.js";
export type { ContextOrchestratorConfig, ContextResult, ContextQueryOptions, SummarizeFn, CompactionResult, CompactionEvent, CompactionLevel } from "./context-orchestrator.js";

// ── Checkpoint Store ────────────────────────────────────────────────────────

export { CheckpointStore, computeDigest } from "./context-checkpoint-store.js";
export type { CheckpointRecord, ActiveCheckpointPointer, StableContextView, StableContextBudget } from "./context-checkpoint-store.js";

// ── Sleep (public entry points only) ────────────────────────────────────────

export { runSleepCycle, SleepInitError, ESSENTIAL_STEPS } from "./sleep/orchestrator.js";
export type { SleepCompletionRequest, SleepRuntime, SleepRunMode, SleepRunOptions, SleepTerminalStatus, SleepStepSummary, SleepRunResult, SleepEvent } from "./sleep/contracts.js";
export { type Level, parseLevel, DEFAULT_LEVEL } from "./sleep/levels.js";
export { hasSleepAuditToday } from "./sleep/trigger.js";

// Step manifest (for stepped card display) — additive exports from sleep-pipeline
export { loadSleepSteps } from "./sleep-pipeline.js";
export type { SleepStep } from "./sleep-pipeline.js";

// ── Session context ─────────────────────────────────────────────────────────

export { buildSessionStartContext } from "./session-context.js";
export { buildMemoryContext } from "./session-memory.js";
export { renderMemory } from "./memory-renderer.js";
export { buildWakeUp } from "./wake-up-builder.js";
export { buildStatusBlock } from "./status-block.js";

// ── Security ────────────────────────────────────────────────────────────────

export { scanForInjection } from "./injection-scanner.js";
export type { ScanResult, InjectionFlag } from "./injection-scanner.js";
export { redactSecrets, SECRET_PATTERNS } from "./redact-secrets.js";

// ── Utilities ───────────────────────────────────────────────────────────────

export { abmindHome } from "./mem-paths.js";
export { emojiToScore, emojiToTag, scoreFromTags, effectiveEmotion, tagFromScore } from "./emotion-utils.js";

// ── Backend (standalone/CLI use) ────────────────────────────────────────────

export { createMemoryBackend, createEmbeddedMemoryBackend, createClientBackend, getMemoryClient, createLocalClient, closeClient, isClient, isManager } from "./backend-factory.js";
export type { MemoryClient } from "./backend-factory.js";
export { SqliteBackend } from "./sqlite-backend.js";
export type { MemoryBackend } from "./memory-backend.js";

// ── Local endpoint and transport (#1380) ────────────────────────────────────

export { LocalEndpointServer } from "./local-endpoint-server.js";
export type { LocalEndpointServerConfig } from "./local-endpoint-server.js";
export { LocalTransport } from "./local-transport.js";
export { createFrameAccumulator, encodeFrame, decodeFrameHead, FrameCodecError, FRAME_HEADER_BYTES, FRAME_MAX_PAYLOAD_BYTES, REQUEST_TIMEOUT_MS } from "./abmind-frame-codec.js";
export type { FrameAccumulator } from "./abmind-frame-codec.js";
export { UnixPeerIdentityProvider, InjectablePeerIdentityProvider, getSocketPeerIdentity } from "./local-peer-identity.js";
export type { LocalPeerIdentity, LocalPeerIdentityProvider } from "./local-peer-identity.js";

// ── Abmind Service Protocol (#1379) ─────────────────────────────────────────

export { AbmindClient } from "./abmind-client.js";
export type { AbmindSystemApi, AbmindPrivateMemoryApi, AbmindOperatorApi } from "./abmind-client.js";
export type { DoctorCheckResult, DoctorRepairAction, DoctorRepairResult, DoctorStatus } from "./abmind-protocol.js";
export { AbmindService, AbmindRequestLedger } from "./abmind-service.js";
export type { AbmindServiceConfig, ReservationResult } from "./abmind-service.js";
export { EmbeddedTransport } from "./embedded-transport.js";
export { AbmindServiceHost, createEmbeddedAbmind } from "./abmind-service-host.js";
export type { AbmindOwnerConfig, AbmindServicePolicy, EmbeddedCaller, EmbeddedAbmind } from "./abmind-service-host.js";
export { createOwnerLease, createProcessIdentityProvider, LinuxProcessIdentity, MacOsProcessIdentity, InjectableProcessIdentity, cleanTombstones, getCanonicalLeaseDir, OwnerLeaseError } from "./abmind-owner-lease.js";
export type { OwnerLease, OwnerLeaseRecordV1, ProcessIdentityProvider, OwnerLeaseConfig } from "./abmind-owner-lease.js";
export type {
  AbmindRequestV1, AbmindResponseV1, AbmindErrorBodyV1, AbmindCurrentV1,
  AbmindErrorCodeV1, AbmindMethod, AbmindMethodMap, AbmindCapabilitiesV1,
  AbmindSystemHealthOutput, AbmindSystemStatusOutput, AbmindTransport,
  ServiceCallContext, CallerRole, DomainName, AuthenticatedBy, MethodEntry,
  RecordMessageInput, RecordMessageOutput,
  GetRecentConversationInput, GetRecentConversationOutput,
  GetRuntimeStatusInput, GetRuntimeStatusOutput,
  GetCoreKnowledgeInput, GetCoreKnowledgeOutput,
  RecordFeedbackInput, RecordFeedbackOutput,
} from "./abmind-protocol.js";
export {
  ABMIND_PROTOCOL_VERSION, ABMIND_VERSION, METHOD_REGISTRY,
  REQUEST_ID_MAX, IDEMPOTENCY_KEY_MAX, PRINCIPAL_ID_MAX,
  REQUEST_MAX_BYTES, RESPONSE_MAX_BYTES, canonicalPayloadHash,
  isMutatingMethod, isIdempotencyRequired, methodDomain,
} from "./abmind-protocol.js";

// ── Backup ──────────────────────────────────────────────────────────────────

export { createBackup, restoreBackup } from "./backup.js";
export type { BackupResult, RestoreResult } from "./backup.js";

// Embedding health (used by abtars onboard)
export { checkEmbeddingHealth } from "./embedding-health.js";
export type { EmbeddingHealth } from "./embedding-health.js";

// ── Host Integration ────────────────────────────────────────────────────────

export type {
  ExecutionIdentity,
  HostLifecycleOptions,
  AutomaticRecallPolicy,
  StartSessionInput,
  StartSessionResult,
  PrepareTurnInput,
  PrepareTurnResult,
  CompleteTurnInput,
  CompleteTurnResult,
  ExplicitRecallInput,
  RecallOperationResult,
  ExplicitStoreInput,
  HostDiagnostic,
} from "./host-integration/types.js";

export { validateIdentity, isValidIdentityField, canAutoWrite, buildProvenance, HostMemoryLifecycle, renderWakeUp, renderRecallContext } from "./host-integration/index.js";

// ── Remote / Signed WSS (#1381) ──────────────────────────────────────────────

export {
  ABMIND_WSS_PROTOCOL_VERSION, ABMIND_WSS_DOMAIN_HELLO, ABMIND_WSS_DOMAIN_REQUEST,
  WSS_HELLO_CHALLENGE_BYTES, WSS_HELLO_EXPIRY_MS, WSS_PEER_ID_MAX,
  WSS_CONNECTION_ID_MAX, WSS_FRAME_ID_MAX, WSS_MAX_RAW_FRAME_BYTES,
  WSS_MAX_BODY_BYTES, WSS_NONCE_BYTES, WSS_TIMESTAMP_WINDOW_SEC,
  WSS_AUTH_RESPONSE_MAX_BYTES, WSS_MAX_INFLIGHT, WSS_MAX_QUEUED_WRITE_BYTES,
  WSS_HANDSHAKE_TIMEOUT_MS, WSS_REQUEST_TIMEOUT_MS, WSS_IDLE_TIMEOUT_MS,
  WSS_RECONNECT_BASE_MS, WSS_RECONNECT_MAX_MS, WSS_RECONNECT_MAX_ATTEMPTS,
  WSS_OUTBOX_MAX_ENTRIES, WSS_OUTBOX_MAX_ENTRY_BYTES, WSS_OUTBOX_MAX_FILE_BYTES,
  buildRequestCanonical, buildHelloCanonical,
  signHello, verifyHello, signRequest, verifyRequestSignature,
  generateSigningKey, deriveVerifyKey, verifyCertificatePin,
  NonceStore, RequestOutbox, RemoteAudit,
  loadEndpointConfig, loadEnrollments, loadGrants, loadClientProfiles,
  resolveRemoteContext, isMethodAllowed, negotiateMethods,
  makeDefaultGrant, DEFAULT_REMOTE_GRANT_METHODS,
  AUDIT_MAX_RECORD_BYTES, AUDIT_MAX_FILE_BYTES,
  type SignedHelloV1, type WssAuthFields,
  type SignedAbmindRequestFrameV1, type AbmindResponseFrameV1,
  type WssServerFrameV1, type WssClientFrameV1, type WssTransportCapabilities,
  type VerifyResult,
  type NonceClaimResult, type NonceClaimResultOk,
  type NonceClaimResultReplay, type NonceClaimResultStoreError,
  type OutboxEntry, type OutboxFileV1,
  type RemoteEndpointConfig, type RemoteEnrollmentV1,
  type RemoteGrantV1, type RemoteClientProfileV1, type RemoteConfig,
  type RemoteAuditRecordV1,
} from "./remote/index.js";

// Crypto (secret vault)
export { encrypt, decrypt, hasKey, loadKey, getSecretsKey, getBackupKey, deriveKey, deriveFromPassphrase, writeKeyVerify, validateKey, loadKeyFromFile, _resetKeyCache } from "./crypto.js";

export { readFromKeyring, writeToKeyring } from "./keyring.js";
export { metaGet, metaGetInt, metaSet, metaIncrement } from "./meta-store.js";

// ── Operational Memory (#1371, #1372) ─────────────────────────────────────

export type {
  OperationalDraft,
  OperationalMemoryProjection,
  OperationalMemoryVersion,
  OperationalRecallHit,
  OperationalWriteResult,
  OperationalResult,
  Page,
  PageRequest,
  DraftListQuery,
  OperationalRecallQuery,
  SubmitOperationalDraftInput,
  CreateDraftInput,
  PromoteDraftInput,
  RejectDraftInput,
  ReviseOperationalMemoryInput,
  RetireOperationalMemoryInput,
  ScopeLevel,
  DraftStatus,
  MemoryStatus,
  EvidenceEntry,
  ProvenanceMap,
  NormalizedScope,
  OperationalScope,
} from "./operational-memory-types.js";
export {
  computeContentHash,
  normalizeScope,
  getScopeValue,
  validateCreateDraftInput,
  validatePromoteDraftInput,
  validateRejectDraftInput,
  validateReviseInput,
  validateRetireInput,
  ValidationError,
  ID_MAX,
  ACTOR_SOURCE_MAX,
  SCOPE_VALUE_MAX,
  LESSON_MAX,
  CONTENT_MAX,
  REASON_MAX,
  QUERY_MAX,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  CURSOR_MAX,
  PAGE_SERIALIZED_MAX,
  RECALL_SCAN_CHUNK,
  RECALL_EXAMINE_MAX,
} from "./operational-memory-types.js";
