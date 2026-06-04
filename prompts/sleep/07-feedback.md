# Recall Feedback

Adjust relevance scores for memories that were recalled during today's conversations.

## Pre-loaded data

Memories recalled today with conversation context:
${RECALL_FEEDBACK}

## Task

For each recalled memory:
- If the conversation confirmed it was useful (user acted on it, it answered their question, it was relevant): `abmind edit --memory-id N --relevance-score +10`
- If the conversation corrected or rejected it (user said it was wrong, outdated, or irrelevant): `abmind edit --memory-id N --relevance-score -10`
- If unclear or not referenced again, skip it.

Respond with the count of boosts and demotes.
