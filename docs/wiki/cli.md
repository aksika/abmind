# CLI Reference

## Lifecycle

| Command | Description |
|---------|-------------|
| `abmind install` | First-time setup of `~/.abmind` (creates dirs, DB, templates). `--force` re-seeds missing config. |
| `abmind update --dev [<DIR>]` | Install a new abmind build. `--dev` pulls the repo into `~/.abmind/src/abmind` (or builds `<DIR>` as-is); `--alpha`/`--stable` acquire and activate the latest release from npm. |
| `abmind doctor [--fix]` | Health check — permissions, standalone layout, key, templates, logs, DB, FTS, WAL, embeddings, sleep, backup. `--fix` auto-corrects what it can. |
| `abmind status` | Show lifecycle status (home, version, release, commit) |
| `abmind deps [list\|install\|update]` | Manage native deps (better-sqlite3, sqlite-vec) shared with abtars |
| `abmind service install\|uninstall\|start\|stop\|restart\|status` | Manage the abmind daemon as a native user service. Linux: systemd --user `abmind-daemon.service`. macOS: LaunchAgent. |

See [service.md](service.md) for the daemon service guide.

## Memory Operations

| Command | Description |
|---------|-------------|
| `abmind recall --translated "keywords"` | Search memories (multi-stage recall pipeline) |
| `abmind store --translated <text>` | Store a new extracted memory |
| `abmind edit --memory-id <id>` | Edit an existing memory's fields |
| `abmind ingest --file <path>` | Ingest a document into memory (extracts facts) |
| `abmind embed [--reset]` | Batch-embed all memories missing embeddings |
| `abmind expand --ids <id1,id2,...>` | Look up source messages by ID |
| `abmind wake-up [--max-chars N]` | Print current wake-up context (core identity + recent state) |
| `abmind bundle` | Print full session bundle (SOUL + profile + notes + memory tools) |
| `abmind retro-extract` | Extract facts from retrospective/consolidation files |
| `abmind migrate-openclaw <dir-or-file>` | Import OpenClaw session transcripts (`.jsonl` format) |
| `abmind operational <subcommand>` | Operational memory: draft, recall, promote, reject, revise, retire, history |

### operational subcommands

| Subcommand | Description |
|------------|-------------|
| `draft submit --lesson <text> --scope-level <level>` | Submit a new operational lesson draft. Scope levels: `global`, `platform`, `host`, `workspace`, `repository`, `task_environment` |
| `draft list` | List drafts (optionally by status) |
| `recall [--query <text>] [--limit <n>]` | Search active operational memories by scope and/or content |
| `promote` | Promote a draft to active operational memory |
| `reject` | Reject a draft |
| `revise` | Revise an active operational memory |
| `retire` | Retire an active operational memory |
| `history` | Show version history for a memory |

Use `--json` for machine-readable output.

## Sleep

| Command | Description |
|---------|-------------|
| `abmind sleep --level <level>` | Run a sleep cycle. Levels: `basic`, `budget`, `normal`, `ultimate` |
| `abmind sleep-state` | Show sleep candidates as JSON (what would be processed) |
| `abmind sleep-apply --promote <ids> --demote <ids>` | Promote/demote memories based on fitness |
| `abmind sleep-report` | Generate dream report (summary of last sleep) |

### Sleep flags

| Flag | Effect |
|------|--------|
| `--level <l>` | Depth: `basic` (fast, minimal), `budget` (light), `normal` (standard), `ultimate` (thorough) |
| `--dry-run` | Gather state + build prompts, print to stdout, skip LLM calls |
| `--verbose` | Detailed logging at each step |
| `--force` | Run housekeeping even if no new messages since last sleep |
| `--resume` | Resume an interrupted sleep cycle |

## Secrets

| Command | Description |
|---------|-------------|
| `abmind list-secrets` | Show SECRET (class 3) memory metadata — no content, no decryption |
| `abmind encrypt-secrets` | Encrypt existing classification=3 rows that aren't yet encrypted (dry-run first) |
| `abmind rekey --old-key <path>` | Re-encrypt all encrypted memories with a new key |
| `abmind repair-attribution --from-users <id,...>` | Operator-reviewed legacy attribution repair (dry-run first) |

## Backup & Restore

| Command | Description |
|---------|-------------|
| `abmind backup [--database\|--config] [--output <path>]` | Create encrypted backup (format v2, includes metadata). Default is full zip of `~/.abmind/` (excl. `secret/`) + encrypted `.abm`; `--database` is DB-only; `--config` zips `secret/` + `config/`. |
| `abmind restore <file.abm\|file.zip>` | Restore from encrypted backup |
| `abmind passwd [--secrets-dir <path>]` | Change encryption passphrase. Re-encrypts DB secrets + file secrets. |

### Restore flags

| Flag | Effect |
|------|--------|
| `<file>` | Path to `.abm` (encrypted DB) or `.zip` (full backup) |
| `--mode merge\|replace` | `merge` (default, skip existing) or `replace` (wipe + restore) |
| `--passphrase <p>` | Decryption passphrase (if key file doesn't match) |
| `--username <name>` | Name used as encryption salt (for old backups created with OS USER as salt) |

### passwd

```bash
abmind passwd                          # interactive (prompts for username, old + new passphrase)
abmind passwd --secrets-dir ~/custom   # re-encrypt file secrets from a non-default directory
```

Re-encrypts both DB secrets (classification=3 memories) and file-based secrets (`ENC:` prefixed files).
`--secrets-dir` defaults to `~/.abtars/secret` (or `$ABTARS_HOME/secret`).

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

## Install-only helpers

| Command | Description |
|---------|-------------|
| `abmind install-standalone --stable\|--alpha\|--dev [DIR]` | Install standalone (used by the bootstrap script) |
| `abmind install-host <claude\|gemini\|codex> [--uninstall]` | Install abmind hooks/MCP into a host CLI. Note: Kiro is not supported here — copy `agents/abmind.json` manually. |

## Global flags

These work with any subcommand:

| Flag | Effect |
|------|--------|
| `--help` | Show usage for the subcommand |

## Environment

All commands respect `ABMIND_HOME` (default: `~/.abmind`). See [configuration.md](configuration.md) for the full env var reference.

## Exit codes

| Code | Meaning |
|------|--------|
| 0 | Success |
| 1 | Error (message printed to stderr) |