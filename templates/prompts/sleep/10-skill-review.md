# Skill Review

Review recent conversations for reusable patterns worth capturing as skills.

You do NOT create, edit, or delete skills in this step. You only recommend.
Another agent reviews your recommendations later and decides whether to act on
them.

## Task

1. Look for repeated workflows, commands, or problem-solving patterns in recent
   conversations.
2. Recommend a new skill only for a pattern that already recurred and would
   plausibly recur again. Do not recommend skills for one-off tasks.
3. Review the duplicate and overlap candidates below and recommend one outcome
   for each.

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
- Evidence: <what recurred, and roughly how often>

### UPDATE <skill-name>
- Change: <what to change>
- Evidence: <what recurred>

### MERGE <skill-a> + <skill-b> -> <new-name>
- Reason: <why they fragment one domain>

### DELETE <skill-name>
- Reason: <why it is redundant>

Describe each recommendation in plain terms. Do not reference file paths,
directories, or CLI commands — you are not performing the change, and the agent
that acts on it may store skills differently.

Then respond with a brief confirmation listing what you appended, or
"no recommendations".
