# Clarification Questions

Review today's new durable knowledge against existing eligible durables.
Conflicting durable claims coexist unresolved by design (#1930) — this step
never invalidates, edits, or links anything, and this turn has no
store/edit/CLI tools. Its only output is clarification questions for material
conflicts you cannot resolve.

## Today's new durable knowledge (settled this run)

${NEW_EXTRACTIONS}

## Existing durables with overlapping content (for comparison)

${CONTRADICTION_CANDIDATES}

---

## Task: Clarification Questions

For a NEW durable and an EXISTING durable that are in MATERIAL conflict — one fact makes the other false — but you CANNOT decide which fact is true, you may ask the user one clarification question about those two facts.

Only ask when:
- The conflict is real and material (affects facts about the user or their world).
- Neither fact is obviously newer, more specific, or better evidenced.
- You genuinely cannot resolve it (never pick one on a guess).

For each question, output exactly:
```
ASK old_id=<id of the EXISTING durable> new_id=<id of the NEW durable> question=<JSON string>
```

The `question` must be a single JSON-encoded string (quoted, with inner quotes escaped): one short direct user-facing sentence (20-300 characters) ending in `?`, addressed to the user, about ONLY those two facts. Do NOT include memory ids, internal details, or anything that reads like system output.

Emit at most three `ASK` lines. If you have no question: output `NO_QUESTIONS`
