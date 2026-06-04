# Configuration

All configuration is via environment variables. Set them in `~/.abmind/config/.env.memory` or export them before running abmind commands.

## Paths

| Variable | Default | Description |
|----------|---------|-------------|
| `ABMIND_HOME` | `~/.abmind` | Root directory for all abmind data |
| `MEMORY_DIR` | `$ABMIND_HOME/memory` | Directory containing memory.db and consolidation files |
| `ABMIND_KEY_FILE` | `$ABMIND_HOME/secret/abmind.key` | Encryption key for class-3 secrets |

## Memory

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_SEARCH_MODE` | `hybrid` | Search mode: `hybrid`, `fts`, `signature` |
| `MEMORY_MAX_DB_SIZE_MB` | `4096` | DB size threshold — triggers aging acceleration warning |
| `MEMORY_ORIGINAL_TTL_DAYS` | `90` | Days before original-language content expires |
| `MEMORY_ENGLISH_TTL_DAYS` | `14` | Days before English translation expires (if original preserved) |
| `MEMORY_AGING_ENABLED` | `true` | Enable/disable automatic memory aging |
| `MEMORY_IPC` | `1` | Enable IPC notifications between processes (set `0` to disable) |
| `MEMORY_BACKEND` | `sqlite` | Storage backend (only `sqlite` currently supported) |

## Embeddings

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_ENABLED` | `false` | Enable vector embeddings (requires Ollama or OpenAI) |
| `EMBEDDING_PROVIDER` | `ollama` | Provider: `ollama` or `openai` |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Model name for embedding generation |
| `EMBEDDING_URL` | `http://localhost:11434` | Ollama API endpoint |
| `EMBEDDING_API_KEY` | (empty) | API key (required for `openai` provider) |
| `EMBEDDING_DIMENSIONS` | `768` | Vector dimensions (must match model output) |
| `EMBEDDING_SIMILARITY_THRESHOLD` | `0.5` | Minimum cosine similarity for Se stage results (0.0–1.0) |

## Recall tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `RECALL_DECAY_DAYS` | `365` | Days until recency factor reaches floor |
| `RECALL_DECAY_FLOOR` | `0.3` | Minimum recency multiplier (0.0–1.0) |
| `RECALL_EMOTION_BOOST` | `0.1` | Emotion score multiplier for recency boost |
| `SIGNATURE_BITS` | `256` | Bit width for locality-sensitive hash signatures |
| `RECALL_CONTEXT_HOUR_BOOST` | `0.02` | Score boost for same time-of-day bucket |
| `RECALL_CONTEXT_DOW_BOOST` | `0.015` | Score boost for same day-of-week |
| `RECALL_CONTEXT_TOPIC_BOOST` | `0.03` | Score boost for matching conversation topic |

## ABM-L compression

| Variable | Default | Description |
|----------|---------|-------------|
| `ABML_VERSION` | `plain` | Compression version: `plain`, `v0`, `v1`, `v2` |
| `ABML_MIN_CHARS` | `100` | Minimum content length to apply compression |

## Context tiers (#348)

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXT_TIER_ENABLED` | `true` | Enable three-tier context assembly |
| `CONTEXT_TIER_TAIL` | `20` | Number of recent messages in tail tier |
| `CONTEXT_TIER_MIDDLE` | `50` | Number of messages in middle tier |
| `COMPACTION_LLM_ENABLED` | `false` | Use LLM for context compaction (expensive) |

## Sleep cycle

| Variable | Default | Description |
|----------|---------|-------------|
| `SLEEP_QUALITY` | (unset) | Sleep depth: `basic`, `budget`, `normal`, `ultimate` |
| `SLEEP_TIMEOUT_MIN` | `55` | Wall-clock timeout in minutes |
| `SLEEP_MAX_LLM_CALLS` | `18` | Maximum LLM calls per sleep cycle (hard cap: 50) |
| `SLEEP_CURATION_DAY` | `sunday` | Day of week for weekly curation tasks |
| `SLEEP_MODEL_NAME` | `unknown` | Model identifier for audit logging |
| `AGENT_SLEEP_CTX_WINDOW` | `128000` | Context window size for sleep LLM calls |

## Security

| Variable | Default | Description |
|----------|---------|-------------|
| `ABTARS_PASS` | (unset) | Passphrase for secret encryption/decryption |
| `ABMIND_USER` | (unset) | Current user identity for multi-user isolation |

## File locations

```
~/.abmind/
├── config/
│   ├── .env.memory          ← env vars go here
│   └── users.json           ← multi-user config
├── memory/
│   ├── memory.db            ← SQLite database
│   ├── consolidation/
│   │   ├── daily/
│   │   ├── weekly/
│   │   └── quarterly/
│   ├── working/             ← daily transcript scratch
│   ├── sleep/               ← sleep audit logs
│   ├── core/                ← core identity templates
│   └── todo.md              ← persistent todo list
├── secret/
│   └── abmind.key           ← encryption key (chmod 600)
├── backups/                  ← encrypted backups
└── topics/                   ← topic knowledge files
```

## Overriding for development

For testing or development, override paths:

```bash
export ABMIND_HOME=/tmp/abmind-test
export MEMORY_DIR=/tmp/abmind-test/memory
abmind install    # creates structure in /tmp
```

All env vars are parsed once at startup via `getAbmindEnv()`. Changes require process restart.
