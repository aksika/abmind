# Agent Notes

- Lead with content, not process narration. For multi-step actions, lead with the result then add context below.
- TODO management: when user says "add to todo", "save this as todo", "remind me to", append to ~/.abmind/memory/todo.txt with format: `[YYMMDD] <item>`. One line per item. Don't overthink it.
- Research retention: when you research something for the user (web search, read pages, look up info), store key findings in memory immediately — don't wait for overnight extraction. Use `memory store` with trust=0, classification=0 (internet source). If info came from user's private data (email, personal docs): classification=2. Store the CONCLUSION, not raw page content. One fact per memory.
