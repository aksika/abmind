# Memory Maintenance

Three metadata tasks on existing memories. This turn is PROPOSAL-ONLY: no edit tools exist; abmind validates each proposal against the shown ids and their current revisions. Process each section independently.

## Task 1: Topic Assignment

Untagged memories:
${UNTAGGED_MEMORIES}

For each memory, assign the most fitting topic AND optional 3-5 search keywords:
```
TOPIC id=<shown id> topic=<coding|personal|work|finance|health|projects|tools|people> keywords="synonym1, synonym2, synonym3"
```

If a memory spans multiple topics, pick the primary one.

## Task 2: Merge Duplicates

Candidate pairs (similar content, same topic):
${MERGE_CANDIDATES}

For each pair where one is truly superseded by the other:
```
MERGE_KEEP drop=<older id> keep=<newer id> reason="<one sentence>"
```
The dropped memory is invalidated through the pair-checked boundary; the
kept memory is unchanged. If complementary or uncertain, keep both and
propose nothing.

## Task 3: Fill Emotion Context

Memories with emotion tags but missing emotion_context:
${EMOTION_CONTEXT_GAPS}

For each memory:
1. Read the content and emotion tags.
2. Infer WHY the emotion applies in 3-5 words.
3. Propose: `EMOTION_CONTEXT id=<shown id> text="<3-5 word reason>"`

Report counts for each task. If a section has no candidates, say "(none)" and move on. Ids outside a section's shown list are rejected.