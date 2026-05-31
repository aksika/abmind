# CLI Reference

## Lifecycle

| Command | Description |
|---------|-------------|
| `abmind install` | First-time setup of `~/.abmind` (creates dirs, DB, templates) |
| `abmind update` | Build current checkout, stage new release, flip symlink |
| `abmind rollback [--to <version>]` | Flip `current` symlink to a prior release |
| `abmind doctor [--fix]` | Health check — permissions, DB, ollama, templates. `--fix` auto-corrects. |
| `abmind status` | Show lifecycle status (version, lock state, symlink target) |
| `abmind install-host <host>` | Install hooks into a host CLI (`kiro`, `claude`, `gemini`, `codex`) |
| `abmind install-host <host> --uninstall` | Remove hooks from a host CLI |

## Memory Operations

| Command | Description |
|---------|-------------|
| `abmind recall --translated "keywords"` | Search memories (multi-stage recall pipeline) |
| `abmind store --translated "content"` | Store a new extracted memory |
| `abmind edit --id <id> [--content-en "..."]` | Edit an existing memory's fields |
| `abmind ingest <file>` | Ingest a document into memory (extracts facts) |
| `abmind embed` | Batch-embed all memories missing embeddings |
| `abmind expand --id <id>` | Look up source messages by memory ID |
| `abmind wake-up` | Print current wake-up context (core identity + recent state) |
| `abmind bundle` | Print full session bundle (SOUL + profile + notes + memory tools) |
| `abmind retro-extract` | Extract facts from retrospective/consolidation files |
| `abmind migrate-openclaw` | Import OpenClaw session transcripts (`.jsonl` format) |

## Sleep

| Command | Description |
|---------|-------------|
| `abmind sleep [--level <l>]` | Run a sleep cycle. Levels: `basic`, `budget`, `normal`, `ultimate` |
| `abmind sleep-state` | Show sleep candidates as JSON (what would be processed) |
| `abmind sleep-apply [--promote] [--demote] [--dry-run]` | Promote/demote memories based on fitness |
| `abmind sleep-report` | Generate dream report (summary of last sleep) |

### Sleep flags

| Flag | Effect |
|------|--------|
| `--level <l>` | Depth: `basic` (fast, minimal), `budget` (light), `normal` (standard), `ultimate` (thorough) |
| `--dry-run` | Gather state + build prompts, print to stdout, skip LLM calls |
| `--verbose` | Detailed logging at each step |
| `--force` | Run housekeeping even if no new messages since last sleep |

## Secrets

| Command | Description |
|---------|-------------|
| `abmind list-secrets` | Show SECRET (class 3) memory metadata — no content, no decryption |
| `abmind encrypt-secrets` | Encrypt existing classification=3 rows that aren't yet encrypted |
| `abmind rekey --old-key <path>` | Re-encrypt all encrypted memories with a new key |

## Backup & Restore

| Command | Description |
|---------|-------------|
| `abmind backup [--database] [--output <path>]` | Create encrypted backup |
| `abmind restore --input <path> [--mode merge\|replace]` | Restore from encrypted backup |

See [backup.md](backup.md) for full options and examples.

## MCP Server

```bash
abmind mcp
```

Starts an MCP (Model Context Protocol) server on stdio. Exposes tools:
- `memory_recall` — search memories
- `memory_store` — store a new memory
- `memory_edit` — edit an existing memory
- `memory_status` — show memory stats
- `memory_wakeup` — get wake-up context

Works with any MCP client (Cursor, Windsurf, Continue, Zed, etc.).

## Hooks (Host Integration)

Used by Kiro CLI, Claude Code, and Gemini CLI for automatic memory integration:

| Command | Hook point | Description |
|---------|-----------|-------------|
| `abmind hook-wakeup` | Session start (`agentSpawn`) | Inject wake-up context into new session |
| `abmind hook-recall` | Before prompt (`userPromptSubmit`) | Recall relevant memories for the current message |
| `abmind hook-store` | Session end (`stop`) | Record the conversation turn |
| `abmind hook-preToolUse` | Before tool execution | Security gate — blocks direct DB writes |
| `abmind hook-postToolUse` | After tool execution | Captures tool context for memory extraction |
| `abmind hook-doctor` | Manual | Diagnose hook config, errors, active sidecars |

## Global flags

These work with any subcommand:

| Flag | Effect |
|------|--------|
| `--help` | Show usage for the subcommand |

## Environment

All commands respect `ABMIND_HOME` (default: `~/.abmind`). See [configuration.md](configuration.md) for the full env var reference.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (message printed to stderr) |
