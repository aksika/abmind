# Memory System

## How It Works

abmind records every conversation turn. A background "sleep" cycle processes raw messages into structured knowledge:

1. **Record** — every user message and assistant response is stored with timestamps
2. **Extract** — facts, preferences, entities are pulled from conversations
3. **Consolidate** — daily → weekly → quarterly summaries compress old knowledge
4. **Recall** — on each new message, relevant memories are retrieved and injected into context

## Search Modes

| Mode | How it works | Requirements |
|------|-------------|--------------|
| `hybrid` | FTS5 + trigram + vector embeddings | ollama with embedding model |
| `fts` | Full-text search + trigram matching | No external deps |
| `signature` | Keyword signature matching | No external deps |

Set via `MEMORY_MODE` in `~/.abmind/config/.env.memory`.

## Memory Types

- **Facts** — extracted statements ("user lives in Budapest")
- **Preferences** — likes/dislikes ("prefers dark mode")
- **Entities** — people, places, projects mentioned
- **Opinions** — subjective views with confidence scores
- **Secrets** — encrypted at rest (class 3), retrieved only via tool call

## Configuration

Key settings in `~/.abmind/config/.env.memory`:

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_MODE` | `hybrid` | Search mode |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Embedding model |
| `OLLAMA_EMBED_URL` | `http://localhost:11434` | Ollama endpoint |
| `BED_TIME` | `02:00` | Sleep cycle start time |
| `WAKE_TIME` | `07:00` | Sleep cycle end time |
| `SLEEP_QUALITY` | `normal` | Sleep depth: budget/normal/ultimate |
| `MEMORY_MAX_DB_SIZE_MB` | `500` | Triggers aging acceleration |

## Multi-user

Each user gets isolated memory. Configure in `~/.abmind/config/users.json`:

```json
{
  "users": [
    { "userId": "master", "role": "master", "maxClass": 3, "tools": ["all"] },
    { "userId": "guest-123", "role": "guest", "maxClass": 0, "tools": [] }
  ]
}
```

Roles: `master` (full access), `user` (read/write, no secrets), `guest` (read-only, no memory recording).
