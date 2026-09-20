# Post-Retro Derivation — Knowledge Elevation

Two-stage knowledge funnel: promote memories to core tier, then crystallize the best into knowledge files.

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
abmind edit --memory-id N --tier core
```

Constraints:
- Budget: 100 core entries max. Do not exceed.
- Do NOT promote transient or time-bound information.
- If a contradiction is flagged: invalidate the older memory (`abmind edit --memory-id <older> --valid-to <today>`) before promoting the newer one.

If no candidates or none worthy, say "No promotions" and continue.

## Task 2: Crystallize to Core Knowledge

**SOUL.md is read-only** — never modify it. Identity is human-managed.

${KNOWLEDGE_AVAILABILITY}

1. Read `agent_notes.md` (`${AGENT_NOTES_PATH}`), `user_profile.md`
   (`${USER_PROFILE_PATH}`), and `core_facts.md` (`${CORE_FACTS_PATH}`) —
   exactly these absolute paths, no discovery, no alternate locations.
2. Remove entries that are outdated or contradicted by today's retro.
3. Update entries that have become stale based on recent interactions.
4. From the retro + newly promoted core memories, identify NEW persistent rules or lessons not already in agent_notes.md.
5. Append only genuinely new items (same meaning = duplicate, skip it).
6. Keep files concise — no redundancy.

Report what was changed (if anything).
