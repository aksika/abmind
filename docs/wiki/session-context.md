# Session-Start Context Injection

On every new session (boot, /reset, /new, compaction), the bridge injects a context block before the first user message. This gives the model its identity, history, and orientation.

## Injection Order

```
[CONTEXT — do not respond to this section]
1. [SESSION START REASON]        (if restart/reset — why)
2. [SESSION] #1 (Main)           (which session)
3. <SOUL bundle>                 (personality, rules, skills, profile, notes, memory tools)
4. [CURRENT USER] <username>         (who the model talks to)
5. [PAST DAYS] + [RECENT]        (history — dailies + recent messages)
6. [Current time + Flashback]    (wake-up — time + emotional memory anchor)
[/CONTEXT]

<user message or greeting>
```

## History Budget (#615, #656)

The history portion (item 5) is budget-controlled:

```
budget = min(maxContext × SESSION_HISTORY_PCT / 100, SESSION_HISTORY_CAP)
```

| Env var | Default | Purpose |
|---------|---------|---------|
| `SESSION_HISTORY_PCT` | `3` | Percentage of model context window for history |
| `SESSION_HISTORY_CAP` | `25000` | Hard cap in chars (prevents bloat on large-context models) |
| `SESSION_HISTORY_MIN_MSGS` | `8` | Floor — always inject at least this many recent messages |

**maxContext** is read from `models.json` via `resolveAgent()` — works for all transports (ACP, DirectApi).

### Budget math examples

| Model context | 3% | Capped | Result |
|---------------|-----|--------|--------|
| 64k | 1,920 | 1,920 | ~1 daily + 8 msgs (floor) |
| 128k | 3,840 | 3,840 | ~1 daily + 8 msgs |
| 200k | 6,000 | 6,000 | ~1-2 dailies + messages |
| 1M | 30,000 | **25,000** | ~5 dailies + messages (capped) |
| 2M | 60,000 | **25,000** | ~5 dailies + messages (capped) |

### Fill algorithm

Interleaved cycle: alternates adding 1 daily and 1 message until budget exhausted. Floor (1 daily + 8 messages) always included regardless of budget. 15% guardrail warning logged if budget exceeds 15% of context window.
