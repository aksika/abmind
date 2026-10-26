# Consolidation

Write a weekly or quarterly summary by consolidating the listed inputs.

## Inputs

Covered range: ${COVERED_RANGE}

${DAILY_INPUT_LIST}

Missing dates in range (no artifact — these are unknowns, never "nothing happened"):
${MISSING_DATES}

${PREVIOUS_CONSOLIDATION_SECTION}

If the input list above is ABSENT, skip consolidation with a no-work reason.
Never search the filesystem for substitutes.

## Selection: signal over minutiae

Prefer, in order:

1. Concrete events: what happened, when, who was involved, and the outcome.
2. User decisions and their rationale; direction changes; priority shifts.
3. Blockers, failures, incidents, and how they were resolved.
4. Durable facts and preferences that will still matter later.
5. Status changes on active projects and open follow-ups.

Condense hard: repetitive lesson drills, vocabulary lists, quizzes, raw code,
routine tool output, and near-duplicate examples are minutiae unless they
explain a durable fact or decision. Never enumerate them one by one, and never
let them displace events or decisions. A reader must be able to tell what
actually happened in the period from the summary alone.

Carry forward any `## Recommended skills` sections found in the inputs that
have no recorded resolution: list them as pending review with their source
dates. Do not claim they are unhandled — you have no record of what a human
already handled.

Honesty rules:

- A date listed as missing is unknown; do not summarize it as "nothing
  happened" and do not invent content for it.
- Inputs annotated as late sources were summarized after their period; include
  them with their original dates and do not present them as current.
- Use only the listed inputs; make no claim they do not support.

## Output

- Return the full summary as your response text. The host publishes it with
  owner, period, and source binding. Do not write any files yourself.
- Start with a heading for the period (e.g. "# Weekly — May 19–25, 2026" or
  "# Quarterly — 2026 Q2 (April–June)").
- Cover the whole range; structure longer ranges by week or month so no part
  is silently dropped.
- Open every period and section heading with 1–2 introductory lines before any
  subsections, so each section reads standalone. A parent whose content lives
  entirely in subsections is still accepted by the host, but do not rely on
  that: empty sections risk rejection.
- Finish every heading you open. The response is complete only when its last
  content line is exactly:

===CONSOLIDATION-COMPLETE===

- Stay within the step's time budget: condense rather than stop early. A
  response that ends mid-section is rejected by the host and the period stays
  due.
