# Memory Merge

Review near-duplicate memory pairs and merge or invalidate.

## Pre-loaded data

Candidate pairs (similar content, same topic):
${MERGE_CANDIDATES}

## Rules

- Max 5 merges per run.
- If both express the same fact: `abmind store --merge --merge-ids A,B`
- If one contradicts the other: invalidate the older one via `abmind edit --memory-id <older> --valid-to <today>`
- If they are related but distinct, skip.

## Task

Review each pair and act accordingly. Respond with merges and invalidations performed.
