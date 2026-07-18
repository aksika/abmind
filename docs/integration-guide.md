# abmind Integration Guide

How to add persistent memory to your Node.js agent using abmind.

---

## Installation

```bash
npm install abmind
```

Runtime dependencies: `better-sqlite3`, `@modelcontextprotocol/sdk`.
Optional peer dep: `@sinclair/typebox` (only needed for OpenClaw plugin schemas).

abmind stores data at `~/.abmind/` by default (override with `$ABMIND_HOME`). First run creates the directory, SQLite database, and FTS5 indexes automatically.

---

## Basic Usage (in-process)

```ts
import { MemoryManager } from "abmind";

const memory = new MemoryManager();
await memory.initialize();

// Record a conversation message
memory.recordMessage({
  role: "user",
  content: "I prefer dark mode in all my editors",
  timestamp: Date.now(),
  userId: "alice",
  sessionId: "session-001",
});

// Search memories (FTS5 + trigram + vector)
const results = await memory.search("editor preferences", { userId: "alice", limit: 5 });
for (const r of results) {
  console.log(r.score, r.record.content);
}

// Full recall pipeline (4-stage: FTS + trigram + embedding + consolidation)
const recall = await memory.recallSearch({
  translated: ["dark mode", "editor"],
  userId: "alice",
  limit: 5,
});
for (const hit of recall.results) {
  console.log(hit.score, hit.content_en);
}

// Get wake-up context (core knowledge + recent memories)
const context = memory.buildWakeUp(4000); // max 4000 chars

// Clean shutdown
memory.close();
```

---

## LLM Integration

abmind needs an LLM for sleep maintenance (memory extraction, consolidation, contradiction checking). Inject your LLM call function:

```ts
memory.setLlmCall(async (systemPrompt: string, userContent: string): Promise<string> => {
  const response = await yourLlmClient.chat({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });
  return response.text;
});
```

Without `setLlmCall`, memory storage and recall work fine — only sleep/extraction features require it.

---

## Integration Patterns

### Pattern A: Standalone CLI

Use abmind as a command-line memory tool alongside any agent framework:

```bash
abmind install          # first-time setup
abmind recall --translated "project deadlines" --user-id alice
abmind store --translated "Alice prefers TypeScript" --memory-type preference --user-id alice
abmind sleep --level budget   # run memory consolidation
```

Works with Kiro CLI, Claude Code, Gemini CLI — any tool that can shell out.

### Pattern B: MCP Server

Expose memory as an MCP tool server (stdio transport):

```bash
abmind mcp
```

Provides tools: `memory_recall`, `memory_store`, `memory_edit`, `memory_status`. Any MCP-compatible client (Claude Desktop, Kiro, VS Code extensions) connects directly.

### Pattern C: In-process (chat bot / agent runtime)

Embed `MemoryManager` directly in your Node.js process. This is what abtars does:

```ts
import { MemoryManager } from "abmind";

const memory = new MemoryManager();
await memory.initialize();

// Wire into your message loop
function onUserMessage(msg: string, userId: string, sessionId: string): void {
  memory.recordMessage({ role: "user", content: msg, timestamp: Date.now(), userId, sessionId });
}

// Inject context before LLM call
async function buildPrompt(userId: string, query: string): Promise<string> {
  const recall = await memory.recallSearch({
    translated: query.split(" ").slice(0, 5), // top keywords
    userId,
    limit: 3,
  });
  const memoryContext = recall.results.map(r => r.content_en).join("\n");
  return `## Relevant memories\n${memoryContext}\n\n## User message\n${query}`;
}
```

### Pattern D: OpenClaw Plugin

abmind ships as a drop-in OpenClaw plugin (replaces `@martian-engineering/lossless-claw`):

```bash
openclaw plugins install --link /path/to/abmind
```

Registers automatically:
- **ContextEngine** — ingest, assemble, compact, afterTurn
- **Memory capability** — promptBuilder, runtime (search), publicArtifacts
- **Agent tool** — `abmind_recall` (agent can search memories mid-turn)
- **Lifecycle hooks** — autoRecall (before_agent_start), autoCapture (agent_end)

Configure in your OpenClaw project config:
```json
{
  "plugins": {
    "slots": { "contextEngine": "abmind" },
    "entries": {
      "abmind": {
        "config": {
          "autoRecall": true,
          "autoCapture": true,
          "autoRecallMaxResults": 3,
          "autoRecallMinScore": 0.3
        }
      }
    }
  }
}
```

Migrating from lossless-claw? Import existing sessions:
```bash
abmind migrate-openclaw ~/.openclaw/agents/main/sessions/
```

---

## Kiro CLI Integration

abmind has two integration patterns for Kiro CLI (`kiro-cli chat`). Pick one; they coexist but shouldn't both be active on the same agent config.

### Pattern A: Dedicated abmind agent

Copy `abmind.json` + `abmind.md` into `~/.kiro/agents/`. Users opt in per session via `/agent abmind`. The agent's prompt teaches it to call `abmind recall`, `abmind store`, `abmind wake-up` via shell.

Memory works only when the user is in the `abmind` agent. Agent decides when to recall vs skip, when to curate a store vs let Dreamy handle it.

### Pattern B: Agent-agnostic lifecycle hooks (#344)

Add three lines to ANY Kiro agent's JSON config and that agent becomes memory-aware. No prompt copy-paste, no `/agent` switching.

**Install:**
```bash
curl -fsSL https://raw.githubusercontent.com/aksika/abmind/main/scripts/install-standalone.sh -o install-standalone.sh
sh install-standalone.sh   # installs abmind standalone; first-time `abmind install` runs automatically
```

**Wire up** — edit `~/.kiro/agents/<your-agent>.json` (or `global.json` for all agents):

```json
{
  "hooks": {
    "agentSpawn":       [{ "command": "abmind hook-wakeup",  "description": "abmind wake-up" }],
    "userPromptSubmit": [{ "command": "abmind hook-recall",  "description": "abmind recall" }],
    "stop":             [{ "command": "abmind hook-store",   "description": "abmind store" }]
  }
}
```

Reference template: see `templates/with-abmind-hooks.json` in the abmind repo.

**Verify:**
```bash
abmind hook-doctor     # shows current state + recent errors + env config
abmind status          # includes hook error count if any
```

**Environment config** (all optional):

| Variable | Default | Effect |
|---|---|---|
| `ABMIND_HOOKS_DISABLED` | `false` | Hooks short-circuit to exit 0, no memory touched |
| `ABMIND_HOOK_RECALL_LIMIT` | `5` | Max results from recall hook |
| `ABMIND_HOOK_RECALL_MAX_CHARS` | `2000` | Cap on injected recall text |
| `ABMIND_HOOK_WAKEUP_MAX_CHARS` | `5000` | Cap on wake-up injection |

**SECRET memories are NEVER injected via hooks.** The recall hook is hardcoded to `maxClassification=2`. Credentials surface only on explicit `abmind recall` or via the dedicated agent pattern.

### When to use which

| Factor | Pattern A (dedicated agent) | Pattern B (hooks) |
|---|---|---|
| Works with any agent | No, only `abmind` | Yes — edit any config |
| Prompt token cost | ~3KB every session | 0 |
| Contextual nuance (skip recall on code-exec turns) | Agent can decide | Always runs |
| Curated stores (agent filters) | Yes | No — every turn recorded |
| Records on Ctrl+C / crash / session timeout | Yes (inline during tool calls) | **No** (stop hook doesn't fire) |
| Error visibility | Inline in chat | `abmind hook-doctor` |
| Setup complexity | Copy 2 files | 3-line JSON edit |
| Token-cost per turn | Zero (agent asks when needed) | ≤2000 chars injected on every turn |

Pattern A if you want curation + inline error visibility. Pattern B if you want memory across all your agents without touching prompts.

**Do not enable both on the same agent config.** Recall would fire twice (agent prompt + hook) and stores would duplicate.

---

## Gemini CLI Integration

abmind ships a `gemini-cli` extension (`gemini-extension/` in the repo) that mirrors Pattern B above: lifecycle hooks inject wake-up context on session start, recall on every user prompt, and record the turn on stop. The extension also registers abmind's MCP server and adds three slash commands.

Unlike Kiro, `gemini-cli` has no per-session agent selector — extensions are always-on when enabled. Scope control is via enable/disable or the `-e` flag.

### Install

```bash
# 1. Make sure abmind itself is installed (see install.md)
abmind status   # should print version + lock state

# 2. Link the extension from the abmind checkout
gemini-cli extensions link /path/to/abmind/gemini-extension
# accept the prompt ("⚠️ This extension contains Hooks …")

# 3. Enable the hook system (user-wide, one-time)
#    Add to ~/.gemini/settings.json:
#    { "tools": { "enableHooks": true } }

# 4. Verify
gemini-cli extensions list         # should show ✓ abmind-memory (0.1.0)
gemini-cli -y -p "hi"              # log should show "Hook registry initialized with 3 hook entries"
```

Without `tools.enableHooks=true`, the extension still loads (MCP + GEMINI.md) but hooks are silently skipped.

### What the extension provides

**Hooks** (`hooks/hooks.json`) — map to gemini-cli native event names:

| Event | Command | Purpose |
|---|---|---|
| `SessionStart` | `abmind hook-wakeup` | Inject wake-up context on session open |
| `BeforeAgent` | `abmind hook-recall` | Recall + inject `[abmind memory context]` before every user turn |
| `AfterAgent` | `jq '.assistant_response = .prompt_response' \| abmind hook-store` | Record user prompt + model response after each turn |

The `jq` pipe on `AfterAgent` renames gemini's `prompt_response` field to the `assistant_response` field that `abmind hook-store` expects. `jq` must be on PATH.

**MCP server** (`mcpServers.abmind`) — runs `abmind mcp` on stdio, giving the model `memory_recall`, `memory_store`, `memory_edit`, `memory_status` as tools it can call mid-turn (e.g. to search at higher classification than the hook-injected recall allows, or to do entity-filtered lookups).

**Context file** (`GEMINI.md`) — auto-loaded into every session. Explains the automatic hook behavior, translation rules, when to call MCP tools directly, storage conventions, and consolidation.

**Slash commands** (`commands/*.toml`):
- `/recall <query>` — shell out to `abmind recall` and synthesize results
- `/store <text>` — shell out to `abmind store` with `memory_type=fact`
- `/wakeup` — print current `abmind wake-up` brief

### Scope control

Gemini-cli has no `--agent` flag, but several ways to scope the extension:

```bash
# Only load this extension for one run
gemini-cli -e abmind-memory -p "..."

# Toggle without uninstalling
gemini-cli extensions disable abmind-memory                    # user-wide
gemini-cli extensions disable --scope workspace abmind-memory  # current dir only
gemini-cli extensions enable abmind-memory

# Hard kill-switch per invocation (exit 0 immediately, no DB touched)
ABMIND_HOOKS_DISABLED=true gemini-cli -p "..."

# Kill the whole gemini hook subsystem (MCP + GEMINI.md still work)
# set "tools": { "enableHooks": false } in ~/.gemini/settings.json
```

### Differences vs Kiro Pattern B

| Aspect | Kiro | Gemini |
|---|---|---|
| Hook event names in config | `agentSpawn`, `userPromptSubmit`, `stop` | `SessionStart`, `BeforeAgent`, `AfterAgent` |
| Kiro-style aliases accepted in config? | n/a (native) | No — gemini-cli only aliases at runtime input, not in `hooks.json` |
| `stop`/`AfterAgent` payload field for model reply | `assistant_response` | `prompt_response` (hence the `jq` shim) |
| Global hook enable flag | None (per-agent in JSON) | `tools.enableHooks` in `~/.gemini/settings.json` |
| Per-session agent selector | `/agent abmind` or `--agent` | None — use `-e abmind-memory` for opt-in |
| Records on Ctrl+C / crash | No (stop hook doesn't fire) | No (same — `AfterAgent` doesn't fire on interrupt) |

Same SECRET-tier guarantee applies: `BeforeAgent` hook is hardcoded to `maxClassification=2`. Credentials only surface via explicit MCP tool call or direct CLI.

### Environment variables

All `ABMIND_HOOK*` vars from the Kiro table apply unchanged — the hook commands are identical binaries.

---

## Claude Code Integration

> ⚠️ **ALPHA — unverified end-to-end.** Structure, hooks, and MCP wiring are validated, but hook-stdout → model-context injection is not yet confirmed with a live API key. Config will work; model behavior may need tuning. See `claude-code-extension/README.md` "Alpha caveats" for details. Ticket: #365.

abmind ships a Claude Code extension (`claude-code-extension/` in the repo) that mirrors the gemini-cli pattern: lifecycle hooks inject wake-up context on session start, recall on every user prompt, and record the turn on stop. The extension also registers abmind's MCP server and ships a `CLAUDE.md` with the ground-truth rule.

Unlike gemini-cli, Claude Code's hook system works out of the box with no enable flag, injects hook stdout directly into the model context (no structured-output wrapper), and uses `assistant_response` natively (no `jq` rename shim). So Claude Code is the simplest host to wire into.

### Install

```bash
# 1. Make sure abmind itself is installed (see install.md)
abmind status   # should print version + lock state

# 2. Install Claude Code globally
npm install -g @anthropic-ai/claude-code
claude --version    # verify

# 3. From the abmind repo's claude-code-extension/ dir:
cd /path/to/abmind/claude-code-extension
mkdir -p ~/.claude

# 4. Install CLAUDE.md (symlink for live updates, or copy)
ln -sf "$(pwd)/CLAUDE.md" ~/.claude/CLAUDE.md

# 5. Install settings.json (copy if empty; merge if you have existing settings)
if [ -s ~/.claude/settings.json ]; then
    # existing config — merge with jq
    jq -s '.[0] * .[1]' ~/.claude/settings.json settings.json > /tmp/merged.json \
        && mv /tmp/merged.json ~/.claude/settings.json
else
    cp settings.json ~/.claude/settings.json
fi

# 6. Register the abmind MCP server (stored separately in ~/.claude.json)
claude mcp add abmind abmind mcp

# 7. Verify
claude mcp list                          # should show "abmind: ... ✓ Connected"
cat ~/.claude/settings.json | jq .hooks  # should list 3 events
```

No global enable flag to toggle — hooks run whenever a matching event fires.

### What the extension provides

**Hooks** (`settings.json` → `hooks` key) — Claude Code's native event names:

| Event | Command | Purpose |
|---|---|---|
| `SessionStart` | `abmind hook-wakeup` | Inject wake-up context on session open |
| `UserPromptSubmit` | `abmind hook-recall` | Recall + inject `[abmind memory context]` before every user turn |
| `Stop` | `abmind hook-store` | Record user prompt + model response after each turn |

Stdout from hooks is injected directly into the model's context on exit 0 — no JSON envelope required. The `grep -vE '^\[(env|memory-db|memory-manager|ollama-)'` filter strips abmind's bootstrap log lines until #364 is fixed in `mem-logger.ts`.

**MCP server** — registered via `claude mcp add abmind abmind mcp` (stored in `~/.claude.json`, not in `settings.json`). Exposes `memory_recall`, `memory_store`, `memory_edit`, `memory_status`, `memory_wakeup` as tools the model can call mid-turn (e.g. to search at higher classification, or do entity-filtered lookups).

**Context file** (`CLAUDE.md`) — auto-loaded into every session. Explains the automatic hook behavior, the ground-truth rule (`[abmind memory context]` is authoritative, never confabulate over it), translation rules, when to call MCP tools directly, storage conventions, and consolidation.

### Scope control

Claude Code has several ways to scope or disable abmind integration:

```bash
# Hard kill-switch per invocation (exit 0 immediately, no DB touched)
ABMIND_HOOKS_DISABLED=true claude -p "..."

# Skip all hooks, auto-memory, CLAUDE.md, plugins, etc. — bare mode
claude --bare -p "..."

# Remove the MCP server only (keeps hooks and CLAUDE.md)
claude mcp remove abmind
```

To disable just one event, edit `~/.claude/settings.json` and remove that key from `hooks`.

### Differences vs Gemini Pattern

| Aspect | Gemini | Claude Code |
|---|---|---|
| Event names in hooks config | `SessionStart`, `BeforeAgent`, `AfterAgent` | `SessionStart`, `UserPromptSubmit`, `Stop` |
| Kiro-style names accepted in config? | No — only at runtime input | **Yes** — same names natively |
| `Stop` / `AfterAgent` field for model reply | `prompt_response` (jq shim needed) | `assistant_response` (matches abmind directly) |
| Structured `additionalContext` JSON required? | **Yes** — `hookSpecificOutput.additionalContext` | **No** — stdout injected directly |
| Global hook enable flag | `tools.enableHooks` in `~/.gemini/settings.json` | None — hooks always run if configured |
| Records on Ctrl+C / crash | No | No (same gap) |
| Per-session scope flag | `-e <extension>` | `--bare` (disables all) |

Same SECRET-tier guarantee: `UserPromptSubmit` hook is hardcoded to `maxClassification=2`. Credentials surface only via explicit MCP tool call or direct CLI.

### Environment variables

All `ABMIND_HOOK*` vars apply unchanged (same binaries as Kiro Pattern B and gemini-cli).

---

## Sleep / Memory Maintenance (#1353 host-neutral contract)

abmind's sleep cycle runs a fixed 12+ step recipe (noise cleanup, daily
summary, memory extraction, retrospective, consolidation, etc.) against a
host-injected model runtime. abmind owns the recipe, ordering, checkpoints,
resume/catch-up, budget, and the final domain result. Your host owns
scheduling, model transport, and delivery.

### Ownership split

| Concern | Owner |
|---|---|
| When a run starts (cron, manual command, etc.) | Host |
| Model/provider choice, credentials, transport, provider retry/fallback | Host |
| Agent/session allocation and teardown | Host |
| Cancellation on host shutdown | Host |
| Delivery of results to a user/UI | Host |
| Step ordering, shared variables between steps | abmind |
| Essential-step / continuation rules | abmind |
| LLM-call budget accounting | abmind |
| Durable checkpoints, resume, catch-up, watermark | abmind |
| Classifying the final terminal status | abmind |

### Minimal host adapter

```ts
import { runSleepCycle } from "abmind";
import type { SleepRuntime, SleepCompletionRequest, SleepEvent } from "abmind";

// Your runtime: one method, reject on transport failure (after YOUR OWN
// retry/fallback policy — abmind does not retry a rejection itself).
const runtime: SleepRuntime = {
  async complete(request: SleepCompletionRequest): Promise<string> {
    const response = await yourLlmClient.complete({
      prompt: request.prompt,
      signal: request.signal, // combined caller-cancel + wall-clock timeout
    });
    return response.text;
  },
};

const controller = new AbortController();
// e.g. controller.abort() on host shutdown

const result = await runSleepCycle({
  runtime,
  mode: "scheduled",       // "scheduled" | "manual" | "resume"
  signal: controller.signal,
  onEvent: (event: SleepEvent) => {
    // Best-effort — a throwing observer never affects the run.
    if (event.type === "step_started") console.log(`→ ${event.stepId}`);
    if (event.type === "cycle_finished") console.log(event.result.report);
  },
});

// result.status is one of:
//   completed | no_work | partial | failed | cancelled | already_running
console.log(result.status, result.report);
```

A concurrent call against the same abmind home (from another process, or a
second in-process call before the first returns) returns
`status: "already_running"` rather than starting a second run. A rejected
`runtime.complete()` call surfaces immediately as a step failure — it is not
retried by abmind. See `cli/abmind-sleep.ts` in the abmind repo for a full
reference adapter (CLI flag translation, event rendering, exit-code mapping).



All config via environment variables or `~/.abmind/config/.env.memory`:

| Variable | Default | Description |
|----------|---------|-------------|
| `ABMIND_HOME` | `~/.abmind` | Root data directory |
| `MEMORY_ENABLED` | `true` | Kill switch |
| `MEMORY_MAX_MESSAGES_PER_CHAT` | `1000` | Message retention per chat |
| `MEMORY_DISK_BUDGET_MB` | `500` | Max DB size before pressure-based aging |
| `MEMORY_EMBEDDING_MODEL` | `nomic-embed-text` | Ollama model for embeddings |
| `MEMORY_SEARCH_TIMEOUT_MS` | `1000` | Per-stage search timeout |
| `MEMORY_MMR_LAMBDA` | `0.7` | Diversity vs relevance tradeoff |
| `MEMORY_COMPACT_THRESHOLD_PCT` | `85` | Context window compaction trigger |

---

## Host Integration Lifecycle (#1341)

abmind provides a provider-neutral application layer for integrating memory with
any agent host session. The `HostMemoryLifecycle` service wraps `MemoryManager`
with execution identity, automatic-write ownership, and structured results.

### Identity

Every lifecycle operation requires an `ExecutionIdentity`:

```ts
interface ExecutionIdentity {
  principalId: string;        // memory/security subject → message userId
  conversationId: string;     // durable host conversation → message sessionId
  executionId: string;        // one active run/attachment
  parentExecutionId?: string; // delegation/fork lineage (optional)
  host: string;               // adapter family (e.g. "pi", "abmind-cli-hooks")
  origin: string;             // why the execution exists (e.g. "interactive")
  automaticWriteOwner: string; // who may auto-capture turns
}
```

Validation trims whitespace and rejects empty or control-character-bearing
identifiers. Use `validateIdentity()` at the adapter boundary.

### Automatic-write ownership

The lifecycle enforces that only the declared automatic writer may record turns.
A `HostMemoryLifecycle` is constructed with a `writerId`. When
`completeTurn()` is called, if `identity.automaticWriteOwner !== writerId`,
the result is `{ status: "skipped", reason: "not_owner" }` and no write occurs.
Explicit `store()` is **not** suppressed by ownership — it is a deliberate
action and records `createdBy` provenance.

### Operations

| Method | Input | Purpose |
|--------|-------|---------|
| `startSession()` | `StartSessionInput` | Hydrate session context (wake-up with char cap) |
| `prepareTurn()` | `PrepareTurnInput` | Automatic recall before an agent turn |
| `completeTurn()` | `CompleteTurnInput` | Record user + assistant messages |
| `recall()` | `ExplicitRecallInput` | Explicit mid-turn recall (no ownership check) |
| `store()` | `ExplicitStoreInput` | Explicit mid-turn store (derives userId + provenance) |

All operations validate identity, return safe diagnostics on failure when
`failOpen: true` (default), and throw when `failOpen: false`.

### Example

```ts
import { MemoryManager, HostMemoryLifecycle } from "abmind";
import type { ExecutionIdentity } from "abmind";

const memory = new MemoryManager();
await memory.initialize();

const lifecycle = new HostMemoryLifecycle(memory, { writerId: "my-adapter" });

const identity: ExecutionIdentity = {
  principalId: "user-1",
  conversationId: "session-1",
  executionId: "run-1",
  host: "my-host",
  origin: "interactive",
  automaticWriteOwner: "my-adapter",
};

// Session start: inject wake-up context
const session = await lifecycle.startSession({ identity, maxChars: 4000 });
console.log(session.context);

// Before each turn: automatic recall
const recall = await lifecycle.prepareTurn({
  identity,
  prompt: "user query",
  query: { translated: ["user", "query"] },
  policy: { limit: 5, maxChars: 2000, maxClassification: 2 },
});

// After each turn: record messages
const record = lifecycle.completeTurn({
  identity,
  user: { content: "user query" },
  assistant: { content: "model response" },
});
```

### Adapter responsibilities

Host adapters (Pi, OpenClaw, Hermes, CLI hooks) translate native events and
identifiers before calling the lifecycle. They own:

- Parsing native payloads and constructing `ExecutionIdentity`.
- Host/language-specific query preparation (e.g. English token extraction).
- Rendering lifecycle results into the host's context injection format.
- Active context window and compaction — these remain host-owned.

The lifecycle does not inspect host environment variables, payload shapes, or
native identifiers. See `cli/hook-lifecycle-adapter.ts` for a reference
implementation that resolves identity from CLI environment variables.

### Out of scope

The lifecycle does not include:
- An event bus or plugin loader.
- UI abstraction or normalization of all host events.
- Ingesting or reproducing a host's active context window or tool stream.
- Scheduling sleep or deciding which process owns sleep maintenance.
- Database schema changes or persistent execution records.

**Where does data live?**
`~/.abmind/memory/memory.db` (SQLite). Consolidation files in `~/.abmind/memory/daily/`, `weekly/`, `quarterly/`.

**How do I back up?**
```bash
abmind backup              # creates encrypted .abm archive
abmind restore <file.abm>  # merge mode (dedup) by default
```

**How do I delete all data?**
```bash
rm -rf ~/.abmind/memory/    # nuclear option
# Or selectively:
abmind edit --id 42 --delete
```

**Do I need ollama?**
No. Without ollama, vector search (Se stage) is skipped — FTS5 + trigram + consolidation search still work. Run `abmind embed` when ollama becomes available to backfill.

**Can multiple processes access the same DB?**
Yes. SQLite WAL mode handles concurrent readers. For multi-process writes, use the IPC server (`MemoryIpcServer` listens on `~/.abtars/memory.sock`).

**How does sleep/maintenance work?**
Sleep is optional. Call `abmind sleep --level budget` on a schedule (cron, systemd timer) or let abtars trigger it automatically during quiet hours. Sleep extracts facts from conversations, consolidates daily→weekly→quarterly, runs contradiction checks (auto-invalidates old facts via `valid_to`), and prunes stale memories. PID guard prevents concurrent sleep execution.

**How does dedup work?**
Three layers: (1) exact-match within 60s, (2) cosine similarity ≥ 0.85 within 60s (catches paraphrases), (3) session store cap (safety net). Ollama down → graceful fallback to exact-match only.

**What happens to contradicted facts?**
Sleep step 15 detects contradictions (e.g. "moved to Berlin" vs "lives in Budapest"). The old memory gets `valid_to` set — it stays in the DB but is excluded from recall. Core memories (classification ≥ 3) are never auto-invalidated.
