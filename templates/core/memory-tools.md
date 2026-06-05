# Memory Tools

These are bash commands. Run them with `execute_bash`.

## Recall (search memories)

```
abmind recall --translated "keyword1, keyword2" --user-id <USER_ID>
```

Returns matching memories ranked by relevance. Use when user asks about past conversations, stored facts, or you need context.

**If recall returns 0 useful results and user insists or rephrases:** retry with 2-3 synonyms, slang equivalents, or translations of the key term in `--translated`. Example: "vasutas vicc" → retry with `--translated "railway, switchman, train joke"`. You ARE the synonym generator — expand the term yourself.

## Store (save a memory)

```
abmind store --translated "English content" --original "user's actual words" --memory-type fact --emotion-score 0 --user-id <USER_ID>
```

Types: `fact`, `decision`, `preference`, `event`, `lesson`, `feedback`, `story`
Emotion: -3 (very negative) to +3 (very positive), 0 = neutral

## Edit (modify existing memory)

```
abmind edit --memory-id <N> [--credibility N] [--classification N] [--emotion-score N] [--valid-to YYYY-MM-DD]
```

**CRITICAL:**
- `--original` = user's ACTUAL words in whatever language they used. Verbatim. If user spoke English, original is English.
- `--translated` = English search-optimized version. Not a word-for-word translation — include key facts, relevant keywords, and context that make this memory findable via search. This is the primary recall index. Write for searchability, not readability. Expand terse originals into self-contained English statements.
  - Stories: include the moral or lesson, not just the plot.
  - Jokes: explain what makes it funny (wordplay, cultural reference, setup/subversion).
  - Language jokes/puns: explain the mechanism in the source language so your future self can retell it. E.g. "plays on Hungarian 'X' sounding like 'Y' which means Z."

## Classification (0-3)
0=UNCLASSIFIED, 1=RESTRICTED (default), 2=CONFIDENTIAL, 3=SECRET (never disclosed).

## Trust (0-3)
3=owner, 2=self, 1=peer (read-only), 0=untrusted (report-only).

## When to store
Store when user says "remember" or info is important. Don't store greetings/small talk.

## Learning Signals — what to store and how

| Signal | Examples | Store as |
|--------|----------|----------|
| Correction | "No that's wrong", "I told you before", "Stop doing X", "Why do you keep..." | type=lesson, confidence=4. Contradicts prior → store it, the old one expires automatically. |
| Preference | "I like when you...", "Always do X", "Never do Y", "My style is..." | type=preference, confidence=3 |
| Explicit rule | "Remember that I always...", "For [project] use..." | type=fact, confidence=4 |
| Repeated praise | Same approach praised 3+ times | type=lesson, note what worked |

## Don't store

- One-time instructions — "do X now", "run this command", "fix this line"
- Context-specific — "in this file", "for this PR", "just this once"
- Hypotheticals — "what if...", "could you try..."
- Transient state — file contents, errors, build output, log snippets
- Already known — check recall before storing duplicates

Rule: "will this matter in a week?" No → don't store.

## ABM-L Format
Memory injection uses compact ABM-L format: `[TYPE+FLAGS|topic|emotion|confidence|date] content`
Types: F=fact D=decision P=preference E=event L=lesson. Flags: T=technical C=correction V=pivot O=origin M=milestone.

**NEVER include ABM-L tags, brackets, or metadata prefixes in your responses.** The format is internal context for YOU — never echo it to the user.
