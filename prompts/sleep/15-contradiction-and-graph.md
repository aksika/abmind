# Contradiction Check + Entity Graph Extraction

Review today's new memories against existing knowledge. Two tasks, same data.

## Today's new memories (extracted today)

${NEW_EXTRACTIONS}

## Existing memories with overlapping topics (for comparison)

${CONTRADICTION_CANDIDATES}

---

## Task 1: Contradictions

Do any NEW memories contradict EXISTING ones? A contradiction is when a new fact makes an old fact false (not just different — actually incompatible).

Examples of contradictions:
- NEW: "User prefers Sonnet" vs EXISTING: "User prefers Opus" → contradiction
- NEW: "Peter moved to Berlin" vs EXISTING: "Peter lives in Budapest" → contradiction

Examples of NOT contradictions:
- NEW: "Deployed v0.2" vs EXISTING: "Deployed v0.1" → not contradiction, just newer event
- NEW: "User likes dark mode" vs EXISTING: "User likes vim" → different facts, no conflict

Only flag clear, binary contradictions. Do NOT flag observations or speculative memories.

For each contradiction found, output:
```
CONTRADICT old_id=<id> reason="<one sentence>"
```

If no contradictions: output `NO_CONTRADICTIONS`

## Task 2: Entity Relationships

From TODAY'S NEW memories only, extract relationships between named entities (people, places, projects, tools).

For each relationship, output:
```
RELATION entity_a="<name>" entity_b="<name>" rel="<relationship_type>"
```

Relationship types: works_at, lives_in, friend_of, part_of, uses, manages, created, depends_on, member_of, located_in

Only extract relationships explicitly stated or strongly implied. Do not infer.
If no relationships found: output `NO_RELATIONS`
