# abmind — Supported Public Surface

The contract external consumers (abtars, future CLIs, the OpenClaw plugin) may depend on.
**Source of truth: `src/index.ts`**, re-exported via the package `.` entry. Anything listed
here is covered by abmind's version-compatibility promise; changes are semver-significant.

> Introduced 2026-06-28 (#1243) at **0.3.0** to formalize the abtars↔abmind boundary so the
> two products can release independently. abtars declares a required abmind range and checks
> it at boot; abmind is NOT a dependency of abtars — it is discovered at runtime.

## Supported entry points (package `exports`)

| Subpath | Purpose |
|---------|---------|
| `.` (`src/index.ts`) | Primary API — everything below |
| `./openclaw-plugin` | OpenClaw lifecycle plugin |
| `./deploy-lib` | Release-lifecycle helpers (abtars vendors its own copy; see #1231 — orthogonal) |
| `./package.json` | Version introspection (used by abtars boot version check) |

## Core
- `MemoryManager` — the memory facade. Includes `available?: boolean`, a **consumer-managed**
  runtime flag (abmind does not read or set it).
- `IMemorySystem`, `IMemoryCore` — consumer-facing interfaces.
- `MemoryConfig`, `MEMORY_CONFIG_DEFAULTS`, `loadMemoryConfig`, `loadMemoryEnv`, `SearchMode`, `MemoryEnvConfig`.

## Recall + citation
- `recallSearch`, `RecallParams`, `RecallHit`, `RecallResult`, `RecallContext`.
- `detectCitations`, `RecallMemoryRef`.

## Context engine + orchestrator
- `ContextEngine` + its types; `ContextOrchestrator`, `ContextOrchestratorConfig`, `ContextResult`, `SummarizeFn`; `renderForContext` + tiered-context types.

## Sleep (#1353 host-neutral contract)
- `runSleepCycle`, `SleepInitError`, `essentialSleepSteps` (lazy manifest-derived set of steps whose failure blocks watermark advance; replaces the eager `ESSENTIAL_STEPS` constant).
- Types: `SleepCompletionRequest`, `SleepRuntime`, `SleepRunMode`, `SleepRunOptions`, `SleepTerminalStatus`, `SleepStepSummary`, `SleepRunResult`, `SleepEvent`.
- `Level` / `parseLevel` / `DEFAULT_LEVEL`, `hasSleepAuditToday`.
- `loadSleepSteps`, `SleepStep` — step manifest for display only, not orchestration. `SleepStep` no longer carries `skippable`; step policy (order, prompt file, `timeoutMs`, `essential`, eligibility) lives in `~/.abmind/config/sleep.json`.
- abmind owns: step ordering, shared variables, wired memory maintenance, essential-step rules, LLM-call budget, checkpoints/resume/catch-up/watermark, and the domain terminal result.
- The host owns: scheduling, admission, model/provider transport (including its own retry/fallback before `SleepRuntime.complete()` may reject), agent/session lifecycle, cancellation on shutdown, and delivery.
- `SleepCompletionRequest.deadlineAt` is the absolute deadline of the current provider attempt: it covers queueing and that attempt's model subcalls. The host must enforce the supplied deadline and must not extend it with its own provider retry clock. Abmind may send a newly refreshed deadline for a later domain retry — the timestamp is per-attempt, not a single immutable logical-step deadline.
- A host never reads `sleep_*.lock` — `SleepRunResult` (returned) and `SleepEvent` (via `onEvent`) are the only supported ways to learn what happened. Internal lock-file JSON is unexported and may change without notice.
- `SleepTimeoutError` is intentionally NOT exported — a timeout is an internal cancellation reason; the public terminal result is `status: "cancelled"` with `resumable` set truthfully.

## Backend + IPC
- `SqliteBackend`, `MemoryBackend`, `createMemoryBackend`.
- `MemoryIpcServer`.

## Host integration (#1341)
- `ExecutionIdentity`, `HostLifecycleOptions`, `AutomaticRecallPolicy` — identity and policy types.
- `StartSessionInput` / `StartSessionResult`, `PrepareTurnInput` / `PrepareTurnResult`, `CompleteTurnInput` / `CompleteTurnResult` — lifecycle operation types.
- `ExplicitRecallInput`, `RecallOperationResult`, `ExplicitStoreInput` — explicit operation types.
- `HostDiagnostic` — safe error diagnostic type.
- `HostMemoryLifecycle` — provider-neutral lifecycle service (wraps `MemoryManager`).
- `validateIdentity`, `isValidIdentityField`, `canAutoWrite`, `buildProvenance` — identity helpers.
- `renderWakeUp`, `renderRecallContext` — neutral bounded-text renderers.
- Consumers import host-integration types directly from `"abmind"`.
- Host adapters (OpenClaw, Hermes) are not included — see `docs/integration-guide.md` for the integration pattern.

## Crypto / secrets
- `loadKey`, `encrypt`, `decrypt`, `hasKey`, `deriveKey`, `deriveFromPassphrase`, `getSecretsKey`, `getBackupKey`, and the rest of the `crypto` re-exports.

## NOT supported (internal — may change without notice)
Anything not re-exported from `src/index.ts`: `memory-db.ts` internals, `recall-engine`
internals, `sqlite-backend` private members, the `@internal`-marked accessors
(`getMemoryIndex()` / `getDatabase()` / `getDb()`), and embedding/ollama internals. Consumers
that reach past `index.ts` do so at their own risk and may break on minor releases.

## Native dependencies (consumer's responsibility)
`better-sqlite3` and `sqlite-vec` are `optionalDependencies`, resolved by abmind at runtime
from the global `~/.local/lib/node_modules` (or `NODE_PATH`). They are NOT bundled. See
`abmind doctor` for health checks.
