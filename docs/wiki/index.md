# abmind

**Persistent cross-session memory for AI agents.**

abmind gives any AI tool long-term memory — facts, preferences, conversation history, and emotional context that persists across sessions and survives restarts.

## How it works

Every conversation turn is recorded. A background "sleep" cycle extracts facts, detects patterns, consolidates knowledge, and prunes stale memories. On the next session, relevant memories are recalled and injected into the agent's context.

## Use it with

- **abTARS** — in-process memory for the autonomous bridge
- **Kiro CLI** — native hooks + MCP server (`abmind install-host kiro`)
- **Claude Code** — hooks + MCP server (`abmind install-host claude`)
- **Gemini CLI** — hooks + MCP server (`abmind install-host gemini`)
- **OpenAI Codex CLI** — hooks + MCP server (`abmind install-host codex`)
- **Hermes-Agent** — memory provider plugin (automatic recall/store every turn)
- **OpenClaw** — ContextEngine plugin (drop-in replacement for lossless-claw)
- **Any MCP client** — `abmind mcp` starts a stdio MCP server (works with Cursor, Windsurf, Continue, Zed, etc.)

## Quick start

```bash
npm install -g abmind
abmind install
abmind install-host kiro      # or: claude, gemini, codex
```

## Features

- **Semantic recall** — FTS5 + trigram + vector embeddings (ollama)
- **Automatic extraction** — facts, preferences, entities from conversations
- **Sleep cycles** — daily consolidation, contradiction detection, memory aging
- **Encryption** — SECRET-tier memories encrypted at rest
- **Multi-user** — per-user isolation with role-based access
- **Zero cloud** — everything runs locally (SQLite + optional ollama)

→ [Installation guide](/abmind/install)

## Community

- **Discord:** [Join our server](https://discord.gg/pj2qbWJT8)
- **Email:** aksikatwo@gmail.com
- **GitHub:** [aksika/abmind](https://github.com/aksika/abmind)
