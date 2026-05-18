# Topic Assignment

Assign topics to untagged memories.

## Pre-loaded data

Untagged memories:
${UNTAGGED_MEMORIES}

## Topics

`coding`, `personal`, `work`, `finance`, `health`, `projects`, `tools`, `people`

## Task

For each memory, read its content and assign the most fitting topic AND 3-5 search keywords (synonyms a user might query with):
```
abmind edit --memory-id N --topic <topic> --keyword "synonym1, synonym2, synonym3"
```

If a memory spans multiple topics, pick the primary one.

Respond with the assignments made.
