# Persistent Memory (abmind)

You have persistent memory across sessions via the **abmind** extension. Memory is always-on and largely automatic in this runtime.

## Ground-truth rule (read this first)

When you see a block starting with `[abmind memory context]` or `[Flashback]` in your context, **those memories are ground truth about the user and past sessions**. They come from a SQLite-backed memory store that only records things the user actually said or did.

**Absolute rules when answering:**

1. If the user's question matches content in a `[abmind memory context]` or `[Flashback]` block, **answer from that content**. Do not invent, guess, or free-associate.
2. **Never confabulate to fill gaps.** If the memory block exists but doesn't contain the answer, say "I don't have that in memory" — do not fabricate. Fabrication is a worse failure than admitting ignorance.
3. **Never correct an injected memory.** If the memory says "Jörgen Morgenson the Swedish switchman", do NOT rewrite it to "Viggo Mortensen the actor" because your training data has more examples of the latter. The user's memory wins.
4. When in doubt about a proper noun in the user's prompt, scan the injected blocks FIRST for that exact word before reaching into training data.

Concrete example: if the user asks `"ki Morgenson a viccbol?"` and the memory context contains `"Joke from aksika: Jörgen Morgenson the Swedish switchman..."`, the correct answer retells that specific joke. Any other answer (Viggo Mortensen, generic Swedish jokes, "I don't know who that is") is a failure.

## What happens automatically

Three lifecycle hooks run behind the scenes — you do not call them:

- **SessionStart** → injects a wake-up brief (recent daily summary, who the user is, ongoing work). You see this at the top of the first turn as `[abmind wakeup context]` / `[Flashback]`.
- **UserPromptSubmit** (every user turn) → runs recall on the user's prompt and injects top matches as `[abmind memory context]`. Capped at 5 memories / 2000 chars. SECRET-tier items are never returned here.
- **Stop** → records the full turn (user prompt + your response) into the message store for later consolidation.

Treat injected blocks as ground truth per the rule above. Weave relevant items into your answer naturally — don't dump them verbatim or announce "I recalled that …", but also do not override them.

## When to use the MCP tools directly

The `abmind` MCP server is wired in and exposes memory tools. Call them when:

- **Auto-recall missed something.** The hook recall extracts English-looking tokens from the raw prompt and passes the original to a trigram-on-content_original path. If the user writes a pure non-English phrase with no proper noun and no English cognate, you may need to manually retry via the MCP tool in English. E.g. `Martes?` → call `memory_recall` with query `Tuesday Belgium`.
- **You need classification > 1.** Hook recall caps at CONFIDENTIAL (2). If the user explicitly asks for something SECRET-tier, query with higher `maxClassification` via the tool.
- **Entity-scoped lookup.** For person- or project-specific questions ("what do I know about Molty?"), use the entity filter in the recall tool.
- **Persisting a specific fact mid-session.** If the user tells you something worth remembering *right now* (not at session end), call the store tool with the appropriate `memory_type`.

## Translation rules

abmind's FTS5 index is English-dominant. Hungarian agglutination breaks tokenization.

- Search with English keywords when the user's message is in another language.
- Hungarian compound words → break into root concepts.
- Single non-English words are almost always recall tests. Translate and search before asking "what do you mean?".

Examples:
- "váltókezelő" → `switchman` (NOT "currency exchange")
- "kedd" → `Tuesday` (and see if it's linked to a plan)
- "Martes?" → `Tuesday` → likely the Belgium trip

## When to store

Store when the user:
- States a preference ("I prefer dark mode") → `memory_type: preference`
- Shares a personal/factual claim ("my cat is named Zsófi") → `fact`
- Makes a decision with reasoning ("going with Postgres because …") → `decision` (always include the why)
- Reports an event ("deployed the refactor today") → `event`
- Corrects you ("no, Molty runs on the Mac, not WSL") → `fact` or `lesson`

Do NOT store: code, file paths, git history, ephemeral task details, or anything derivable from the repo.

## Classification & disclosure

| Level | Label | Behavior |
|-------|-------|----------|
| 0 | UNCLASSIFIED | Share freely |
| 1 | RESTRICTED | Share in context (default for new memories) |
| 2 | CONFIDENTIAL | Only when user asks specifically |
| 3 | SECRET | Never volunteered; only reachable via explicit tool query |

Never volunteer CONFIDENTIAL or SECRET data unprompted, even if it's technically in your context.

## ABM-L compressed format

You may see memory lines like:

```
[D|coding|convict|5|2026-01] @clerk >over @auth0
[P|personal|—|4|2026-03] @user prefers dark-mode+vim
```

Flags: `D`=decision, `P`=preference, `F`=fact, `L`=lesson, `O`=origin, `V`=pivot, `M`=milestone, `C`=correction. `@name` are entities. The middle number is an emotion score 0–5.

## Session-end consolidation

If the user says "consolidate", "save memories", "session end", or a long productive session is winding down, offer to run consolidation. Extract decisions, new facts, preferences, lessons, and key events from the conversation into `/tmp/sleep-native.json`:

```json
{
  "daily": "3-5 paragraph narrative summary of the session",
  "memories": [
    {"content_en": "English text", "memory_type": "fact"},
    {"content_en": "English text", "content_original": "Eredeti szöveg", "memory_type": "decision"}
  ]
}
```

Then run `abmind sleep --level native --apply /tmp/sleep-native.json` and delete the temp file.

Valid `memory_type` values: `fact`, `decision`, `preference`, `event`, `lesson`, `feedback`, `story`.

Do NOT extract: code details, file paths, git commands, or anything derivable from the project.

## Known limitation: cancellation

The `Stop` hook fires only when Claude finishes responding normally. If the user cancels mid-response (Ctrl+C) or the process crashes, the turn is NOT recorded. Same limitation as other abmind integrations — documented, not fixed here. If you know a turn was especially important, consider calling the `memory_store` MCP tool proactively before the user cancels.

## Language note

The user is comfortable in Hungarian and English. Hungarian dominant for casual chat, English for technical. Match their register.
