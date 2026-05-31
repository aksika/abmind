# abmind

**Persistent cross-session memory for AI agents.**

abmind gives any AI tool long-term memory — facts, preferences, conversation history, and emotional context that persists across sessions and survives restarts.

## How it works

Every conversation turn is recorded. A background "sleep" cycle extracts facts, detects patterns, consolidates knowledge, and prunes stale memories. On the next session, relevant memories are recalled and injected into the agent's context.

## Documentation

- [Why abmind?](why.md) — motivation, design philosophy
- [Installation](install.md) — setup guide
- [Memory System](memory.md) — how storage, extraction, consolidation, and darwinism work
- [Recall Pipeline](recall.md) — the 4-layer search algorithm, ranking, deduplication
- [Classification](classification.md) — NATO Admiralty Codes, trust/integrity/credibility, access control
- [Configuration](configuration.md) — all `ABMIND_*` env vars with defaults
- [CLI Reference](cli.md) — all commands and flags
- [Integration](integration.md) — embedding abmind in host CLIs and agent frameworks
- [Session Context](session-context.md) — how context is assembled per-turn
- [Sleep Cycles](sleep.md) — overnight processing, extraction, consolidation
- [Backup & Restore](backup.md) — encrypted backups, scheduling, restore modes
- [Security](security.md) — encryption, permissions, multi-user isolation
- [Troubleshooting](troubleshooting.md) — common issues and fixes

## Use it with

- **abTARS** — in-process memory for the autonomous bridge
- **Kiro CLI** — native hooks + MCP server (`abmind install-host kiro`)
- **Claude Code** — hooks + MCP server (`abmind install-host claude`)
- **Gemini CLI** — hooks + MCP server (`abmind install-host gemini`)
- **OpenAI Codex CLI** — hooks + MCP server (`abmind install-host codex`)
- **Hermes-Agent** — memory provider plugin
- **OpenClaw** — ContextEngine plugin
- **Any MCP client** — `abmind mcp` starts a stdio MCP server

## Quick start

```bash
npm install -g abmind
abmind install
abmind install-host kiro      # or: claude, gemini, codex
```

## Community

- **Discord:** [Join our server](https://discord.gg/pj2qbWJT8)
- **Email:** aksikatwo@gmail.com
- **GitHub:** [aksika/abmind](https://github.com/aksika/abmind)
