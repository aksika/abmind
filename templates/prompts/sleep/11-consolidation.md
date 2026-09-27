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
3. Carry forward any `## Recommended skills` sections found in the daily
   inputs above that have no recorded resolution: list them as pending review
   with their source dates. Do not claim they are unhandled — you have no
   record of what a human already handled.
4. Return the consolidated summary as your response text — the host
   publishes it to `${CONSOLIDATION_OUTPUT_PATH}` with owner and source
   binding. Do not write any files yourself.
5. The first line should be a heading showing the date range covered (e.g. "# Weekly — May 19–25, 2026").

Respond with the full summary text, not a confirmation message.
