# Why abmind

What makes abmind different from other AI memory solutions.

## Real Memory, Not a Vector Store

Most "memory" solutions are a vector database with a search API. abmind is a complete cognitive system:

- **Automatic extraction** — facts, preferences, entities pulled from conversations without prompting
- **Consolidation** — daily → weekly → quarterly summaries compress old knowledge naturally
- **Contradiction detection** — conflicting facts identified and resolved during sleep
- **Aging** — stale memories fade, recent ones stay sharp
- **Emotion scoring** — reactions (👍, ❤️, 😡) influence memory importance

It's not "store text, retrieve text." It's "understand, compress, maintain, recall."

## Works Everywhere

One memory system, any AI tool:

- **abTARS** — in-process, zero-config
- **Kiro CLI** — native hooks + MCP
- **Claude Code** — hooks + MCP
- **Gemini CLI** — hooks + MCP
- **OpenAI Codex** — hooks + MCP
- **OpenClaw** — ContextEngine plugin
- **Any MCP client** — Cursor, Windsurf, Continue, Zed

Install once, use across all your AI tools. Same memory, same knowledge, regardless of which model or interface you use.

## Sleep Cycles — Maintenance That Thinks

Other systems accumulate data forever until you hit a limit and truncate. abmind maintains itself:

- **Extract** — pull structured facts from raw conversation noise
- **Consolidate** — merge redundant knowledge into concise summaries
- **Contradict** — detect "user moved to Berlin" vs "user lives in Budapest" and resolve
- **Age** — reduce relevance of stale facts so recall stays fresh
- **Dream** — generate retrospectives, identify patterns, suggest skills

The agent wakes up smarter than it went to sleep.

## Privacy by Design

- **Runs locally** — SQLite database on your disk, no cloud sync
- **Encrypted secrets** — class 3 memories encrypted at rest with a local key
- **Per-user isolation** — multi-user support with role-based memory access
- **No telemetry** — zero data leaves your machine, ever
- **You own the data** — backup, restore, export, delete at will

## Semantic + Keyword + Signature Search

Three search strategies combined for high recall:

| Mode | How it works | Requirement |
|------|-------------|-------------|
| FTS5 | Full-text search with trigram matching | Built-in |
| Embeddings | Semantic vector similarity | ollama (optional) |
| Signatures | Keyword fingerprint matching | Built-in |

Hybrid mode uses all three and merges results. Falls back gracefully if ollama isn't available.

### Works with agglutinative languages

Most memory systems fail on languages like Hungarian, Turkish, Finnish, and Japanese — where a single word can carry dozens of suffixes (`barátaiméknak`, `çalışamayacaklarmış`). Standard tokenizers split these wrong, FTS misses inflected forms, and keyword matching breaks entirely.

abmind handles this through:
- **Trigram matching** — finds partial word overlaps regardless of suffixes
- **Bilingual storage** — memories stored in both original language and English translation
- **Semantic embeddings** — meaning-based recall that ignores surface form
- **Possessive/suffix-aware entity matching** — "Alice's", "alices", "Alice" all resolve to the same entity

Recall works in Hungarian, Turkish, and other morphologically rich languages out of the box — no language-specific configuration needed.

## One Command Install

```bash
npm install -g abmind
abmind install
abmind install-host claude    # or: kiro, gemini, codex
```

Three commands. Memory works on your next session. No database to provision, no service to run, no config to write.

## What's Different

| Capability | Typical memory solutions | abmind |
|---|---|---|
| Storage | Vector DB (Pinecone, Chroma, Weaviate) | Local SQLite + FTS5 + optional embeddings |
| Extraction | Manual or basic chunking | Automatic fact/preference/entity extraction |
| Maintenance | None — grows forever | Sleep cycles: consolidate, age, contradict |
| Integration | Single tool/framework | Any MCP client + native hooks for 5 CLI tools |
| Privacy | Cloud-hosted vectors | Local-only, encrypted secrets, zero telemetry |
| Setup | Provision DB + configure + deploy | `npm install -g abmind && abmind install` |
| Cost | Per-query pricing | Free (local ollama) or zero-dep (signature mode) |
