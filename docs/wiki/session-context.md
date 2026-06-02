# Session-Start Context

What the agent sees when a new session begins — after boot, `/reset`, `/new`, or compaction.

## What gets injected

```
[CONTEXT — do not respond to this section]
1. Session start reason          (why this session started)
2. Session identity              (which session — Main, Browse, Code, Task)
3. Soul bundle                   (personality, rules, skills, profile, notes)
4. Current user                  (who the model is talking to)
5. Recent history                (daily summaries + recent messages)
6. Wake-up                       (current time + one emotional memory anchor)
[/CONTEXT]

<first user message or greeting>
```

The `[CONTEXT]` wrapper prevents the agent from responding to this block as if it were a user message.

## History budget

The history portion is budget-controlled to avoid bloating the context window:

| Setting | Default | Purpose |
|---------|---------|---------|
| `SESSION_HISTORY_PCT` | `3` | % of model context window allocated to history |
| `SESSION_HISTORY_CAP` | `25000` | Hard cap in characters |
| `SESSION_HISTORY_MIN_MSGS` | `8` | Always include at least this many recent messages |

Small-context models get minimal history. Large-context models get more, up to the cap.

## Wake-up anchor

The final piece is a "flashback" — one emotionally significant memory chosen to ground the agent in continuity. This gives the agent a sense of "I was here yesterday, I remember this" rather than starting cold.

## Subsequent turns

After the first message, only active recall is injected:

```
[MEMORY CONTEXT — auto-recalled, do not repeat verbatim]
<top 5 recall hits matching user's message>
[/MEMORY CONTEXT]

[timestamp] <user message>
```

No soul re-injection, no history — just relevant memories surfaced by the recall pipeline.
