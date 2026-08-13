# Contradiction Check + Entity Graph Extraction

Review today's new memories against existing knowledge. Three tasks, same data.

## Today's new memories (extracted today)

${NEW_EXTRACTIONS}

## Existing memories with overlapping topics (for comparison)

${CONTRADICTION_CANDIDATES}

---

## Task 1: Contradictions

Do any NEW memories contradict EXISTING ones? A contradiction is when a new fact makes an old fact false (not just different — actually incompatible).

Note: Obvious contradictions (explicit negation patterns like "no longer", "switched from", "actually") are already caught at store time and the old memory will have valid_to set. Focus on SUBTLE contradictions that keyword matching would miss — implicit conflicts, contextual incompatibilities, changed circumstances.

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

## Task 3: Clarification Questions

For a NEW memory and an EXISTING memory that are in MATERIAL conflict — one fact makes the other false — but you CANNOT decide which fact is true, you may ask the user one clarification question about those two facts.

Only ask when:
- The conflict is real and material (affects facts about the user or their world).
- Neither fact is obviously newer, more specific, or more credible.
- You genuinely cannot resolve it with `CONTRADICT` (never both invalidate, never pick one on a guess).

For each question, output exactly:
```
ASK old_id=<id of the EXISTING memory> new_id=<id of the NEW memory> question=<JSON string>
```

The `question` must be a single JSON-encoded string (quoted, with inner quotes escaped): one short direct user-facing sentence (20-300 characters) ending in `?`, addressed to the user, about ONLY those two facts. Do NOT include memory ids, internal details, or anything that reads like system output.

Emit at most three `ASK` lines. If you have no question: output `NO_QUESTIONS`
