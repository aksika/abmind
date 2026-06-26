# Embeddings

Embeddings give abmind semantic search — finding memories by meaning, not just keywords. Without them, recall relies on FTS5 (keyword stems) and trigram (substrings). With them, a query like "that time we discussed architecture" finds memories about "system design decisions" even when no words match.

## How it works

Each memory gets a 768-dimensional vector from `nomic-embed-text` (via ollama). At recall time, the query is embedded and compared against all memory vectors using cosine similarity. The top matches feed into the Se stage of the [recall pipeline](recall.md).

```
Store: "Switched from Auth0 to Clerk for better DX"
  → ollama embeds → 768-dim float32 vector → saved to extracted_memories.embedding

Recall: "What auth provider are we using?"
  → ollama embeds query → cosine similarity against all vectors → top matches returned
```

## Requirements

- **ollama** running locally (default `http://localhost:11434`)
- **nomic-embed-text** model pulled (`ollama pull nomic-embed-text`)
- **EMBEDDING_ENABLED=true** in config

All three are set up automatically by `abmind install` when ollama is detected. If ollama wasn't available during install, see [Enabling later](#enabling-later).

## Performance characteristics

| Metric | Value |
|--------|-------|
| Embedding time | ~30ms per memory (CPU) |
| Vector size | 3KB per memory (float32), 768B after quantization (int8) |
| Search time | <10ms for 1000 memories (brute-force) |
| Search time (sqlite-vec) | <1ms for 10K+ memories (HNSW index) |

Embeddings are fully local — no data leaves your machine.

## Storage

Vectors are stored inline in the `extracted_memories.embedding` BLOB column. Two formats coexist:

| Format | Size | When |
|--------|------|------|
| float32 | 768 × 4 = 3072 bytes | First 14 days (full precision) |
| int8 | 768 bytes | After 14 days (quantized, saves 75% space) |

Quantization runs automatically during sleep maintenance. `cosineSimInt8()` handles similarity on quantized vectors without decompression.

## sqlite-vec (optional HNSW index)

For collections above ~5000 memories, brute-force cosine scan becomes noticeable. `sqlite-vec` provides an O(log n) HNSW vector index:

```bash
cd ~/.abmind/lib && npm install sqlite-vec
```

abmind detects it at startup and uses it automatically. Without it, brute-force scan works fine for smaller collections. `abmind doctor` reports whether it's available.

## Lifecycle

| Event | What happens |
|-------|-------------|
| `abmind store` | Memory embedded immediately (fire-and-forget) |
| `abmind edit` (content change) | Embedding nulled → re-embedded on next batch |
| Sleep cycle | Batch embeds any memories with NULL embeddings |
| `abmind embed` | One-time backfill of all un-embedded memories |
| `abmind embed --reset` | Nulls all vectors, re-embeds everything (for model switch) |
| `abmind doctor --fix` | Same as `abmind embed` (when EMBEDDING_ENABLED=true) |

## Graceful degradation

Embeddings are optional. When disabled or unavailable:

- Se stage returns empty (skipped in recall pipeline)
- Sf (FTS5 + trigram) and Ss (binary signatures) still provide keyword and fuzzy search
- S6 (consolidation) and S8 (entity graph) are unaffected
- `abmind doctor` warns: recall quality is degraded

The system never crashes or errors due to missing embeddings — it just returns fewer semantic matches.

## Enabling later

If you skipped embeddings during install (ollama wasn't available):

```bash
# 1. Install ollama (https://ollama.com)
curl -fsSL https://ollama.com/install.sh | sh

# 2. Pull the embedding model
ollama pull nomic-embed-text

# 3. Re-run install (safe — preserves existing keys and data)
abmind install

# 4. Backfill existing memories
abmind embed
```

`abmind install` detects ollama, sets `EMBEDDING_ENABLED=true`, and configures everything. Existing memories are then embedded by `abmind embed` or the next `abmind doctor --fix`.

## Switching embedding models

If you change `EMBEDDING_MODEL` (e.g. from `nomic-embed-text` to a different model with different dimensions):

```bash
# Reset all vectors and re-embed with the new model
abmind embed --reset
```

This nulls all existing embeddings and re-computes them with the current model. Required because vectors from different models are incompatible (different dimensionality and semantic space).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_ENABLED` | `false` | Enable/disable the embedding system |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Ollama model for embedding |
| `EMBEDDING_URL` | `http://localhost:11434` | Ollama API endpoint |
| `EMBEDDING_SIMILARITY_THRESHOLD` | `0.5` | Minimum cosine similarity for Se results |
| `MEMORY_EMBEDDING_QUANTIZE_DAYS` | `14` | Days before float32 → int8 quantization |

Set these in `~/.abmind/config/.env.memory`.

## Diagnostics

```bash
# Check embedding health
abmind doctor

# See how many memories lack embeddings
abmind status

# Embed all missing memories
EMBEDDING_ENABLED=true abmind embed

# Verify ollama is reachable
curl -s http://localhost:11434/api/tags | python3 -c "import json,sys; [print(m['name']) for m in json.load(sys.stdin).get('models',[])]"
```
