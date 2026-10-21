# Post-Retro Derivation — Knowledge Crystallization

Crystallize the retrospective into knowledge files. This turn is PROPOSAL-ONLY: no store/edit/CLI or file-write tools exist. Read the bounded knowledge snapshot below (it is the current file content, with its version) and emit proposals; abmind validates each against the shown file versions and applies only accepted proposals.

Durable correction and supersession belong to the owner correction path (#1930), not to this step. This step never promotes, invalidates, edits, or links memories.

## Input

${RETRO_CONTENT}

If the retrospective input above is marked ABSENT, skip derivation and report the skip visibly.

## Task: Crystallize to Core Knowledge

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

## Rules

### What `agent_notes.md` is
A behavior policy: reusable rules that change how the agent acts on future
tasks. It is not a journal, incident log, fact table, registry, or memory
substitute.

### Admission test — all four must pass
1. **Reusable**: names a trigger class and an action that applies beyond the
   day it was learned.
2. **General**: no dates, retro labels, personal/pet/product names, ticket
   numbers, or quoted chat. Keep a literal identifier only when it is the
   trigger (an error code, a field value, a command).
3. **Durable**: still true in six months. Transient status, schedules, and
   "currently broken" notes belong in memory, not here.
4. **Non-duplicate**: if an existing entry covers the behavior, merge into it
   with UPDATE; never add a near-duplicate.

If a candidate fails one test, do not propose it.

### Entry shape
- One bullet = one entry, one paragraph, max 280 characters, blank line
  between entries. No `##` headers and no multi-entry blocks.
- Pattern: `- **Imperative name**: when <trigger>, <action>; <reason only if
  non-obvious>.`
- `provenance=` is audit metadata for the command line only. Never copy it, a
  date, or "retro" into the entry text.
- Ask: "does this tell me how to act next time, or what is true?" Behavior
  rules go here; facts about people, animals, projects, or the environment
  belong in `user_profile.md`, `core_facts.md`, or memory.
- When updating an existing longer entry, shorten it to the limit at the same
  time.

### Curation
- Remove entries contradicted by today's retro; update entries that have
  become stale.
- Merge entries that cover the same trigger and action.

### Budget discipline
- Target 10 KiB; hard cap 12 KiB.
- Before an ADD, estimate the result. If it would pass 10 KiB, first emit
  REMOVE/UPDATE proposals that free at least as many bytes — merge overlapping
  rules, shorten incident detail, delete expired guidance — then ADD.
- Compaction is always in scope: merge near-duplicates and drop over-specific
  entries even when there is no new lesson.
- One merged rule beats two narrow ones.
- If the snapshot shows an omission marker, do not ADD; report that compaction
  is required.

### Examples

BAD:
`## Dog Registry (retro 2026-09-22)`
`- Canonical dog table first: ... Dog A/Dog B gaps caused 3x ... on 2026-09-21`
Why: dated heading, named subjects, incident narrative, factual registry. Belongs
in memory, not in a behavior policy.

BAD:
`- Watch inbound briefing truncation: 2026-09-17 briefing transcript arrived cut
off mid-item ...`
Why: one incident, not a rule.

GOOD:
`- **Verify before relaying**: before recapping or forwarding generated content,
confirm it arrived complete; truncation reads as carelessness.`

GOOD:
`- **Consult the canonical table before ranking**: for registry-style questions,
query stored state first and ask when a name is ambiguous; never reconstruct
from session context.`

Report what was changed (if anything). If nothing is worth changing, say "No knowledge changes."
