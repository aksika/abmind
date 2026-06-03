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
| `--username <name>` | Name used as encryption salt (for old backups, see Migration below) |
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

Backups are encrypted with AES-256-GCM. The key is derived from your passphrase + name using:

```
passphrase + name → scrypt (N=16384, r=8, p=1) → master key → HKDF (sha256, "abmind-backup-v1") → backup key
```

The name is set during `abmind install` ("Your name" prompt) and stored in `manifest.json` as `encryptionUser`.

### Changing passphrase

```bash
abmind passwd
```

New backups use the new key. Old backups remain decryptable with `--passphrase <old>`.

## Backup file format (v2)

`.abm` files contain:
- **Plaintext header**: magic bytes + format version (2) + metadata JSON (salt formula, KDF params)
- **Encrypted body**: AES-256-GCM encrypted + deflate-compressed JSON (DB tables + files)

The metadata is NOT encrypted — it tells the restore CLI which derivation method to use without guessing.

### Migration from old backups

Backups created before v0.1.8 used `process.env.USER` (OS login) as the salt. To restore these:

```bash
abmind restore --input old-backup.abm --passphrase <pass> --username <os-login>
```

## Scheduling backups

abmind doesn't include a built-in scheduler. Use cron:

```bash
# Daily backup at 3am
0 3 * * * /usr/local/bin/abmind backup --passphrase-env ABMIND_BACKUP_PASSPHRASE
```

Or integrate with the sleep cycle — the sleep orchestrator can trigger backups as a housekeeping step.

## Backup file format

See "Backup file format (v2)" above. The format is proprietary — use `abmind restore` to read them.

## Pruning old backups

Backups accumulate in `~/.abmind/backups/`. Clean up manually or via cron:

```bash
# Keep last 7 days of backups
find ~/.abmind/backups/ -name "*.abm" -mtime +7 -delete
```
