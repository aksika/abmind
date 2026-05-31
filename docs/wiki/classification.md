# Classification System

abmind uses a NATO Admiralty Code-inspired system to rate memory reliability and control access. Every extracted memory carries three quality scores and a classification level.

## Classification Levels

| Class | Name | Access | Encryption | Example |
|-------|------|--------|------------|---------|
| 0 | Public | All roles | None | General facts, preferences |
| 1 | Internal | `user` + `master` | None | Personal details, work context |
| 2 | Confidential | `user` + `master` | None | Sensitive decisions, private opinions |
| 3 | Secret | `master` only | AES-256-GCM at rest | API keys, passwords, credentials |

Default classification for new memories: `1` (Internal).

### Access control

Recall queries include `maxClassification` (derived from the user's role):
- `master` → sees class 0–3
- `user` → sees class 0–2
- `guest` → sees class 0 only

Class 3 memories are encrypted in the database. They're decrypted only when recalled by a `master`-role user, and only via explicit tool call (never auto-injected into context).

## Quality Scores

### Trust (source reliability)

How reliable is the source of this information?

| Score | Meaning | Assigned when |
|-------|---------|---------------|
| 0 | Unknown | Default for new memories |
| 1 | Unreliable | Contradicted by other evidence |
| 2 | Fairly reliable | Single unconfirmed source |
| 3 | Reliable | Confirmed by user or multiple sources |

### Integrity (information accuracy)

How accurate is the information itself, independent of source?

| Score | Meaning | Assigned when |
|-------|---------|---------------|
| 0 | Unknown | Default |
| 1 | Doubtful | Contradicts known facts |
| 2 | Possibly true | Plausible but unconfirmed |
| 3 | Probably true | Consistent with other memories |
| 4 | Confirmed | Explicitly verified by user |

Default: `2` (Possibly true).

### Credibility (combined assessment)

Composite score combining trust and integrity. Used as a ranking multiplier in recall:

| Score | Effect on recall ranking |
|-------|--------------------------|
| ≤ 2 | 1.25× boost (high credibility) |
| 3–4 | 1.0× (neutral) |
| ≥ 5 | 1.0× (neutral — no penalty, just no boost) |

Lower credibility number = more credible. Scale: 0 (highest) to 6 (lowest).

Default: `6` (unassessed).

## How scores affect recall

The Sf stage scoring formula includes:

```
trust_factor = 0.5 + 0.5 × (trust / 3)
credibility_factor = 1.25 if credibility ≤ 2, else 1.0
```

A memory with `trust=3, credibility=1` gets a 1.0 × 1.25 = 1.25× boost over an unscored memory (trust=0, credibility=6 → 0.5 × 1.0 = 0.5×).

## Setting scores

### Automatic (during extraction)

The sleep cycle's extraction step assigns initial scores based on:
- Source: user-stated facts get higher trust than inferred ones
- Confidence: LLM extraction confidence maps to integrity
- Type: secrets auto-classify as class 3

### Manual (via edit)

```bash
abmind edit --id 42 --trust 3 --integrity 4 --credibility 1 --classification 2
```

### Via tool call (agent-initiated)

The `memory_store` and `memory_edit` tools accept `trust`, `integrity`, `credibility`, and `classification` parameters.

## Multi-user isolation

Classification enforcement is per-query, not per-memory. The same memory can be visible to one user and hidden from another based on their `maxClass` setting.

```json
{
  "users": [
    { "userId": "admin", "role": "master", "maxClass": 3 },
    { "userId": "colleague", "role": "user", "maxClass": 1 }
  ]
}
```

In this setup, `colleague` sees only class 0–1 memories. Class 2–3 memories exist in the same database but are filtered out at query time.

## Encryption (Class 3)

Class 3 memories use AES-256-GCM encryption:
- Key stored at `~/.abmind/secret/abmind.key` (chmod 600)
- Each memory gets a unique IV
- Encrypted content stored in `content_en` column (base64-encoded ciphertext)
- `content_original` also encrypted if present

Commands:
```bash
abmind encrypt-secrets    # encrypt existing class-3 rows
abmind list-secrets       # show metadata (no decryption)
abmind rekey --old-key /path/to/old.key   # re-encrypt with new key
```

## Upgrading classification

Promote a memory to higher classification:
```bash
abmind edit --id 42 --classification 3
abmind encrypt-secrets    # encrypt the newly-classified row
```

Demoting from class 3 requires `--user-override` flag (safety gate):
```bash
abmind edit --id 42 --classification 1 --user-override
```
