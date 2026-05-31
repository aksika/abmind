# Sleep & Dreams

Sleep is abmind's background maintenance cycle — it processes raw conversations into structured knowledge, consolidates old memories, and detects contradictions.

## When It Runs

Configured via `BED_TIME` and `WAKE_TIME` in `.env.memory`. The bridge triggers sleep automatically during quiet hours. Can also be triggered manually:

```bash
abmind sleep --level normal    # CLI
/sleep now                     # from chat
```

## Sleep Levels

| Level | Steps | LLM Calls | Duration |
|-------|-------|-----------|----------|
| `budget` | Extract + consolidate only | ~5 | 2-5 min |
| `normal` | Full cycle (extract, consolidate, contradictions, aging) | ~15 | 5-15 min |
| `ultimate` | Deep analysis + skill review + retrospective | ~30 | 15-30 min |

## Sleep Support by Product

| Product | Max Level | Trigger | Notes |
|---------|-----------|---------|-------|
| **abTARS** | `ultimate` | Automatic (BED_TIME + quiet ticks) | Full multi-step sleep with subagent (Dreamy). Optional hardware sleep after cycle. Dream report to user. |
| **OpenClaw** | `basic` | Cron (`0 3 * * *`) or manual | Single LLM call. Plugin registers sleep cron on gateway start. |
| **Hermes-Agent** | `basic` | Auto-registered cron (gateway) or session-end | Single LLM call. Plugin triggers budget sleep on session end if >24h stale. |
| **Kiro CLI / Claude / Gemini / Codex** | `basic` | Hook-triggered extraction (agent-driven) | Single LLM call via `ABMIND_LLM_CMD`. Or `native` (no LLM) if agent produces JSON during session. |
| **MCP (standalone)** | `basic` | System cron or manual | Single LLM call via `ABMIND_LLM_CMD`. |

**Why the difference:** Only abTARS has a dedicated sleep subagent (Dreamy) with its own multi-turn session. All other products call `abmind sleep` as a single LLM call (`basic` level) — one prompt, one response, extract + consolidate in one shot.

## What Sleep Does

1. **Extract** — pull facts, preferences, entities from unprocessed messages
2. **Consolidate** — merge daily notes into weekly, weekly into quarterly
3. **Contradiction check** — detect conflicting facts, mark older one as superseded
4. **Aging** — reduce relevance scores on stale memories
5. **Skill review** (ultimate only) — identify recurring patterns worth automating
6. **Retrospective** (ultimate only) — generate a "dream report" summarizing the day

## Status

```
/sleep
```

Shows:
- 🧠 Sleep cycle running (step, %) — active
- 😴 Asleep (idle) — bedtime, nothing happening
- 👋 Awake — normal operation

## Manual Control

| Command | Effect |
|---------|--------|
| `/sleep now` | Start a fresh cycle on next heartbeat tick |
| `/sleep resume` | Retry failed steps from last cycle |
| `/wakeup` | Cancel hardware sleep, resume normal operation |
