# abmind

[![npm](https://img.shields.io/npm/v/abmind)](https://www.npmjs.com/package/abmind) [![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE) [![Node](https://img.shields.io/badge/node-22%2B-green)]()

Persistent memory system for AI agents — store, recall, consolidate, and forget.

**Built for multilingual agents that run 24/7 — not a vector DB wrapper.** SQLite-backed, 4-layer recall (FTS5 + trigram + embeddings + consolidated summaries), overnight sleep maintenance, injection detection, context orchestration, and a classification system inspired by NATO Admiralty Codes.

**Version:** 0.2.7 | **Docs:** [Wiki](https://aksika.github.io/abmind) | **License:** Apache 2.0

## Install

See the [installation guide](https://aksika.github.io/abmind) for setup instructions, prerequisites, and configuration.

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

### Agglutinating Language Support

Most memory systems tokenize on word boundaries — catastrophic for Japanese, Turkish, Hungarian, and other languages where a single word carries dense meaning. Japanese has no spaces ("食べさせられなかった" = "was not able to be made to eat"), Turkish compounds freely ("yapabildiklerimizdenmişsinizcesine" = "as if you were among those we could do"), Hungarian packs sentences into one word ("megcsináltattam" = "I had it done by someone"). abmind uses **trigram fuzzy search** alongside FTS5, so recall works regardless of morphology, word boundaries, or compounding. Store in any language, recall in any language.

### Credential Vault

When your agent receives a secret (API key, token, password):
1. Encrypts it at rest (AES-256-GCM) as a SECRET memory (class 3)
2. Immediately redacts the raw credential from conversation history
3. Only the owner can retrieve it (classification-gated recall)
4. Backups and exports never contain raw credentials

Your agent remembers secrets without leaking them.

### Multi-Resolution Context

Context assembly at three zoom levels — 3× more coverage in the same token budget:
- **Recent** — full verbatim conversation (last N turns)
- **Session** — compressed per-turn atoms (ABM-L format, 3× token reduction)
- **Long-term** — thematic summaries + recalled memories from weeks/months ago

The agent remembers last week's decisions AND this morning's details.

### Sleep Maintenance (Dreamy)

Nightly background process that curates memory like human sleep:
- Extracts facts, decisions, preferences from the day's conversations
- Consolidates daily → weekly → quarterly summaries
- Detects contradictions ("you said X last week but Y today")
- Prunes stale memories (Memory Darwinism — unused memories fade)
- Promotes frequently-recalled memories, demotes stale ones
- 10-14 LLM calls per cycle, fully autonomous

### Recall (4 layers, ranked)

- **FTS5** — full-text search on English and original content
- **Trigram** — fuzzy matching for typos, partial words, agglutinating morphology
- **Embeddings** — semantic similarity via Ollama or any OpenAI-compatible endpoint
- **Consolidated summaries** — weekly/quarterly rollups searchable as memories

Results ranked by relevance across all layers. No single layer is a bottleneck.

### Classification (NATO Admiralty Codes)

- **Classification** — 0 (public) → 1 (internal) → 2 (confidential) → 3 (secret/encrypted)
- **Trust / Integrity / Credibility** — per-memory quality scores
- **Access control** — recall filters by user clearance level automatically
- **Multi-user isolation** — each user's memories scoped, no cross-user leakage

### Injection Detection

- 14 detection categories (prompt injection, jailbreak, role hijack, etc.)
- Blocks malicious input before it enters the memory store
- Configurable sensitivity per category

### Works Everywhere

Not locked to one CLI or framework:

| Path | Use for |
|---|---|
| **abTARS** | In-process memory for the autonomous bridge |
| **Hermes Agent** | Plugin-compatible memory backend |
| **OpenClaw** | Native memory slot replacement |
| **Library** (`import { MemoryManager } from "abmind"`) | Any Node.js agent |
| **MCP server** (`abmind mcp`) | Editors + hosts with MCP support |
| **CLI** (`abmind store/recall/...`) | Shell scripts, automation |
| **Agent hooks** | Kiro CLI, Claude Code, Gemini CLI, Codex |

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
