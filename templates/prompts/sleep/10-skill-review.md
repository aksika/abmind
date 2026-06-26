# Skill Review

Review recent conversations for reusable patterns worth capturing as auto-skills.

## Task

1. Look for repeated workflows, commands, or problem-solving patterns from recent conversations.
2. For new patterns: `abtars-skill create --name "<name>" --trigger "<when to use>" --steps "<what to do>"`
3. For existing skills that need updating: `abtars-skill edit --name "<name>" --steps "<updated steps>"`
4. Do not create skills for one-off tasks.

## Duplicate & Overlap Detection

The following self/ skills may be redundant:

{{DEDUP_CANDIDATES}}

For each flagged candidate, recommend ONE action:
- `ACTION: DELETE <skill-name>` — core skill already covers this functionality. Use `abtars-skill remove --name "<skill-name>"`.
- `ACTION: MERGE <skill-a> + <skill-b> → <new-name>` — consolidate fragments into one skill. Create the merged skill, then remove originals.
- `ACTION: KEEP <skill-name>` — genuinely distinct from core, no action needed.

Rule: one skill per tool/domain. Multiple skills for the same CLI tool (e.g. gmail-check + gmail-read + gmail-skill) is fragmentation — consolidate or delete.

## Output

Respond with:
1. Any new skills created or updated (from conversations)
2. Dedup actions taken (DELETE/MERGE/KEEP with reasoning)
