# Changelog

All notable changes to abmind. Follows [Keep a Changelog](https://keepachangelog.com/).

## [0.1.2] — 2026-05-07

### Added
- **Context Orchestrator** — moved from abtars into abmind (memory logic owns context)
- **Lazy runtime init** — `ensureInitialized()` seeds core files + runs schema migrations on first use
- **SOUL-Dreamy.md** — sleep identity prompt (context injection, not separate LLM call)
- **abmind doctor** — CLI health check (permissions, DB integrity, ollama, sqlite-vec)
- **Emotion boost** — `applyEmotionBoost` in recall engine (linear |e|×0.02, tie-breaker only)
- **Tool result pruner** — truncates oversized tool outputs before context injection
- **Native loader** — loads sqlite-vec from `~/.abmind/lib/` via createRequire
- **Bundled core templates** — SOUL.md, user_profile.md, agent_notes.md, core_facts.md, memory-tools.md
- **File logging** — standalone mode writes to `~/.abmind/logs/`

### Changed
- Public API shrunk from ~120 to ~36 exports (#432)
- Sleep orchestrator: identity step is context injection (prepended to first real step)
- Recall: `applySpacingBoost` pipeline stage

### Fixed
- Sleep audit regex matched 6-digit time but files use 4-digit (#444)
- Crypto: `decryptWithKey` uses provided key correctly

## [0.1.0] — 2026-04-15

### Added
- Memory engine — SQLite + FTS5 + trigram + vector search (sqlite-vec)
- 4-layer recall: full-text, trigram, semantic embeddings, consolidated summaries
- Ingest pipeline — entity extraction, emotion tagging, classification
- Sleep system — 17-step overnight maintenance (gc-noise, daily summary, extract, retrospective, consolidate, prune)
- OpenClaw plugin — memory tools for OpenClaw gateway
- CLI hooks — `hook-wakeup`, `hook-recall`, `hook-store` for external integrations
- Credential vault — encrypted secret storage (AES-256-GCM)
- Injection scanner — detects prompt injection in stored content
- NATO Admiralty Code classification (0-3 clearance levels)
- Session context builder — wake-up context for new sessions
- Embedding provider — Ollama nomic-embed-text (local, no API key)
- Backup/restore — `abmind backup`, `abmind restore`
