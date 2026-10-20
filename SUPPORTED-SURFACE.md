# abmind — Supported Public Surface

The contract external consumers (abtars, future CLIs) may depend on.
**Source of truth: `src/index.ts`**, re-exported via the package `.` entry. Anything listed
here is covered by abmind's version-compatibility promise; changes are semver-significant.

> Introduced 2026-06-28 (#1243) at **0.3.0** to formalize the abtars↔abmind boundary so the
> two products can release independently. abtars declares a required abmind range and checks
> it at boot; abmind is NOT a dependency of abtars — it is discovered at runtime.

## Supported entry points (package `exports`)

| Subpath | Purpose |
|---------|---------|
| `.` (`src/index.ts`) | Primary API — everything below |
| `./deploy-lib` | Release-lifecycle helpers (abtars vendors its own copy; see #1231 — orthogonal) |
| `./package.json` | Version introspection (used by abtars boot version check) |

## Retired entry points

- `./openclaw-plugin` (#1899): the OpenClaw lifecycle plugin, `openclaw.plugin.json`
  manifest, and `openclaw.extensions` discovery metadata were removed. Importing
  `abmind/openclaw-plugin` is intentionally unsupported from the release
  containing this change; there is no alias or compatibility module. The
  one-time `abmind migrate-openclaw` transcript importer is unaffected.

## Core
- `MemoryManager` — the memory facade. Includes `available?: boolean`, a **consumer-managed**
  runtime flag (abmind does not read or set it).
- `IMemorySystem`, `IMemoryCore` — consumer-facing interfaces.
- `MemoryConfig`, `MEMORY_CONFIG_DEFAULTS`, `loadMemoryConfig`, `loadMemoryEnv`, `SearchMode`, `MemoryEnvConfig`.

## Recall + citation
- Owned recall (#1928 M4) — `ownedRecall`, `OWNED_RECALL_CONTRACT` (`owned-v1`, advertised as `personal_recall_contract` in negotiation features), `OwnedRecallRequest`/`OwnedRecallPacket`, `OwnedRecallRef` (layer/recordId/owner/version; numeric IDs never identify evidence alone), `validateOwnedRecallRequest`, `OWNED_PROFILE_BOUNDS`. Required profile (`recall_fast` compact regardless of route; `recall_normal`/`recall_full` explicit and never auto-skip), contract admission before searching, owner authorization against the startup snapshot, capacity ceilings per profile, and owner-rendered text with packet accounting. `private.recall` carries the owned request and returns the owner packet; the redundant `private.lifecycleRecall` and the `private.checkWorthRetrieving` preflight are retired with no aliases. `abmind recall --profile ...` exposes all three profiles with capacity/filter options and source-safe refs.
- Retrieval projections (#1928 M2) — `inspectRecallProjection`, `verifyRecallProjection`, `buildRecallProjection` (verified-backup gate, generation barrier, idempotent resume), single-writer maintenance (`indexDurableDocument`, `indexEpisodeDocument`, `dropSourceDocuments`, `reconcileServingDocuments`), restore invalidation (`invalidateRecallProjections`), `recallProjectionStatus`, and `private.getRuntimeStatus` `personal`/`projection` blocks (also routed through MCP `memory_status`). Sealed exact values never enter; `abmind personal --action projection-inspect|projection-build --backup` is the reviewed operator surface.
- Owned pipeline (#1928 M3/M4) — `runOwnedPipeline` with mapped database stages (Sf.1 Porter, Sf.2/Sf.3 trigrams, Se embeddings with the shared foreground query cap, Ss deterministic signature coverage, S8 source-bound graph), shared deterministic fusion (RRF K=60, context weight 0.5, MMR lambda=0.7), profile work/output limits, safe grounding from verified preserved excerpts with full-only neighbor expansion, full-only bounded S6 summaries, C5 continuation paging, and as-of history resolution. No legacy memory search remains behind any maintained route.
- Generation binding (#1928 C7, folded #1910) — `ExecutionIdentity.generation` survives every lifecycle normalizer and RPC boundary (absent means 0; negative/fractional/non-numeric is rejected, never coerced). Context snapshots are usable only when the request identity names host and conversation and the snapshot matches principal/host/conversation/generation, carries an execution different from the current one, and is complete; otherwise `contextRejected` explains the raw-only search. Continuation handles bind principal, host, conversation, session generation, anchor, filters and serving generation, so a reset/rewind yields `continuation_invalid_identity` and a fresh search. The packet echoes `host`, `conversation`, `execution` and `generation` so a host can drop a late packet after a reset.
- Ambient planning (#1908) — ambient turns plan in abmind: the verbatim raw turn is primary and at most one contextual plan joins from eligible completed-turn snapshots (`AmbientContextOption[]` bound to the current identity). `RecallSkipReason` is the closed skip-reason set. No host translation or semantic policy objects are accepted.
- `detectCitations`, `RecallMemoryRef`.

## Feedback counters (#1913, retired #1928 A13)
- Retired: `private.recordFeedback` and the `bumpCitedCount`/`bumpRejectedCount` helpers are gone with no alias. Reactions resolve the delivered answer for tracking only; no learning write is attempted or claimed. Legacy `cited_count`/`rejected_count` columns remain as historical data with no production reader; durable outcome feedback belongs to #1820.

## System One judgments (#1812, retired #1928 M5)
- Retired: no provider construction, boot health probe, recall reranking, advisory sleep judging, or Jev/Laya adapters/egress. Historical receipts and artifacts may still carry inert `judgment` JSON; the decoder ignores it and settlement never reads it.

## Context engine + orchestrator (#1940 retired)
- Retired: conversation compaction, durable-context projection and the checkpoint lineage — `ContextEngine`, `ContextOrchestrator`/`ContextResult`/`SummarizeFn`, `renderForContext`/tiered-context types, `CheckpointStore`, and the `private.projectConversationContext` / `private.prepareConversationCompaction` / `private.commitConversationCompaction` methods (no aliases). Legacy `context_summaries`/`context_watermarks`/checkpoint rows stay inert with no production reader; schema is unchanged. Hosts own Pi-side compaction; abmind supplies SOUL, hydration, recall, sleep checkpoints, archive and forget.

## Sleep (#1353 host-neutral contract)
- `runSleepCycle`, `SleepInitError`, `essentialSleepSteps` (lazy manifest-derived set of steps whose failure blocks watermark advance; replaces the eager `ESSENTIAL_STEPS` constant).
- Types: `SleepCompletionRequest`, `SleepRuntime`, `SleepRunMode`, `SleepRunOptions`, `SleepTerminalStatus`, `SleepStepSummary`, `SleepRunResult`, `SleepEvent`.
- `Level` / `parseLevel` / `DEFAULT_LEVEL`, `hasSleepAuditToday`.
- `loadSleepSteps`, `SleepStep` — step manifest for display only, not orchestration. `SleepStep` no longer carries `skippable`; step policy (order, prompt file, `timeoutMs`, `essential`, eligibility) lives in `~/.abmind/config/sleep.json`.
- abmind owns: step ordering, shared variables, wired memory maintenance, essential-step rules, LLM-call budget, checkpoints/resume/catch-up/watermark, and the domain terminal result.
- The host owns: scheduling, admission, model/provider transport (including its own retry/fallback before `SleepRuntime.complete()` may reject), agent/session lifecycle, cancellation on shutdown, and delivery.
- `SleepCompletionRequest.deadlineAt` is the absolute deadline of the current provider attempt: it covers queueing and that attempt's model subcalls. The host must enforce the supplied deadline and must not extend it with its own provider retry clock. Abmind may send a newly refreshed deadline for a later domain retry — the timestamp is per-attempt, not a single immutable logical-step deadline.
- `SleepCompletionRequest.proposalOnly` (#1859) marks turns where the host must withhold every state-changing tool; the model may only return proposal text that abmind validates and applies. A host declares its enforcement by setting `SleepRuntime.proposalOnlyCapable` (daemon-bridged hosts declare it at `sleep.runtime.open` via `capabilities.proposalOnly`); abmind fails a proposal-only step closed without a model call when the runtime does not declare it.
- A host never reads `sleep_*.lock` — `SleepRunResult` (returned) and `SleepEvent` (via `onEvent`) are the only supported ways to learn what happened. Internal lock-file JSON is unexported and may change without notice.
- `SleepTimeoutError` is intentionally NOT exported — a timeout is an internal cancellation reason; the public terminal result is `status: "cancelled"` with `resumable` set truthfully.

## Backend + IPC
- `SqliteBackend`, `MemoryBackend`, `createMemoryBackend`.
- `MemoryIpcServer`.

## Host integration (#1341)
- `ExecutionIdentity`, `HostLifecycleOptions` — identity and options types.
- `StartSessionInput` / `StartSessionResult`, `PrepareTurnInput` / `PrepareTurnResult`, `CompleteTurnInput` / `CompleteTurnResult`, `ExplicitStoreInput` — lifecycle operation types. `prepareTurn` takes the verbatim turn, trusted context, and host capacity, invokes the common fast core, and returns its owner packet; the redundant explicit recall operation is retired.
- `HostDiagnostic` — safe error diagnostic type.
- `HostMemoryLifecycle` — provider-neutral lifecycle service (wraps `MemoryManager`).
- `validateIdentity`, `isValidIdentityField`, `canAutoWrite`, `buildProvenance` — identity helpers.
- `renderWakeUp` — neutral bounded-text session renderer. Host-side recall rendering, score/age floors, numeric-ref selection, and local clipping are retired.
- Consumers import host-integration types directly from `"abmind"`.
- Host adapters (Hermes) are not included — see `docs/integration-guide.md` for the integration pattern.

## Crypto / secrets
- `loadKey`, `encrypt`, `decrypt`, `hasKey`, `deriveKey`, `deriveFromPassphrase`, `getSecretsKey`, `getBackupKey`, and the rest of the `crypto` re-exports.

## NOT supported (internal — may change without notice)
Anything not re-exported from `src/index.ts`: `memory-db.ts` internals,
`sqlite-backend` private members, the `@internal`-marked accessors
(`getMemoryIndex()` / `getDatabase()` / `getDb()`), and embedding/ollama internals. Consumers
that reach past `index.ts` do so at their own risk and may break on minor releases.

## Native dependencies (consumer's responsibility)
`better-sqlite3` and `sqlite-vec` are `optionalDependencies`, resolved by abmind at runtime
from the global `~/.local/lib/node_modules` (or `NODE_PATH`). They are NOT bundled. See
`abmind doctor` for health checks.
