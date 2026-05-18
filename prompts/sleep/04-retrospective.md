# Daily Retrospective + Memory Extraction

Write a daily retrospective based on today's conversations, then extract lasting memories from it.

## Pre-loaded data

Today's clean messages:
${CLEAN_MESSAGES}

## Task 1: Write Retrospective

Write a retrospective covering:

1. **What happened** — key events, tasks, decisions made today.
2. **Emotional attribution** — how the user seemed to feel during different interactions. Note shifts in tone or energy.
3. **Lessons** — what went well, what didn't, what to do differently.
4. **Recurring errors** — check if any errors appeared multiple times today and were fixed the same way. If so, note: "Recurring: [error] was fixed by [action] — consider adding as auto-fix rule via `abtars-autofix add`."
5. **Agent notes update** — if anything learned today should persist (user preferences, project context, recurring patterns), update `agent_notes.md` via `abmind edit`.

Write the retrospective to `${RETRO_PATH}`.

## Task 2: Extract Memories from Retrospective

From the retrospective you just wrote, extract lessons, mistakes, and insights as permanent memories:

1. For each candidate, run `abmind recall` with the key phrase to check for duplicates.
2. If no duplicate exists, store via `abmind store`.
3. If a mistake repeats a previously stored mistake, store it with escalated emotion score (`-2` from previous).

Respond with a brief confirmation of what was written to the retro file, followed by the count of memories stored.
