# Backup & Restore

abmind provides encrypted backup and restore for the memory database and associated files.

## Creating a backup

```bash
abmind backup
```

Output: `~/.abmind/backups/abmind-YYYYMMDD-HHMM.abm`

### Options

| Flag | Description |
|------|-------------|
| `--database` | DB-only backup (skip core/weekly/config files) |
| `--output <path>` | Custom output path |
| `--passphrase <p>` | Encryption passphrase |
| `--passphrase-env <VAR>` | Read passphrase from env var (default: `ABMIND_BACKUP_PASSPHRASE`) |

### Passphrase resolution

1. `--passphrase` flag (explicit)
2. `--passphrase-env` variable (default: `ABMIND_BACKUP_PASSPHRASE`)
3. Falls back to `~/.abmind/secret/abmind.key` contents

### What's included

**Full backup** (default):
- `memory.db` — all messages, extracted memories, embeddings, entity graph
- `consolidation/` — daily, weekly, quarterly summary files
- `core/` — identity templates
- `topics/` — topic knowledge files
- `config/` — users.json, .env.memory

**DB-only backup** (`--database`):
- `memory.db` only

### Example

```bash
# Full backup with custom passphrase
abmind backup --passphrase "my-secure-phrase" --output ~/my-backup.abm

# DB-only backup using env var
export ABMIND_BACKUP_PASSPHRASE="secret123"
abmind backup --database
```

## Restoring from backup

```bash
abmind restore --input <path> --passphrase <p>
```

### Options

| Flag | Description |
|------|-------------|
| `--input <path>` | Backup file to restore from (required) |
| `--mode <m>` | `merge` (default) or `replace` |
| `--passphrase <p>` | Decryption passphrase |
| `--passphrase-env <VAR>` | Read passphrase from env var |
| `--yes` | Skip confirmation for `--mode replace` |

### Restore modes

| Mode | Behavior |
|------|----------|
| `merge` | Import memories, skip duplicates (by content hash). Non-destructive. |
| `replace` | Wipe all existing memories, restore from backup. Requires `--yes`. |

### Example

```bash
# Merge (safe — keeps existing, adds missing)
abmind restore --input ~/my-backup.abm --passphrase "my-secure-phrase"

# Full replace (destructive — wipes current DB)
abmind restore --input ~/my-backup.abm --passphrase "my-secure-phrase" --mode replace --yes
```

## Encryption

Backups are encrypted with AES-256-GCM. The passphrase is used to derive the encryption key via PBKDF2. Without the correct passphrase, the backup file is unreadable.

## Scheduling backups

abmind doesn't include a built-in scheduler. Use cron:

```bash
# Daily backup at 3am
0 3 * * * /usr/local/bin/abmind backup --passphrase-env ABMIND_BACKUP_PASSPHRASE
```

Or integrate with the sleep cycle — the sleep orchestrator can trigger backups as a housekeeping step.

## Backup file format

`.abm` files are encrypted archives containing:
- SQLite database dump (or full DB file)
- File tree (consolidation, core, topics, config)
- Metadata header (timestamp, memory count, file count)

The format is proprietary — use `abmind restore` to read them.

## Pruning old backups

Backups accumulate in `~/.abmind/backups/`. Clean up manually or via cron:

```bash
# Keep last 7 days of backups
find ~/.abmind/backups/ -name "*.abm" -mtime +7 -delete
```
