# GC Noise Messages

Mark small talk and noise messages as garbage.

## Pre-loaded data

Messages since last watermark:
${MESSAGES_SINCE_WATERMARK}

## Rules

A message is garbage if it is:
- A greeting with no substance ("hi", "hey", "yo", "good morning")
- A ping or check-in with no question ("you there?", "ping")
- Filler or acknowledgment with no content ("ok", "cool", "thanks", "k", "lol", "haha")
- Emoji-only messages

A message is NOT garbage if it:
- Confirms an action ("yes, deploy it", "go ahead")
- Contains an instruction or request
- Asks a question with substance
- Provides context or information

## Task

1. Review each message above.
2. For each garbage message, write its ID to `garbage.json` as an array of message IDs.
3. Respond with the count of messages marked as garbage.
