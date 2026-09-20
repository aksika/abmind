# GC Noise Messages

Mark small talk and noise messages as garbage.

## Pre-loaded data

Messages since last watermark (each line starts with its numeric ID):
${GC_MESSAGES}

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
2. Respond with ONLY a JSON array of the garbage message IDs, using the IDs
   shown above (e.g. `[12, 45]`). Respond with `[]` when nothing qualifies.
3. Do NOT write any files. Persistence is handled by the orchestrator; any
   `garbage.json` file you can see is not yours to modify.
