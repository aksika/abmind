# Skill Review

Review the past week's conversations for reusable patterns worth capturing as skills.

You do NOT create, edit, or delete skills in this step. You only recommend.
Another agent reviews your recommendations later and decides whether to act on
them.

Cadence: this step runs weekly on normal curation days and nightly at the
ultimate level. The review window below always covers the seven local dates
ending on the cycle date.

## Review window (read exactly these daily files, no discovery)

${SKILL_REVIEW_DAILIES}

Missing dates in range (no artifact — do not invent content for these):
${SKILL_REVIEW_MISSING_DATES}

## Task

1. Look for repeated workflows, commands, or problem-solving patterns across
   the dated daily files above.
2. Recommend a new skill only for a pattern that recurs across at least two
   dates in the window above and would plausibly recur again. Cite each
   occurrence by date. Do not recommend skills for one-off tasks. When the
   available files cannot show recurrence, make no new-skill recommendation.
3. Review the duplicate and overlap candidates below and recommend one outcome
   for each. When the catalog below reports unavailable, skip the duplicate
   review and say so explicitly — an unavailable catalog is not a clean bill
   of health, and you must not invent skill names to review.

## Duplicate & Overlap Detection

The following existing skills may be redundant:

${DEDUP_CANDIDATES}

Rule: one skill per tool or domain. Several skills covering the same tool (for
example gmail-check + gmail-read + gmail-skill) is fragmentation — recommend
consolidation.

## Output

Append your recommendations to `${DAILY_PATH}` under exactly this heading:

## Recommended skills

Use only the entry kinds you need, and omit the whole section if you have
nothing to recommend:

### NEW <skill-name>
- Trigger: <when the skill should be used>
- Steps: <what to do>
- Evidence: <which dates it recurred on, and what happened each time>

### UPDATE <skill-name>
- Change: <what to change>
- Evidence: <which dates it recurred on>

### MERGE <skill-a> + <skill-b> -> <new-name>
- Reason: <why they fragment one domain>

### DELETE <skill-name>
- Reason: <why it is redundant>

Describe each recommendation in plain terms. Do not reference file paths,
directories, or CLI commands — you are not performing the change, and the agent
that acts on it may store skills differently.

Then respond with a brief confirmation listing what you appended, or exactly
"no recommendations" (with no append) when you have nothing to recommend.
