# Recall

Recall turns a query into a bounded evidence packet: ordered excerpts with
source-safe references plus owner-rendered text. abmind owns the whole path —
planning, retrieval, selection, grounding and rendering — and no host applies
its own score floors, clipping or re-ranking. Recall uses no generative or
judgment model.

## Profiles

Every request selects exactly one profile:

| Profile | Used for | Breadth |
|---------|----------|---------|
| `recall_fast` | Automatic context before a turn (verbatim turn as the query) | Durable knowledge only; skips uninformative turns instead of guessing |
| `recall_normal` | Deliberate search (explicit text and/or keywords) | Durable knowledge plus topic episodes |
| `recall_full` | Broad deliberate search and continuation paging | Adds source-bound summaries, neighbor grounding and weaker evidence with explicit labels |

Each profile has fixed work/output ceilings. A caller's capacity request can
only narrow them.

## What recall serves

Recall reads a derived projection, not the raw tables:

- **Durable knowledge** and **topic episodes** from the personal store.
- **Raw evidence** (authorized, unsealed source excerpts) behind durable hits.
- **Summaries** (daily/weekly/quarterly consolidation files that name their
  owner) as a full-profile source.
- **Entity graph** edges bound to their source records.

The projection is built through the reviewed operator surface after a verified
backup, published behind a generation barrier, and maintained by the single
writer that commits each store, correction, sleep write and forget. A forget
barrier blocks recall until cleanup completes; a restore invalidates the
projection instead of serving stale generations. Sealed content and foreign
owners never enter it.

## Stages

| Stage | Method | Notes |
|-------|--------|-------|
| Sf | Porter FTS plus trigram probes | Exact topical matches |
| Se | Embedding cosine similarity | Optional; skipped cleanly when embeddings are disabled |
| Ss | Locality-sensitive signature coverage | Deterministic, no provider needed |
| S6 | Consolidation summaries | Full profile only |
| S8 | Entity-graph neighbors | Bound to verified source records |

Stages run under per-profile work budgets with cancellation. A stage that is
attempted but fails or times out degrades the packet to `partial` with the
reason attached — it never fabricates an empty or complete result.

## Selection

Candidates from all stages are fused deterministically (reciprocal rank fusion,
`K=60`; a second contextual plan contributes at half weight), deduplicated, and
diversified with MMR (`λ=0.7`). Ranking then honors anchor coverage: hits that
match more of the query's informative terms win; memory prominence only breaks
ties. Required competitor/exception evidence reserves capacity instead of
being sorted out. Selected items are grounded from verified preserved
excerpts — never by quoting unreviewed message text.

## The packet

Recall returns the whole outcome, not just hits:

```json
{
  "status": "evidence",
  "items": [
    { "ref": { "kind": "db", "layer": "durable", "recordId": 12, "owner": "alice", "version": "..." },
      "excerpt": "...", "rationale": "...", "currentness": "current" }
  ],
  "text": "[1] (db:durable:12:alice:...) ...",
  "stageOutcomes": { "Sf": { "status": "completed", "hitCount": 4 } },
  "omissionReasons": []
}
```

- `status` is `evidence` | `partial` | `empty` | `skipped` | `unavailable` |
  `cancelled` and is honest about what happened.
- References are source-safe: owner, layer, record id and content version
  travel together; a numeric id alone never identifies evidence.
- `text` is the owner-rendered injection text. Deliver it verbatim.
- `caller`-visible capacity bounds (`maxItems`, `maxOutputBytes`, `deadlineMs`)
  are echoed in `effective`.

Long results can be paged: a `continuation` handle fetches the next page, and
later pages never repeat earlier references.

## CLI usage

```bash
# Deliberate search (normal profile): explicit anchor and/or keywords
abmind recall --profile recall_normal --text "sqlite fts5 performance"

# Broad search with a filter
abmind recall --profile recall_full --text "project deadline" --time-start 1700000000
```

`recall_fast` is the automatic-context profile and takes the verbatim turn
(`--raw-turn "<turn>"`). Every invocation prints the owner packet as JSON:
`status`, `items` with source-safe refs, and the owner-rendered `text` to
deliver verbatim.

## Configuration that still applies

| Variable | Default | Effect |
|----------|---------|--------|
| `EMBEDDING_ENABLED` | `false` | Runs the Se stage |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model used for the Se stage |
| `EMBEDDING_SIMILARITY_THRESHOLD` | `0.5` | Minimum cosine admission for Se candidates |

The `RECALL_DECAY_*` and `RECALL_EMOTION_BOOST` knobs affect only the legacy
`search()` surface (dashboard), not the owned recall packet.

## Example

Query: "what database does the project use?"

```
Sf: 4 hits (12ms) — Porter/trigram matches on "database", "project"
Se: 2 hits (45ms) — cosine similarity to the query embedding
Ss: 3 hits (1ms)  — signature coverage
S6: 1 hit  (3ms)  — weekly summary mentions "migrated to SQLite" (full profile)
S8: 0 hits (1ms)  — no entity match

→ fusion + MMR → top items returned as the packet above
```
