# Recall Feedback

Adjust relevance scores for memories that were recalled during today's conversations. This turn is PROPOSAL-ONLY: no edit tools exist.

## Pre-loaded data

Memories recalled today with conversation context:
${RECALL_FEEDBACK}

## Task

For each recalled memory:
- If the conversation confirmed it was useful (user acted on it, it answered their question, it was relevant): `RELEVANCE id=<shown id> delta=+10 reason="<one sentence>"`
- If the conversation corrected or rejected it (user said it was wrong, outdated, or irrelevant): `RELEVANCE id=<shown id> delta=-10 reason="<one sentence>"`
- If unclear or not referenced again, skip it. An id outside the shown list is rejected.

Respond with the count of boosts and demotes.