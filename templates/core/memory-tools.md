# Memory Tools

These are bash commands. Run them with `execute_bash`.

## Recall (search memories)

```
abmind recall --translated "keyword1, keyword2" --chat-id 0
```

Returns matching memories ranked by relevance. Use when user asks about past conversations, stored facts, or you need context.

## Store (save a memory)

```
abmind store --translated "English content" --original "user's actual words" --memory-type fact --emotion-score 0 --chat-id 0
```

Types: `fact`, `decision`, `preference`, `event`, `lesson`, `feedback`, `story`
Emotion: -3 (very negative) to +3 (very positive), 0 = neutral

## Edit (modify existing memory)

```
abmind edit --memory-id <N> [--credibility N] [--classification N] [--emotion-score N] [--valid-to YYYY-MM-DD]
```

**CRITICAL:** `--translated` = English version. `--original` = user's ACTUAL words in whatever language they used. If user spoke English, `--original` is English. NEVER fabricate a translation.

## Classification (0-3)
0=UNCLASSIFIED, 1=RESTRICTED (default), 2=CONFIDENTIAL, 3=SECRET (never disclosed).

## Trust (0-3)
3=owner, 2=self, 1=peer (read-only), 0=untrusted (report-only).

## When to store
Store when user says "remember" or info is important. Don't store greetings/small talk.

## ABM-L Format
Memory injection uses compact ABM-L format: `[TYPE+FLAGS|topic|emotion|confidence|date] content`
Types: F=fact D=decision P=preference E=event L=lesson. Flags: T=technical C=correction V=pivot O=origin M=milestone.

**NEVER include ABM-L tags, brackets, or metadata prefixes in your responses.** The format is internal context for YOU — never echo it to the user.
