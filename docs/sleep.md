# Sleep (Dreamy) — Memory Maintenance Pipeline

Dreamy is abmind's overnight memory maintenance cycle. Optional addon — memory works without it.

## Trigger

- `BED_TIME` env + quiet ticks (no user activity for `BED_QUIET_TICKS` × heartbeat interval)
- Only fires between `BED_TIME` and `WAKE_TIME`
- No catch-up on bridge start — tick system is the only trigger
- Guard: `hasSleepAuditToday()` prevents double-run

## Pipeline (12 steps)

```
01 gc-noise              → clean garbage from messages table
02 daily-summary         → write daily file (events, tasks, decisions)
03 retrospective         → append retro to daily (lessons, emotions, analysis)
04 extract-memories      → single extraction pass on full daily+retro content
05 contradiction+graph   → detect conflicts + entity extraction
06 retro-derive          → promote to core memory + crystallize to knowledge files
07 feedback              → boost/demote recalled memories by usefulness
08 memory-maintenance    → topic assignment + merge duplicates + emotion context
09 translation           → fix poor translations
10 skill-review          → create/update skills from recurring patterns
11 consolidation         → weekly/quarterly summary
12 rem-synthesis         → creative cross-memory connections (REM dreaming)
```

Steps 01 and 04 are code-driven (orchestrator logic). All others are prompt-driven (LLM executes via tools).

## Quality Levels

| Level | Daily | Curation day | Use case |
|-------|-------|--------------|----------|
| **basic** | 1 call | 1 call | Single combined prompt. Frontier models only. |
| **budget** | ~3 calls | ~5 calls | Cheap tier. Daily: gc + summary + extract. Curation adds retro + derive. |
| **normal** | ~7 calls | ~12 calls | Default. Daily: steps 01-07. Curation adds: 08-12. |
| **ultimate** | ~12 calls | ~12 calls | Rich tier. All steps every night. |

Curation day: configurable via `SLEEP_CURATION_DAY` env (default: `sunday`). One day/week where heavier maintenance steps run.

## Key Design Decisions

- **Retro appends to daily** — one file per day, not separate retro + daily files
- **Single extraction pass** — runs AFTER retro so it has the richest content (events + emotional context + lessons)
- **retro-derive is daily** — agent_notes should update every night when there are new lessons
- **Maintenance is weekly** — topic-assignment, merge, translation etc. accumulate slowly, batching is fine
- **Candidate-driven skips** — steps only fire when pre-pass finds work (e.g. no untagged memories → skip topic-assignment)

## Variable Chaining

Steps pass data via `vars`:
- `${CLEAN_MESSAGES}` — today's messages (pre-queried, garbage-filtered)
- `${DAILY_PATH}` — path to the daily file (step 03 appends here)
- `${RETRO_CONTENT}` — step 03's response (retro text, used by step 05)
- `${RETRO_PATH}` — same as DAILY_PATH (legacy alias)

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `BED_TIME` | `23:00` | When sleep can trigger |
| `WAKE_TIME` | `07:00` | When sleep window closes |
| `BED_QUIET_TICKS` | `2` | Quiet ticks before triggering (~10 min) |
| `SLEEP_QUALITY` | `normal` | Quality level |
| `SLEEP_CURATION_DAY` | `sunday` | Which day runs weekly steps |

## Output

- `~/.abmind/memory/daily/daily_YYYY-MM-DD.md` — daily summary + retro
- `~/.abmind/memory/sleep/YYYYMMDD/` — per-step log files (audit trail)
- `~/.abmind/memory/sleep/YYYYMMDD/sleep_YYYYMMDD.lock` — state file (resume support)
- Memories stored/updated in `memory.db` via `abmind store`/`abmind edit`
- `~/.abmind/memory/core/agent_notes.md` — updated by step 05

## Resume & Catch-up

Sleep is resumable — if interrupted mid-cycle, next trigger picks up from the last completed step (tracked in lock file). Catch-up runs missed essential steps (daily-summary, extract-memories, retrospective) for up to 3 days back.
