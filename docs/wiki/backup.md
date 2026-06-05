# Backup & Restore

abmind provides encrypted backup and restore for the memory database and associated files.

## Creating a backup

```bash
abmind backup
```

Output: `~/.abmind/backups/abmind-YYYYMMDD-HHMM.abm`

Encryption uses the key at `~/.abmind/secret/abmind.key` (created during `abmind install`). No passphrase needed at runtime — the key file is the credential.

### Options

| Flag | Description |
|------|-------------|
| `--database` | DB-only backup (skip core/weekly/config files) |
| `--output <path>` | Custom output path |

### What's included

**Full backup** (default):
- `memory.db` — all messages, extracted memories, embeddings, entity graph
- `consolidation/` — daily, weekly, quarterly summary files
- `core/` — identity templates
- `topics/` — topic knowledge files

**DB-only backup** (`--database`):
- `memory.db` only

### Example

```bash
# Full backup (uses key file, no passphrase needed)
abmind backup

# DB-only backup to custom path
abmind backup --database --output ~/my-backup.abm
```

## Restoring from backup

```bash
abmind restore --input <path>
```

If the key file exists (`~/.abmind/secret/abmind.key`), decryption is automatic. On a fresh machine without the key file, provide the original passphrase — abmind will derive and recreate the key file.

### Options

| Flag | Description |
|------|-------------|
| `--input <path>` | Backup file to restore from (required) |
| `--mode <m>` | `merge` (default) or `replace` |
| `--passphrase <p>` | Decryption passphrase (only needed if key file is missing) |
| `--username <name>` | Name used as encryption salt (for pre-v0.1.8 backups) |
| `--yes` | Skip confirmation for `--mode replace` |

### Restore modes

| Mode | Behavior |
|------|----------|
| `merge` | Import memories, skip duplicates (by content hash). Non-destructive. |
| `replace` | Wipe all existing memories, restore from backup. Requires `--yes`. |

### Example

```bash
# Merge on same machine (key file exists — no passphrase needed)
abmind restore --input ~/.abmind/backups/abmind-2026-06-05-0300.abm

# Restore on fresh machine (no key file — passphrase recreates it)
abmind restore --input ~/my-backup.abm --passphrase "my-secure-phrase"
```

## Encryption

Backups are always encrypted with AES-256-GCM. The key derivation chain:

```
passphrase + name → scrypt (N=16384, r=8, p=1) → master key (stored in abmind.key)
master key → HKDF (sha256, "abmind-backup-v1") → backup encryption key
```

The name is set during `abmind install` and stored in `manifest.json` as `encryptionUser`. The master key is written to `~/.abmind/secret/abmind.key` — all subsequent operations use the key file directly.

### Changing passphrase

```bash
abmind passwd
```

Regenerates the key file. New backups use the new key. Old backups remain decryptable with `--passphrase <old>`.

## Backup file format (v2)

`.abm` files contain:
- **Plaintext header**: magic bytes + format version (2) + metadata JSON (salt formula, KDF params)
- **Encrypted body**: AES-256-GCM encrypted + deflate-compressed JSON (DB tables + files)

The metadata is NOT encrypted — it tells the restore CLI which derivation method to use.

### Migration from old backups

Backups created before v0.1.8 used `process.env.USER` (OS login) as the salt. To restore these:

```bash
abmind restore --input old-backup.abm --passphrase <pass> --username <os-login>
```

## Scheduling

Backups are triggered automatically by `abtars backup` (which calls `abmind backup` internally). No separate scheduler needed — the abtars daily backup handles both.

For standalone abmind deployments (without abtars), use cron:

```bash
# Daily backup at 3am (key file handles encryption, no secrets in cron)
0 3 * * * /usr/local/bin/abmind backup
```

## Pruning

When called via `abtars backup`, pruning is handled automatically (7-day retention by default, configurable with `--prune-days`).

For standalone use, clean up manually:

```bash
find ~/.abmind/backups/ -name "*.abm" -mtime +7 -delete
```
