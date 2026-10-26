# Memory Lifecycle

How memories evolve over time — what to expect as an operator.

## Storage

When the agent stores a memory, it's enriched automatically:
- Tagged with emotion (positive/negative/neutral)
- Flagged for importance if it's a decision, preference, or key fact
- Deduplicated against existing memories (near-duplicates merged, not stacked)

You don't control this — it happens transparently on every store.

## Strengthening

Memories get stronger when:
- **Recalled** — every time a memory surfaces in conversation, its recall count increases
- **Confirmed** — if the user repeats or validates a fact, credibility rises
- **Emotionally significant** — strong emotions at storage time give a lasting boost

## Fading

Memories weaken over time if unused:
- Facts and preferences fade slowly (months)
- Events and observations fade faster (weeks)
- Emotional memories resist fading — strong feelings preserve recall priority

This is automatic. You'll notice the agent naturally forgets trivial old details while retaining important ones.

## Consolidation (during sleep)

The sleep cycle actively maintains memory:
- **Conflicts recorded, not resolved** — if new knowledge contradicts an old fact, both coexist with receipts; the owner resolves via `abmind personal --action correct`. Sleep never rewrites history.
- **Redundant knowledge compacted** — daily notes compress into weekly summaries, weekly into quarterly, on a once-per-period cadence
- **Core knowledge promoted** — repeatedly confirmed facts graduate to long-term core
- **Stale entries pruned** — memories with zero recalls and low importance eventually drop off

## What you control

| Action | Effect |
|--------|--------|
| `abmind store` | Add a memory manually |
| `SLEEP_QUALITY` env var | Controls how thorough nightly maintenance is |
| Classification level | Controls who can see a memory |

Everything else is autonomous — the system manages its own memory health.
