# Translation Fix

Fix memories with translation quality issues. This turn is PROPOSAL-ONLY: no edit tools exist.

## Pre-loaded data

Memories with poor or missing translations:
${TRANSLATION_ISSUES}

## Task

For each memory, read the original content and provide a corrected English translation:
```
TRANSLATION_FIX id=<shown id> text="<corrected English>"
```

An id outside the shown list, an over-budget translation, or a revision that
changed since the list was built is rejected and reported.

Respond with the count of fixes applied.