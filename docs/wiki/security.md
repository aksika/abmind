# Security — Encryption at Rest

abmind encrypts sensitive data at rest using AES-256-GCM. All secrets stored in memory or on disk are protected by a master key derived from your passphrase.

## Classification Levels

| Level | Name | Storage | Recall |
|-------|------|---------|--------|
| 0 | Unclassified | Plaintext | Searchable |
| 1 | Restricted | Plaintext | Searchable, not shared with guests |
| 2 | Confidential | Plaintext | Searchable, master-only |
| 3 | Secret | `content_en` plaintext description, `content_original` encrypted | Description recalled, value via `secret_get` only |

Class=3 memories have a plaintext description (e.g. "OpenRouter API key") that the agent can discover via normal recall. The actual secret value is encrypted in `content_original` and only decrypted when the agent explicitly calls `secret_get`.

## Master Key Derivation

The master key is derived from a user passphrase via scrypt:

```
scrypt(passphrase, sha256("abmind:" + username)[0:16], N=16384, r=8, p=1) → 32-byte key
```

- **Passphrase** — chosen by the user, never stored on disk
- **Salt** — deterministic from username (no salt file to lose)
- **Same passphrase + username on any machine = same key** — portable across deployments

## Key Hierarchy

```
passphrase + username
    → scrypt → master key (32 bytes)
        → HKDF("abmind-secrets-v1") → DB encryption key (class=3 memories)
        → HKDF("abtars-secrets-files-v1") → file encryption key (~/.abtars/secret/)
        → HKDF("abmind-backup-v1") → backup encryption key
```

## File-Based Secrets (`~/.abtars/secret/`)

API keys and tokens are stored as encrypted files (one per secret). Format: `ENC:` prefix + base64(version_byte + IV + ciphertext + auth_tag).

The `.env` file references them with `<secret>` markers:
```
OPENROUTER_API_KEY=<secret>
```

At runtime, `getApiKey()` reads the marker, decrypts from the secret file, returns the plaintext value.

## Passphrase Resolution (boot)

1. `ABMIND_PASSPHRASE` environment variable
2. OS keyring (macOS Keychain works under launchd; Linux skipped without desktop session)
3. Interactive stdin prompt (only if TTY available)

Daemon mode (no TTY, Linux): env var is the only option. Missing = abort with clear error.

## Validation

`~/.abmind/secret/key.verify` contains `encrypt("abmind-verify")`. At boot, the derived key decrypts this file — if it fails, the passphrase is wrong and the process aborts immediately. No silent wrong-key decryption.

## Commands

| Command | Purpose |
|---------|---------|
| `abtars passwd` | Set or change passphrase. Re-encrypts all secrets. |
| `abtars install` | Asks passphrase during onboarding (new installs). |

## Legacy Mode

If `key.verify` doesn't exist but `~/.abmind/secret/abmind.key` does, abmind uses the raw key file directly (no passphrase). This supports standalone abmind users who haven't migrated. No forced migration.

## What's NOT Encrypted

- Class 0-2 memories (plaintext, searchable)
- Message history (`messages` table)
- Configuration files (transport.json, models.json)
- Logs

Only class=3 memory values and file-based secrets are encrypted at rest.
