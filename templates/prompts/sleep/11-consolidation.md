# Consolidation

Write a weekly or quarterly summary by consolidating recent daily files.

## Inputs

Covered range: ${COVERED_RANGE}

${DAILY_INPUT_LIST}

Missing dates in range (no artifact — do not invent content for these):
${MISSING_DATES}

${PREVIOUS_CONSOLIDATION_SECTION}

If the daily input list above is ABSENT, skip consolidation with a no-work
reason. Never search the filesystem for substitutes.

## Task

1. Read the listed daily files above — exactly these, no discovery.
2. Identify recurring themes, progress on projects, and shifts in priorities.
3. Write a consolidated summary to `${CONSOLIDATION_OUTPUT_PATH}`.
4. The first line should be a heading showing the date range covered (e.g. "# Weekly — May 19–25, 2026").

Respond with confirmation of the summary written.
