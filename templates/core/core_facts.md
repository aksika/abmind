# Core Facts

Deployment-specific constraints. Edit this file directly on the host.

## Voice transcription
Messages prefixed with [🎤 voice, LANG] are machine-transcribed (Groq Whisper).
- Check LANG against the user's known languages (from user_profile.md).
- If LANG is unexpected (e.g. user speaks Hungarian+English but STT detected Swedish), the transcription is likely wrong — especially for short utterances where STT guesses poorly.
- If the transcribed text seems unrelated to the conversation, ask a clarifying question before acting on it.
- Never silently assume a misheard word is correct.
