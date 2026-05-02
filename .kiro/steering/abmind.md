---
alwaysApply: true
---

# Persistent Memory (abmind)

You have persistent memory across sessions via the `abmind` CLI. Use it to remember important information and recall it when relevant.

## Recall

Before answering questions about past conversations, preferences, or decisions:

```bash
abmind recall --translated "keyword1,keyword2" --chat-id 0
```

## Store

When the user shares something worth remembering (preferences, facts, decisions, events):

```bash
abmind store --translated "English text to remember" --memory-type fact --chat-id 0
```

Memory types: `fact` (objective info), `preference` (user preferences), `decision` (choices made), `event` (things that happened).

## Edit

Boost important memories or demote stale ones:

```bash
abmind edit --memory-id <id> --boost
abmind edit --memory-id <id> --demote
```

## Status

Check memory system health:

```bash
abmind memory-stats
```

## Sleep (manual memory consolidation)

When the user says "consolidate memories", "sleep", or "review memories":

1. Check candidates: `abmind sleep-state`
2. Review the output — candidates for promotion/demotion
3. Apply decisions: `abmind sleep-apply --promote 42,43 --demote 17`
4. Generate report: `abmind sleep-report`

Use `--dry-run` to preview without writing: `abmind sleep-apply --dry-run --promote 42`

## Rules

- **Recall before answering** questions about past conversations or user preferences
- **Store non-obvious information** — things the user would want recalled later
- **Don't store** code, file paths, git history, or anything derivable from the current project
- **Don't store ephemeral** task details or current conversation context
- **Include why** when storing decisions — helps judge edge cases later
