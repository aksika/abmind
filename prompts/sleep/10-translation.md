# Translation Fix

Fix memories with translation quality issues.

## Pre-loaded data

Memories with poor or missing translations:
${TRANSLATION_ISSUES}

## Task

For each memory, read the original content and provide a corrected English translation:
```
abmind edit --memory-id N --translated "corrected English" --caller dreamy
```

Respond with the count of fixes applied.
