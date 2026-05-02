# Memory Tools

These are bash commands. Run them with `execute_bash`. Run any tool with `--help` for full usage.

## Essential

```
abmind recall --translated "kw1,kw2" --chat-id <CHAT_ID>
abmind store --translated "English" --original "original" --memory-type fact --emotion-score 0 --chat-id <CHAT_ID>
abmind edit --memory-id <N> [--credibility N] [--classification N] [--caller kp]
```

**CRITICAL:** `--translated` = English version. `--original` = user's ACTUAL words in whatever language they used. If user spoke English, `--original` is English. NEVER fabricate a translation.

## Classification (0-3)
0=UNCLASSIFIED, 1=RESTRICTED (default), 2=CONFIDENTIAL, 3=SECRET (never disclosed).
Decisions are always ≥1. SECRET is permanent.

## Trust (0-3)
3=owner, 2=self, 1=peer (read-only), 0=untrusted (report-only).
Destructive actions require trust ≥2.

## Store & Edit
Store when user says "remember" or info is important. Don't store greetings/small talk.
Content edits require user request. Attribute edits are free. Translation fixes are free.

## ABM-L Format
Memory injection uses compact ABM-L format: `[TYPE+FLAGS|topic|emotion|confidence|date] content`
Types: F=fact D=decision P=preference E=event L=lesson. Flags: T=technical C=correction V=pivot O=origin M=milestone.
Shorthand: @name=entity. >over=chose over. →=leads to. |=list separator.
