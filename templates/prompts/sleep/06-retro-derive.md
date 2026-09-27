# Post-Retro Derivation — Knowledge Elevation

Two-stage knowledge funnel: promote memories to core tier, then crystallize the best into knowledge files. This turn is PROPOSAL-ONLY: no store/edit/CLI or file-write tools exist. Read the bounded knowledge snapshot below (it is the current file content, with its version) and emit proposals; abmind validates each against the shown candidates and file versions and applies only accepted proposals.

## Input

${RETRO_CONTENT}

If the retrospective input above is marked ABSENT, skip Task 2 derivation,
report the skip visibly, and continue with Task 1 promotions.

## Task 1: Promote to Core Memory

Promotion candidates (high relevance, frequently recalled):
${PROMOTION_CANDIDATES}

${CONTRADICTION_WARNINGS}

For each worthy candidate — enduring facts, strong preferences, or critical context:
```
PROMOTE id=<shown candidate id> reason="<one sentence>"
```

Constraints:
- Budget: 100 core entries max. Do not exceed; proposals beyond capacity are rejected.
- Do NOT promote transient or time-bound information.
- If a contradiction warning links a newer candidate to an older memory, invalidate the older one first:
```
RETRO_INVALIDATE old_id=<older id from the warning> new_id=<newer id from the warning> reason="<one sentence>"
```

If no candidates or none worthy, say "No promotions" and continue.

## Task 2: Crystallize to Core Knowledge

**SOUL.md is read-only** — never modify it. Identity is human-managed.

${KNOWLEDGE_AVAILABILITY}

## Current knowledge snapshot (edit exactly what is shown)

${KNOWLEDGE_SNAPSHOT}

Emit one proposal per change. Every proposal must carry the file's `base=`
version shown above; a stale base, a missing file, or a duplicate/ambiguous
match is rejected and reported.

Append a new entry:
```
KNOWLEDGE_ADD file=<agent_notes.md|user_profile.md|core_facts.md> base=<12-char version shown> provenance="<retro date / source memory id>" 
<new entry text, one entry>
END_KNOWLEDGE
```

Replace one entry (match must occur in exactly one entry):
```
KNOWLEDGE_UPDATE file=<name> base=<version> match="<existing text>" provenance="<source>"
<replacement entry>
END_KNOWLEDGE
```

Remove one entry:
```
KNOWLEDGE_REMOVE file=<name> base=<version> match="<existing text>" provenance="<source>"
```

Rules:
1. Remove entries that are outdated or contradicted by today's retro.
2. Update entries that have become stale based on recent interactions.
3. From the retro + newly promoted core memories, identify NEW persistent rules or lessons not already present.
4. Append only genuinely new items (same meaning = duplicate, skip it).
5. `agent_notes.md` has an 8 KiB hard cap: a proposal whose result exceeds it
   is rejected and reported. Keep the file concise — replace or remove before
   growing it.

Report what was changed (if anything). If nothing is worth changing, say "No knowledge changes."