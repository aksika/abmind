# Changelog

All notable changes to abmind are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — pre-1.0 contracts may drift between minor versions.

## [0.1.0] — 2026-04-19

First release with the sleep orchestrator living inside abmind. Previously abmind shipped memory + recall only; the orchestrator lived in AgentBridge.

### Added

- **Sleep orchestrator** (`runSleepCycle`) moved into abmind as a library function. Any host (bridge, MCP, CLI, plugin) provides its own `SleepRuntime` adapter for LLM calls.
- **`SleepRuntime` interface** — one method: `complete(prompt): Promise<string>`. No default implementation — library ships no LLM assumption.
- **Four sleep levels** — `basic` (1 LLM call, single-shot, frontier-model-only), `budget` (~3 calls, essentials), `normal` (~10-14 calls, default), `ultimate` (~14 calls, everything).
- **Basic level** (`abmind sleep --level basic`) — single-shot daily summary + memory extraction via one LLM turn. New prompt template at `prompts/sleep/basic.md`.
- **`abmind sleep` subcommand** — standalone CLI entry point; uses `ABMIND_LLM_CMD` shell template with `{PROMPT_FILE}` substitution.
- **Interval-aware daily files** — multi-day catch-up runs produce `daily_<start>_to_<end>.md` with range heading; single-day runs still produce `daily_<date>.md`.
- **Supersede-delete dedupe** — writing an interval file deletes any single-day files it covers, preventing downstream globbers from double-counting.
- **Package-tree prompts fallback** — sleep prompt loader resolves from the package tree when `$ABMIND_HOME/prompts/sleep/` is absent. Fresh npm installs work without manual prompt copying.
- **Publish metadata** — `types`, `exports.types` condition, `repository`, `bugs`, `homepage`, `keywords`, `publishConfig`, `files` array scoped to shipped artifacts.
- **`CHANGELOG.md`** — this file.

### Changed

- **README** rewritten for npm-install audience first. Clone-from-source instructions moved to Contributing.
- **`SleepRuntime.complete` signature** — `(prompt: string) => Promise<string>`. Replaces bridge-specific `SubagentRuntime.complete(agent, prompt, opts)`.
- **Orchestrator identity** — internal TAG and comments updated from `agentbridge-sleep` to `abmind-sleep`.

### Removed

- **Bridge-specific imports inside the orchestrator** — cron-db dynamic import, transport-config dynamic import. Callers inject equivalents through `RunOpts` when needed.
- **CLI main() in `src/sleep/orchestrator.ts`** — the orchestrator is now library-only. Standalone entry lives in `cli/abmind-sleep.ts`.
