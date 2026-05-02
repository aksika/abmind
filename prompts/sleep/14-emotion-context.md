# Emotion Context

Infer emotional context for memories that have emotion tags but no context explaining why.

## Pre-loaded data

Memories with emotion tags but missing emotion_context:
${EMOTION_CONTEXT_GAPS}

## Task

For each memory:
1. Read the content and emotion tags.
2. Infer WHY the emotion applies in 3–5 words (e.g., "frustrated by repeated bug", "proud of shipping fast").
3. Apply: `abmind edit --memory-id N --emotion-context "reason"`

Respond with the count of contexts added.
