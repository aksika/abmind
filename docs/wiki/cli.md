# CLI Reference

## Lifecycle

| Command | Description |
|---------|-------------|
| `abmind install` | First-time setup of `~/.abmind` |
| `abmind update` | Build current checkout, stage, activate |
| `abmind rollback [--to version]` | Flip to previous release |
| `abmind doctor [--fix]` | Health check (permissions, DB, ollama) |
| `abmind status` | Show version, lock state |
| `abmind install-host <claude\|gemini>` | Install into Claude Code or Gemini CLI |
| `abmind install-host <host> --uninstall` | Remove integration |

## Memory Operations

| Command | Description |
|---------|-------------|
| `abmind recall --translated "keywords"` | Search memories |
| `abmind store --translated "content"` | Store a new memory |
| `abmind edit --id <id> --content "new"` | Edit existing memory |
| `abmind ingest <file>` | Ingest a document |
| `abmind embed` | Batch-embed all memories |
| `abmind wake-up` | Print current wake-up context |
| `abmind bundle` | Print full session bundle |
| `abmind memory-stats` | Memory counts, DB size |

## Sleep

| Command | Description |
|---------|-------------|
| `abmind sleep --level <budget\|normal\|ultimate>` | Run a sleep cycle |
| `abmind sleep-state` | Show sleep candidates |
| `abmind sleep-apply --promote --demote` | Promote/demote memories |
| `abmind sleep-report` | Generate dream report |

## MCP Server

```bash
abmind mcp    # starts MCP server on stdio
```

Exposes tools: `memory_recall`, `memory_store`, `memory_edit`, `memory_status`, `memory_wakeup`.

## Hooks (for host integration)

| Command | Description |
|---------|-------------|
| `abmind hook-wakeup` | Session start — inject wake-up context |
| `abmind hook-recall` | Before prompt — inject relevant memories |
| `abmind hook-store` | After response — record the turn |
| `abmind hook-doctor` | Diagnose hook config issues |

## Secrets

| Command | Description |
|---------|-------------|
| `abmind list-secrets` | Show SECRET memory metadata |
| `abmind encrypt-secrets` | Encrypt existing SECRET memories |
| `abmind rekey --old-key <path>` | Re-encrypt with new key |

## Backup

| Command | Description |
|---------|-------------|
| `abmind backup` | Create encrypted backup |
| `abmind restore` | Restore from backup |
