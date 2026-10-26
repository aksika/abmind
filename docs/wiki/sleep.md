# Sleep Cycles

Sleep is abmind's background maintenance — it turns raw conversation transcripts into durable knowledge, consolidates old summaries, and files clarification questions for real conflicts. One run covers extraction through a final review; the run only counts as complete when every step is accepted.

## Running it

```bash
abmind sleep --level normal    # standard cycle
abmind sleep --level budget    # light cycle, fewer calls
abmind sleep --level ultimate  # everything, no weekly gating
abmind sleep-state             # show what a run would process (JSON)
abmind sleep-report            # dream report summarizing the last run
```

Flags: `--level <l>`, `--dry-run` (gather state, skip LLM calls), `--verbose`, `--force` (run even with no new messages), `--resume` (continue an interrupted run). Depth can also be set with `SLEEP_QUALITY`.

For unattended operation, schedule it — e.g. a cron line running `abmind sleep --level normal` nightly. Hermes-Agent deployments schedule through their own cron; see [Hermes](hermes.md).

## Levels

| Level | What runs | LLM calls |
|-------|-----------|-----------|
| `basic` | Single-shot combined prompt (frontier models only) | 1 |
| `budget` | Noise cleanup, summary, extraction, final review | ~3 daily, ~5 on curation day (adds retrospective + derivation) |
| `normal` | Everything in budget, plus retrospective, derivation, contradiction review, and consolidation when due | ~7 daily, ~10 on curation day |
| `ultimate` | All steps every run, no weekly gating | ~10 |

`normal` is the default.

## What a run does

1. **Clean + summarize** — drop noise, write the day's summary.
2. **Look back** — fold the day into a retrospective.
3. **Extract** — propose durable facts, decisions, preferences, events from new messages. Nothing is stored silently: every store carries its source message.
4. **Contradict (normal+)** — compare new knowledge against existing durables. Conflicting claims are **kept side by side with evidence** and, for material conflicts, filed as a clarification question the owner can answer. Sleep never rewrites history and never silently edits.
5. **Derive** — file the extraction into maintained knowledge files.
6. **Consolidate** — roll daily notes into weekly summaries (at most one per completed Monday–Sunday week) and quarterlies while one is due.
7. **Review** — a final pass accepts the run or reports what failed. Failed steps keep the run's messages retained for the next cycle; completed work advances a watermark so it is never processed twice.

## Curation day

Once a week (default Sunday, `SLEEP_CURATION_DAY`) the run additionally reviews maintainable skills and synthesizes REM-style observations. These steps never run off-schedule.

## Questions for the owner

When sleep finds a conflict it cannot resolve, it stores a durable clarification question (visible in the transcript alongside the assistant's next message). Answering happens in ordinary conversation — the next sleep folds the answer back into knowledge. Nothing expires silently: unanswered questions stay pending for seven days.
