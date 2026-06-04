# Recall Pipeline

The recall engine retrieves relevant memories for context injection. It runs a multi-stage pipeline, deduplicates, applies boosts, and reranks for diversity.

## Stages

| Stage | Name | Method | Data source | Skippable |
|-------|------|--------|-------------|-----------|
| Sf | Fuzzy search | FTS5 + trigram (3 queries) | `extracted_memories` table | No |
| Se | Embedding | Cosine similarity (ollama) | `extracted_memories.embedding` | Yes (if Sf fills limit) |
| Ss | Signature | Hamming distance | `extracted_memories.signature` | Yes (if Sf fills limit) |
| S6 | Consolidation | Keyword match | `.md` files in consolidation dirs | No (always runs) |
| S8 | Entity graph | Relationship lookup | `entity_edges` table | No (always runs) |

### Priority and short-circuit

Stages run in order: **Sf → Se → Ss → S6 → S8**.

If Sf returns ≥ `limit` results, Se and Ss are skipped (short-circuit). S6 and S8 always run because they search different data sources (consolidation files and entity relationships).

Se is fired asynchronously at the start (embedding computation overlaps with Sf). If Sf fills the limit, the embedding promise is discarded without awaiting.

## Stage Details

### Sf: Three-query fuzzy search

Runs three sub-queries in sequence, deduplicating by memory ID:

1. **Porter FTS5** on `content_en` — stemmed keyword match via the `extracted_memories_fts` virtual table
2. **Trigram** on `content_en` + `preserved_keyword` — fuzzy/typo/substring matching with diacritics stripped
3. **Trigram** on `content_original` — fallback for non-English content (only if results < limit after steps 1-2)

Each sub-query applies filters: `userId`, `maxClassification`, `timeStart`/`timeEnd`, `topic`, `tier`, `includeExpired`.

Scoring formula for FTS hits:

```
score = (bm25_score + emotion_boost) × (1 + recall_boost) × (1 + relevance_boost)
        × trust_factor × credibility_factor × tier_boost × recency_factor
```

Where:
- `emotion_boost` = 0.5 × log(1 + |emotion_score|)
- `recall_boost` = 0.1 × recall_count
- `relevance_boost` = 0.2 if relevance_score > 0
- `trust_factor` = 0.5 + 0.5 × (trust / 3)
- `credibility_factor` = 1.25 if credibility ≤ 2, else 1.0
- `tier_boost` = 1.3 if tier = "core", else 1.0
- `recency_factor` = max(RECALL_DECAY_FLOOR, 1 - age_days/RECALL_DECAY_DAYS) × (1 + |emotion_score| × RECALL_EMOTION_BOOST)

### Se: Embedding cosine similarity

Requires `EMBEDDING_ENABLED=true` and a running Ollama instance (or OpenAI API).

1. Embeds the query text into a vector
2. Searches all embeddings via cosine similarity
3. Filters by `userId`, `maxClassification`, threshold (`EMBEDDING_SIMILARITY_THRESHOLD`)
4. Returns up to `limit × 3` candidates (over-fetches for MMR diversity)

Score = raw cosine similarity (0.0–1.0).

### Ss: Signature Hamming distance

Uses locality-sensitive hashing (bit signatures) for approximate semantic matching without embeddings.

1. Generates a bit signature from the query text
2. Compares against stored signatures via Hamming similarity
3. Threshold: 0.65 minimum similarity
4. Cap: 5 results maximum

No external dependencies. Useful as a fallback when embeddings are unavailable.

### S6: Consolidation file search

Searches `.md` files in `~/.abmind/memory/consolidation/{daily,weekly,quarterly}/`:

1. Scans files matching the time range (if specified)
2. Keyword matches against file contents
3. Returns matching paragraphs with a fixed score of 0.5
4. Deduplicates by content hash

### S8: Entity graph

Extracts words from the query, checks if any are known entities, and returns relationship edges:

```
alice —[works_with]→ bob (score: 0.6)
```

Only triggers if a query word matches a known entity in the graph. Returns one entity's edges (first match).

## Post-processing

After all stages produce candidates, the engine applies:

### 1. Cross-stage penalty (#505)

Sf-only hits not confirmed by Se get a 0.5× score penalty (likely false positives when embeddings are available).

### 2. Context boost

If `currentContext` is provided (hour, dayOfWeek, topic):

| Signal | Boost | Condition |
|--------|-------|-----------|
| Hour bucket match | +0.02 | Memory created in same time-of-day bucket (morning/afternoon/evening/night) |
| Day-of-week match | +0.015 | Same weekday; half boost for same weekend/weekday category |
| Topic match | +0.03 | Memory topic matches current conversation topic |

### 3. Emotion boost

Tie-breaker for emotionally charged memories:

```
boost = |emotion_score| × 0.02    (max +0.10 at |e|=5)
```

Intentionally small — enough to break ties, not enough to override relevance gaps.

### 4. Spacing boost (#244)

Memories recalled at spaced intervals (like spaced repetition) get multiplied:

| Average interval | Multiplier |
|-----------------|------------|
| ≥ 7 days | 1.3× |
| ≥ 1 day | 1.15× |
| < 1 day | 1.0× (no boost) |

Based on the last 20 recall timestamps stored per memory.

### 5. MMR reranking

Maximal Marginal Relevance with λ=0.7 (70% relevance, 30% diversity):

1. Pick highest-scoring result first
2. For each remaining candidate, compute: `MMR = λ × score - (1-λ) × max_similarity_to_selected`
3. Pick the candidate with highest MMR
4. Repeat until all candidates are ordered

Similarity = Jaccard coefficient on lowercased word tokens.

### 6. Enrichment

Final results are enriched with:
- **Timeline context** — if memories share a topic, shows temporal progression
- **Interference warnings** — flags conflicting results ("⚠️ Conflicts with another result")
- **Metadata** — topic, emotion_tags, importance_flags, confidence, createdAt

## Deduplication

- Within stages: by memory ID (Set-based)
- S6: by content hash (first 80 chars + timestamp)
- Cross-stage: IDs seen in earlier stages are skipped in later stages

## Recall tracking

After results are returned, the engine updates each matched memory:
- `recall_count` incremented
- `last_recalled_at` set to now
- `recall_timestamps` array appended (capped at 20 entries)

Disable with `trackRecalls: false` (used in benchmarks).

## Configuration

| Env var | Default | Effect |
|---------|---------|--------|
| `MEMORY_SEARCH_MODE` | `hybrid` | Which stages are active |
| `EMBEDDING_ENABLED` | `false` | Enable Se stage |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Ollama model for embeddings |
| `EMBEDDING_SIMILARITY_THRESHOLD` | `0.5` | Minimum cosine similarity for Se |
| `RECALL_DECAY_DAYS` | `365` | Days until recency factor hits floor |
| `RECALL_DECAY_FLOOR` | `0.3` | Minimum recency multiplier |
| `RECALL_EMOTION_BOOST` | `0.1` | Emotion × this = recency emotion boost |
| `SIGNATURE_BITS` | `256` | Bit width for Ss signatures |

## CLI usage

```bash
# Search memories
abmind recall --translated "sqlite fts5 performance"

# With filters
abmind recall --translated "project deadline" --topic work --limit 5
```

## Examples

Query: "what database does the project use?"

```
Stage Sf: 4 hits (12ms) — FTS matches on "database", "project"
Stage Se: 2 hits (45ms) — cosine similarity to query embedding
Stage Ss: skipped (Sf filled limit)
Stage S6: 1 hit (3ms) — weekly consolidation mentions "migrated to SQLite"
Stage S8: 0 hits (1ms) — no entity match

→ 7 candidates → MMR rerank → top 5 returned
```
