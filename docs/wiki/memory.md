# Memory System

## Lifecycle

Every conversation turn flows through four stages:

1. **Record** — user and assistant messages stored with timestamps, session IDs, platform message IDs
2. **Extract** — sleep cycle pulls structured facts, preferences, entities, decisions from raw transcripts
3. **Consolidate** — daily → weekly → quarterly summaries compress old knowledge into progressively denser files
4. **Recall** — on each new message, relevant memories are retrieved and injected into the agent's context

## Memory Types

| Type | Description | Example |
|------|-------------|---------|
| `fact` | Extracted statement | "user lives in Budapest" |
| `decision` | A choice made | "chose SQLite over Postgres for local-first" |
| `preference` | Like/dislike | "prefers dark mode" |
| `event` | Something that happened | "deployed v0.3.0 on 2026-04-15" |
| `lesson` | Learned insight | "never run filter-branch on live data" |
| `feedback` | Correction or reaction | "user said the summary was too long" |
| `story` | Narrative/anecdote | "the time the deploy broke at 3am" |
| `secret` | Encrypted at rest (class 3) | API keys, passwords |

## Search Modes

| Mode | Stages used | Requirements |
|------|-------------|--------------|
| `hybrid` | FTS5 + trigram + embeddings + consolidation | Ollama with embedding model |
| `fts` | FTS5 + trigram + consolidation | No external deps |
| `signature` | Keyword signature Hamming distance | No external deps |

Set via `MEMORY_SEARCH_MODE` env var. Default: `hybrid`.

## Recall Algorithm

See [recall.md](recall.md) for the full 4-layer pipeline, ranking formula, and tuning guide.

## ABM-L Compression Format

Memories are rendered in ABM-L (abmind Lightweight) format for context injection. ABM-L compresses English text + metadata into a compact single-line representation:

```
[FD|coding|satisf|4|2026-05] chose SQLite >over Postgres ∵ local-first (no network dep)
```

### Structure

```
[FLAGS|TOPIC|EMOTION|CONFIDENCE|DATE] compressed_content
```

| Field | Description |
|-------|-------------|
| FLAGS | Primary type flag + secondary importance flags (e.g. `FD` = fact + decision) |
| TOPIC | Inferred topic: `coding`, `personal`, `work`, `finance`, `health`, `projects`, `general` |
| EMOTION | First 6 chars of primary emotion tag |
| CONFIDENCE | 1-5 scale |
| DATE | `YYYY-MM` of creation |

### Type flags

`F`=fact, `D`=decision, `P`=preference, `E`=event, `L`=lesson, `K`=feedback, `S`=story

### Secondary flags (additive)

`O`=origin, `B`=core_belief, `V`=pivot, `T`=technical, `C`=correction, `M`=milestone

### Compression rules

- Filler words stripped (`basically`, `essentially`, `actually`, `really`, `just`, etc.)
- Abbreviations applied (`Telegram`→`TG`, `configuration`→`config`, `development`→`dev`)
- Relationships symbolized (`because`→`∵`, `leads to`→`→`, `instead of`→`>over`)
- Technical tokens preserved verbatim (paths, URLs, versions, backtick-quoted)
- Known entities get `@` references
- Lists pipe-separated (`foo | bar | baz`)

### Versions

| Version | Behavior |
|---------|----------|
| `plain` | No compression, raw `content_en` |
| `v0` | Basic filler removal |
| `v1` | Full compression (abbreviations, relationships, entities) |
| `v2` | v1 + vocabulary substitution tables |

Set via `ABML_VERSION` env var. Default: `plain`.

## Darwinism (Memory Fitness)

Memories compete for relevance. The system tracks usage patterns and adjusts visibility:

### Signals tracked

| Signal | Column | Effect |
|--------|--------|--------|
| Recall count | `recall_count` | Frequently recalled → boosted in ranking |
| Last recalled | `last_recalled_at` | Recent recall → higher recency factor |
| Relevance score | `relevance_score` | Manual or sleep-assigned importance boost |
| Confidence | `confidence` | 1-5 scale, affects trust factor in scoring |
| Recall timestamps | `recall_timestamps` | JSON array of last 20 recall times (spacing effect) |

### Promote triggers

- Memory recalled ≥3 times in 30 days → relevance boost
- Spaced recalls (intervals ≥7 days apart) → 1.3× multiplier
- Sleep cycle identifies memory as "core" → tier promotion to `core`
- User explicitly edits/confirms → confidence boost

### Demote triggers

- Never recalled after 90 days → candidate for expiry (`valid_to` set)
- Contradicted by newer memory → confidence reduced
- Sleep cycle flags as stale/redundant → marked for consolidation or removal

### Sleep-apply command

```bash
abmind sleep-apply --promote    # promote high-fitness memories
abmind sleep-apply --demote     # demote low-fitness memories
abmind sleep-apply --dry-run    # preview without changes
```

## Multi-user Isolation

Each user gets isolated memory. Configure in `~/.abmind/config/users.json`:

```json
{
  "users": [
    { "userId": "master", "role": "master", "maxClass": 3, "tools": ["all"] },
    { "userId": "guest-123", "role": "guest", "maxClass": 0, "tools": [] }
  ]
}
```

| Role | Capabilities |
|------|-------------|
| `master` | Full access, all classifications, all tools |
| `user` | Read/write, no secrets (class 0-2), limited tools |
| `guest` | Read-only, class 0 only, no memory recording |

See [classification.md](classification.md) for the NATO Admiralty Codes system.

## Consolidation Tiers

| Tier | Frequency | Content |
|------|-----------|---------|
| Daily | Every sleep cycle | Summary of that day's conversations |
| Weekly | Every 7 days | Compressed weekly themes |
| Quarterly | Every 90 days | High-level patterns and persistent facts |

Consolidation files live in `~/.abmind/memory/consolidation/{daily,weekly,quarterly}/`. They're searched by the S6 stage during recall (keyword match against `.md` file contents).

## Entity Graph

The system maintains a relationship graph between entities mentioned in memories:

```
alice —[works_with]→ bob
project_x —[uses]→ sqlite
```

Queried during recall (S8 stage) when a known entity appears in the search query. Edges store `last_seen_at` timestamps and respect classification access control.
