# Installation

## Quick install

### Standalone (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/aksika/abmind/main/scripts/install-standalone.sh -o install-standalone.sh
sh install-standalone.sh
abmind install
```

The bootstrap script acquires abmind via `npm pack`, installs an immutable
release under `~/.abmind/packages/standalone/`, and links the `abmind` command
to `~/.local/bin`. No `npm install -g`, no npm-global prefix dependency.

Channels: `sh install-standalone.sh --alpha` or `--dev [DIR]`.

### From source

```bash
git clone git@github.com:aksika/abmind.git
cd abmind
npm install && npm run build
node dist/cli/abmind.js install
abmind update
```

## What `abmind install` does

1. Creates `~/.abmind/` skeleton (config, memory, secret, prompts)
2. Installs native deps (`better-sqlite3`, `sqlite-vec`) to `~/.abmind/lib/`
3. Checks ollama — pulls `nomic-embed-text` if available (enables vector search)
4. Asks encryption passphrase — derives key, stores in OS keyring (protects secrets at rest + backup encryption). **Remember this passphrase** — you'll need it to restore backups on a new machine.
5. Initializes `memory.db` (tables, FTS5 indexes, triggers)
6. Seeds `user_profile.md` from abtars `users.json` (or empty template)
7. Encrypts existing abtars secrets if passphrase provided
8. Writes `ABMIND_HOME` to abtars `.env` if present

### Non-interactive mode

```bash
abmind install --non-interactive                    # skip passphrase (no encryption)
abmind install --non-interactive --passphrase "x"   # with encryption, no prompts
```

## Host integration

Install into your AI tool with one command:

```bash
abmind install-host kiro      # Kiro CLI
abmind install-host claude    # Claude Code
abmind install-host gemini    # Gemini CLI
abmind install-host codex     # OpenAI Codex CLI
```

### Hermes-Agent

Hermes uses a plugin directory instead of `install-host`:

```bash
cp -r <abmind-repo>/hermes-plugin/abmind ~/.hermes/plugins/abmind/
# Then in ~/.hermes/config.yaml:
#   memory:
#     provider: abmind
```

This sets up lifecycle hooks, MCP server registration, and context files. Safe to re-run. Uninstall with `--uninstall`.

## Requirements

- Node.js 22+
- Optional: ollama (for vector embeddings — FTS5 + trigram work without it)

## Verify

```bash
abmind status          # DB stats, embedding coverage
abmind hook-doctor     # hook config health
```
