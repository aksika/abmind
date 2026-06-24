# Memory Maintenance

Three metadata tasks on existing memories. Process each section independently.

## Task 1: Topic Assignment

Untagged memories:
${UNTAGGED_MEMORIES}

For each memory, assign the most fitting topic AND 3-5 search keywords:
```
abmind edit --memory-id N --topic <topic> --keyword "synonym1, synonym2, synonym3"
```

Topics: `coding`, `personal`, `work`, `finance`, `health`, `projects`, `tools`, `people`

If a memory spans multiple topics, pick the primary one.

## Task 2: Merge Duplicates

Candidate pairs (similar content, same topic):
${MERGE_CANDIDATES}

For each pair:
- If truly duplicate: invalidate the older one (`abmind edit --memory-id <older> --valid-to <today>`)
- If complementary: keep both
- If contradictory: invalidate the less confident one

## Task 3: Fill Emotion Context

Memories with emotion tags but missing emotion_context:
${EMOTION_CONTEXT_GAPS}

For each memory:
1. Read the content and emotion tags.
2. Infer WHY the emotion applies in 3-5 words.
3. Apply: `abmind edit --memory-id N --emotion-context "reason"`

Report counts for each task. If a section has no candidates, say "(none)" and move on.
