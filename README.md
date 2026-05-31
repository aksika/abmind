# abmind

Persistent memory system for AI agents — store, recall, consolidate, and forget.

SQLite-backed, 4-layer recall (FTS5 + trigram + embeddings + consolidated summaries), overnight sleep maintenance, injection detection, context orchestration, and a classification system inspired by NATO Admiralty Codes.

**Version:** 0.1.4 | **Docs:** [Wiki](https://github.com/aksika/abmind/tree/dev/docs/wiki) | **License:** Apache 2.0

## Install

```bash
npm install abmind
abmind install
```

Requires Node 22+. Full guide: [Installation](https://github.com/aksika/abmind/blob/dev/docs/wiki/install.md)

## Library Usage

```ts
import { MemoryManager, loadMemoryConfig, recallSearch, buildWakeUp } from "abmind";

// Initialize
const config = loadMemoryConfig(); // reads ABMIND_HOME, defaults to ~/.abmind
const memory = new MemoryManager(config);

// Store a message
memory.recordMessage({
  role: "user",
  content: "I prefer dark mode and hate notifications",
  timestamp: Date.now(),
  userId: "alice",
  sessionId: "alice:telegram",
});

// Recall relevant memories
const results = await recallSearch(memory.getRecallDeps(), {
  translated: ["dark mode", "preferences"],
  userId: "alice",
  limit: 5,
});
console.log(results.memories); // ranked by relevance across all 4 layers

// Build wake-up context for a new session
const wakeUp = buildWakeUp(memory, "alice");
// → structured context: recent topics, key facts, emotional state, pending items
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         INGEST                                   │
│  message → recordMessage() → messages table → inline extraction │
│                                    ↓                            │
│                          extracted_memories                      │
│                     (typed, classified, scored)                  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                         RECALL                                   │
│  query → 4-layer search:                                        │
│    S1: FTS5 full-text (English)                                 │
│    S2: FTS5 full-text (original language)                       │
│    S3: trigram fuzzy match                                      │
│    S4: semantic embedding (cosine similarity)                   │
│  → ranked, deduplicated, classification-gated                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                     SLEEP (nightly maintenance)                   │
│  daily-summary → extraction → retrospective → topic-assignment  │
│  → darwinism (promote/demote/merge) → translation → emotion-arc │
│  → consolidation → garbage collection                           │
└─────────────────────────────────────────────────────────────────┘
```

## Features

### Memory Storage
- **Typed memories** — fact, preference, decision, experience, skill, relationship, goal
- **Bilingual** — stores original language + English translation side by side
- **Emotion tagging** — -5 to +5 per memory, emotion arcs tracked over time

### Recall (4 layers)
- **FTS5** — full-text search on English and original content
- **Trigram** — fuzzy matching for typos, partial words, transliteration
- **Embeddings** — semantic similarity via Ollama or any OpenAI-compatible endpoint
- **Consolidated summaries** — weekly/quarterly rollups searchable as memories

### Classification (CIA-AAA / Admiralty Codes)
- **Classification** — 0 (public) → 1 (internal) → 2 (confidential) → 3 (secret)
- **Trust / Integrity / Credibility** — per-memory quality scores
- **Access control** — recall filters by user clearance level automatically

### ABM-L (Agent Bridge Memory Language)
- Slot-based compression format for context-window efficiency
- 3× token reduction vs raw prose, preserving semantic atoms
- Render-only — stored data stays as clean prose, ABM-L is ephemeral

### Darwinism (Sleep Maintenance)
- **Promote** — frequently recalled memories gain confidence
- **Demote** — stale, contradicted, or low-quality memories decay
- **Merge** — duplicate/overlapping memories consolidated
- **Forget** — memories below threshold eventually pruned

### Injection Detection
- 14 detection categories (prompt injection, jailbreak, role hijack, etc.)
- Blocks malicious input before it enters the memory store
- Configurable sensitivity per category

## CLI

```bash
# Store and recall
abmind store --translated "User prefers dark mode" --memory-type preference --chat-id 0
abmind recall --translated "dark mode" --chat-id 0

# Sleep (overnight consolidation)
abmind sleep --level normal --force    # ~10-14 LLM calls, full pipeline
abmind sleep --level basic --force     # 1 LLM call, frontier model required

# MCP server (editor integration)
abmind mcp

# Utilities
abmind memory-stats
abmind wake-up
abmind edit --memory-id 42 --boost
```

### LLM Configuration for Sleep

Set `ABMIND_LLM_CMD` — must contain `{PROMPT_FILE}`:

```bash
export ABMIND_LLM_CMD='kiro-cli chat --no-tool-use < {PROMPT_FILE}'
# or: 'cat {PROMPT_FILE} | claude -p'
# or: 'cat {PROMPT_FILE} | gemini -p'
```

## MCP Server

```bash
abmind mcp     # starts stdio MCP server
```

Add to your host's MCP config:

```json
{ "mcpServers": { "abmind": { "command": "abmind", "args": ["mcp"] } } }
```

Works with kiro-cli, Claude Code, Codex CLI, Gemini CLI, Cursor, OpenCode, and any MCP-compatible host.

## Integration Paths

| Path | Use for |
|---|---|
| **Library** (`import { MemoryManager } from "abmind"`) | Node apps embedding memory directly |
| **MCP server** (`abmind mcp`) | Editors + hosts with MCP support |
| **CLI** (`abmind store/recall/...`) | Shell scripts, automation |
| **OpenClaw plugin** | Native OpenClaw memory slot replacement |
| **abtars** | In-process memory for the bridge runtime |

## Data Location

Default: `~/.abmind/`. Override via `ABMIND_HOME`.

```
~/.abmind/
├── memory/
│   ├── memory.db          # SQLite (messages, extracted memories, embeddings)
│   ├── daily/             # per-day narrative summaries
│   └── sleep/             # sleep audit logs
└── prompts/sleep/         # optional — override the 14 step prompts
```

## Contributing

```bash
git clone https://github.com/aksika/abmind.git
cd abmind && npm install && npm run build && npm test
```

Link for local development:

```bash
cd your-consumer && npm i file:../abmind
```

## License

Apache-2.0
