# Changelog

All notable changes to abmind. Follows [Keep a Changelog](https://keepachangelog.com/).

## [0.1.5] — 2026-06-01

### Added
- **abmind install** — full onboard: native deps, ollama check, encryption passphrase, memory DB init, user_profile.md seeding, install log
- **Agent name** — install asks agent name, writes to SOUL.md template (`<agentName>` placeholder)
- **`--agent-name`** flag for non-interactive installs
- **`rebuildFtsIndexes()`** on MemoryBackend interface
- **Block system/agent** from storing memories + 24h TTL cleanup (#701)

### Changed
- SOUL template: "I am <agentName>, an autonomous agent. abtars is my runtime — it gives me voice and hands."
- `seedCoreFiles` reads from `templates/core/SOUL.md` (was `core/SOUL.md`)
- Sleep budget raised to 18 + reset llmCalls on resume (#684)

### Fixed
- `abmind bundle --help` exits with usage instead of running bundle
- Scope sleep message query to primary user_id (#696)
- Lazy-load better-sqlite3 — no top-level require (#713)

## [0.1.4] — 2026-05-31

### Added
- **Backup** — `abmind backup --database` flag + auto key-file fallback (#707)
- **FTS self-heal** — `rebuildFtsIndexes()` exposed on MemoryBackend interface (#706)
- **Session context** — `skipDailies` + `maxAgeMs` options (#658)
- **SESSION_HISTORY_CAP** — cap history budget at 25000 chars (#656)
- **buildStatusBlock** — compact system status for session-start (#646)
- **Curation counter** — skip candidates after 3 failures with same model (#639)
- **Wiki** — 13 pages (recall, classification, configuration, backup, troubleshooting + rewrites)

### Changed
- Sleep pipeline: merge core-promotion into retro-derive (two-stage knowledge funnel, #630)
- Consolidation writes to `weekly/` not `daily/` (#640)
- Exclude non-numbered files from sleep step loader (#637)
- [RECENT] shows newest messages, not oldest (#654)
- README rewrite: selling points, badges, agglutinating language examples

### Fixed
- `[NO-REPLY]` renamed to `[NO_REPLY]` (underscore) matching bridge filter

## [0.1.3] — 2026-05-20

### Added
- Dreaming pipeline — multi-step sleep with per-step retry
- CI/CD — GitHub Actions build + test
- Community templates — SOUL.md, user_profile.md, agent_notes.md

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
