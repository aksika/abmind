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

The nightly sleep cycle actively maintains memory:
- **Contradictions resolved** — if a new fact conflicts with an old one, sleep picks the winner
- **Related memories merged** — redundant entries get consolidated into one richer memory
- **Core knowledge promoted** — repeatedly confirmed facts graduate to long-term core
- **Stale entries pruned** — memories with zero recalls and low importance eventually drop off

## Timelines

The system groups related memories into narrative arcs — sequences of events that tell a story over time. These appear in the agent's context as compressed timeline summaries, giving it a sense of "what happened over the past week" rather than isolated facts.

## What you control

| Action | Effect |
|--------|--------|
| `abmind store` | Add a memory manually |
| `abmind edit` | Modify an existing memory |
| `SLEEP_QUALITY` env var | Controls how thorough nightly maintenance is |
| Classification level | Controls who can see a memory |

Everything else is autonomous — the system manages its own memory health.
