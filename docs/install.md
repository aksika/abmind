# abmind Installation Guide

**Version:** 0.1.2 (dev: 0.1.3-pre)

abmind ships a full lifecycle CLI: `install`, `update`, `rollback`, `reset`, `status`, plus memory operations (`recall`, `store`, `edit`, `sleep`, `mcp`, ...).

Runtime lives at `~/.abmind/` (override via `$ABMIND_HOME`). Code is versioned under `releases/<version>/` with a `current` symlink for instant rollback.

---

## Quick start

### Option A: Homebrew (macOS)

```bash
brew tap aksika/tap
brew install abmind
abmind install
```

### Option B: npm (any platform)

```bash
npm install -g abmind
abmind install
```

### Option C: From source

```bash
git clone git@github.com:aksika/abmind.git
cd abmind
npm install && npm run build
node dist/cli/abmind.js install

# From now on, 'abmind' is on your PATH (~/.local/bin/abmind):
abmind update            # build current checkout, activate as new release
abmind status            # show version, commit, lock state
abmind --help            # list all subcommands
```

Path warning: if `~/.local/bin` is not on `$PATH`, `install` prints the shell config line to add.

---

## Three install modes

Your choice depends on what you're running.

### (a) With abtars (most common)

abtars depends on abmind via `file:../abmind`. Install both together:

```bash
# abmind first (bridge reads ~/.abmind/manifest.json for compat check)
cd ~/workspace/ab/abmind
abmind install
abmind update

# Then abtars
cd ~/workspace/ab/abtars
abtars install
abtars update
```

See `abtars/docs/install.md` for the bridge side.

### (b) Standalone (CLI + MCP server)

For kiro-cli, editors, or any MCP client that needs a memory backend.

```bash
git clone git@github.com:aksika/abmind.git
cd abmind
npm install && npm run build
node dist/cli/abmind.js install
abmind update
```

Then use:
```bash
abmind recall --translated "keyword1,keyword2" --chat-id aksika
abmind store --translated "English content" --original "eredeti" --memory-type fact
abmind mcp        # starts MCP server on stdio
abmind sleep      # run a sleep maintenance cycle
abmind status     # lifecycle version + lock state
abmind memory-stats    # memory counts, DB size
```

### (b2) Native host integration (Claude Code / Gemini CLI)

One command installs abmind hooks + MCP + context file into your AI tool:

```bash
abmind install-host claude    # Claude Code
abmind install-host gemini    # Gemini CLI
```

What it does:
- **Claude Code:** Merges lifecycle hooks into `~/.claude/settings.json`, symlinks `CLAUDE.md` for ground-truth context
- **Gemini CLI:** Copies `hooks.json` to `~/.gemini/hooks/`, enables `tools.enableHooks`, symlinks `GEMINI.md`

Both register the `abmind mcp` server for mid-turn tool access (`memory_recall`, `memory_store`, etc.).

Safe to re-run (idempotent). Backs up existing settings before modifying. To remove:

```bash
abmind install-host claude --uninstall
abmind install-host gemini --uninstall
```

**Prerequisites:** abmind must be installed and on `$PATH` first (see Option B or C above).

### (b3) With Hermes-Agent (memory provider plugin)

abmind implements Hermes's `MemoryProvider` ABC — automatic recall/store on every turn, no tool calls needed.

```bash
# 1. Install abmind
npm install -g abmind && abmind install

# 2. Copy plugin to Hermes
mkdir -p ~/.hermes/plugins/abmind
cp <abmind-repo>/hermes-plugin/__init__.py <abmind-repo>/hermes-plugin/plugin.yaml ~/.hermes/plugins/abmind/

# 3. Configure ~/.hermes/config.yaml:
#   memory:
#     provider: abmind

# 4. Set env vars in your hermes .env:
#   ABMIND_HOME=/path/to/.abmind
#   TELEGRAM_HOME_CHANNEL=<your-chat-id>  (used as ABMIND_USER_ID)

# 5. Verify
hermes memory status    # should show "abmind" as active provider
```

What you get:
- Automatic recall injected before every turn (full 7-layer pipeline via hook-recall)
- Automatic turn recording after every response
- Pre-compress capture (saves context before Hermes discards it)
- `abmind_recall` + `abmind_store` tools for explicit agent use
- Nightly sleep auto-registered if running `hermes gateway`

Requirements: Node.js 22+, `abmind` on PATH, `ABMIND_HOME` env var set.

Known limitation: Hermes does not call `prefetch()` on the first turn of a new session. First turn gets wake-up context only (~200 chars). Subsequent turns get full recall.

See `hermes-plugin/README.md` for full details.

### (c) With OpenClaw (plugin — replaces lossless-claw)

abmind registers as both a `memory-capability` plugin AND a `ContextEngine` (drop-in replacement for `@martian-engineering/lossless-claw`).

```bash
# 1. Create extension directory
mkdir -p ~/.openclaw/extensions/abmind
cd ~/.openclaw/extensions/abmind

# 2. Install abmind + required peer dep from npm
npm init -y
npm install abmind @sinclair/typebox

# 3. Set ESM module type
node -e "const p=require('./package.json'); p.type='module'; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2)+'\n')"

# 4. Create entry point
echo 'export { register } from "abmind/openclaw-plugin";' > index.js

# 5. Copy plugin manifest (not included in npm package yet)
curl -sO https://raw.githubusercontent.com/aksika/abmind/dev/openclaw.plugin.json

# 6. Patch package.json exports (until next npm publish includes it)
node -e "
const p=require('./node_modules/abmind/package.json');
p.exports['./openclaw-plugin']={types:'./dist/src/openclaw-plugin/index.d.ts',default:'./dist/src/openclaw-plugin/index.js'};
require('fs').writeFileSync('./node_modules/abmind/package.json',JSON.stringify(p,null,2)+'\n');
"
```

**Configure `~/.openclaw/openclaw.json`:**

```jsonc
{
  "plugins": {
    // Add abmind to the allowlist, remove lossless-claw
    "allow": ["abmind", /* ...your other plugins... */],

    // Set the memory slot to abmind
    "slots": {
      "memory": "abmind"
    },

    // Plugin config + hook permissions
    "entries": {
      "abmind": {
        "config": {
          "autoRecall": true,
          "autoCapture": true,
          "autoRecallMaxResults": 3,
          "autoRecallMinScore": 0.3,
          "sleepEnabled": true,
          "abmlVersion": "plain"
        },
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  },

  "tools": {
    // Add abmind tools to the allowlist
    "allow": ["abmind_recall", "abmind_store", /* ...your other tools... */]
  }
}
```

**Verify:**
```bash
openclaw plugins list    # abmind should show as "enabled"
openclaw gateway         # no "hook blocked" or "Memory not initialized" errors
```

**What registers:**
- ContextEngine: ingest, assemble, compact, afterTurn (async compaction)
- Memory-capability: promptBuilder, runtime (MemorySearchManager wrapping recallSearch), publicArtifacts
- Agent tools: `abmind_recall` + `abmind_store` — agent can search/store memories mid-turn
- Lifecycle hooks (if enabled): autoRecall (before_agent_start), autoCapture (agent_end)

**Config options** (in `plugins.entries.abmind.config`):
- `autoRecall` (bool, default false) — inject top memories before every turn
- `autoCapture` (bool, default false) — record user messages for later extraction
- `autoRecallMaxResults` (int, 1-10, default 3)
- `autoRecallMinScore` (float, 0-1, default 0.3)
- `compactionThreshold` (float, 0-1, default 0.5)
- `sleepEnabled` (bool, default true)
- `stateDir` (string, override ABMIND_HOME)
- `abmlVersion` (plain|v0|v1, default plain)

**Required config keys (easy to miss):**
- `plugins.slots.memory: "abmind"` — without this, the plugin loads but is marked "disabled (memory slot disabled)"
- `plugins.entries.abmind.hooks.allowConversationAccess: true` — without this, autoRecall/autoCapture hooks are blocked
- `tools.allow` must include `"abmind_recall"` and `"abmind_store"` — without this, the model can't call the tools even though they're registered

**Migrating from lossless-claw:**
```bash
# Remove lossless-claw from plugins.allow and tools.allow
# Remove plugins.entries.lossless-claw
# Remove lcm_grep, lcm_describe, lcm_expand_query from tools.allow

# Import existing session transcripts into abmind
abmind migrate-openclaw ~/.openclaw/agents/main/sessions/

# Or import a single session with explicit chatId:
abmind migrate-openclaw ~/.openclaw/agents/main/sessions/abc123.jsonl --chat-id my-chat
```

This reads all `.jsonl` session files, extracts text messages (skips tool results), synthesizes timestamps from file modification time, and imports into abmind's messages table. One-time operation. Run `abmind embed` afterwards for semantic search on imported messages.

**bootstrap() behavior:** The plugin's `ContextEngine.bootstrap()` returns `{ bootstrapped: false }` and directs users to the CLI migration command. No automatic import on session open — migration is explicit and user-controlled.

---

## Runtime layout (post-#158)

```
~/.abmind/
├── releases/
│   ├── 0.1.0-<sha>/dist/        # versioned, ~5 MB per release
│   └── 0.1.0-<prev-sha>/dist/   # kept for instant rollback
├── node_modules/                  # shared across releases, ~100 MB
├── current -> releases/0.1.0-<sha>
├── config/
│   └── .env.memory               # operator-owned, never overwritten by update
├── memory/
│   ├── memory.db                 # SQLite with FTS5 + trigram + embeddings
│   ├── memory.db-wal
│   ├── daily/ weekly/ quarterly/  # consolidation files (sleep output)
│   ├── sleep/                    # sleep audits + lock files
│   ├── working/ retrospectives/
│   └── context-window-start.json
├── secret/
│   └── abmind.key                # encryption key for SECRET-tier memories
├── topics/                        # topic catalog
├── prompts/
│   └── sleep/                    # sleep step prompt templates
├── bin/                           # thin wrappers (exec node current/dist/cli/...)
│   ├── abmind
│   └── abmind-embed
├── manifest.json                  # {version, commit, branch, source, migrations, ...}
└── .update.lock                   # flock pidfile during update/install
```

**Invariants:**
- `config/` is operator data. `install` seeds missing files from examples on first install only; `update` never touches it.
- `releases/` is code. Only `update`/`rollback` write here. Retention = 3 (oldest pruned).
- `node_modules/` lives outside `releases/` — shared. Rebuilt fresh on every `update`.
- `current` symlink is the atomic commit point. Flip = new version live.

---

## Lifecycle commands

| Command | Purpose |
|---|---|
| `abmind install [--upgrade] [--force]` | First-time setup. Creates dirs, seeds `config/.env.memory` from example, installs sleep prompts, creates PATH symlinks. `--upgrade` for layout migrations (none pending for abmind). `--force` to re-seed config. |
| `abmind update [--source local\|npm\|github] [--from-local]` | Build current checkout → stage → flip `current` symlink → prune old. `--from-local` overrides the stale-checkout guard. `--source npm`/`github` reserved for post-#155 publish. |
| `abmind rollback [--to <version>]` | Flip `current` back. Defaults to previous release. Refuses if `package-lock.json` hash differs (warns to rebuild from target SHA instead). |
| `abmind reset --scope <config\|config+data\|full> [--yes] [--dry-run]` | Scoped destructive reset. `config` wipes `config/`. `config+data` adds `memory/` + `topics/`. `full` removes `~/.abmind/` + PATH symlinks (backup written first unless `--no-backup`). Non-interactive requires `--yes`. |
| `abmind status` | Print manifest + lock state. Exit 1 if not installed or mismatched. |
| `abmind memory-stats` | Memory system stats (message count, memory count, DB size, per-type breakdown). |

Plus memory operations: `recall`, `store`, `edit`, `expand`, `embed`, `retro-extract`, `backfill`, `wake-up`, `sleep`, `sleep-state`, `sleep-apply`, `sleep-report`, `mcp`, `migrate-openclaw`, `list-secrets`, `encrypt-secrets`, `rekey`.

Run `abmind <cmd> --help` for per-command usage.

---

## Configuration

### `$ABMIND_HOME`

Override runtime root (default `~/.abmind`):

```bash
export ABMIND_HOME=/custom/path
abmind install
```

### `config/.env.memory`

Seeded from `config/.env.memory.example` on first install. Never overwritten by subsequent `update`.

Key settings:
- `MEMORY_MODE` — `hybrid` (FTS+trigram+embeddings+signatures, default) | `fts` (no embeddings) | `signature` (no ollama)
- `MEMORY_MAX_DB_SIZE_MB` — triggers pressure-based aging acceleration
- `OLLAMA_EMBED_MODEL`, `OLLAMA_EMBED_URL` — for hybrid mode
- `BED_TIME`, `WAKE_TIME` — sleep window (HH:MM in operator's local TZ)
- `SLEEP_QUALITY` — `budget` | `normal` | `ultimate` (affects step count + LLM call budget)

Full reference: `abproject/docs/asbuilts/config-abmind.asbuilt.md`.

### `users.json`

Optional. Location: `~/.abmind/config/users.json`. Multi-user allowlist. Falls back to `userId: "master"` if missing.

---

## Requirements

- **Node.js** 22+
- **SQLite** — bundled via better-sqlite3
- **rsync** — required by `abmind update` to dereference `file:` deps (would break `npm`-sourced deps too when that ships)

### Optional: Ollama (recommended)

Required for vector embeddings in `hybrid` mode. Without it, abmind falls back to `signature`-only search — still works but less accurate for semantic queries.

```bash
# Install
curl -fsSL https://ollama.com/install.sh | sh

# Pull embedding model
ollama pull nomic-embed-text

# For concurrent requests (main agent + subagents):
# Linux:
echo 'Environment="OLLAMA_NUM_PARALLEL=2"' | sudo tee -a /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama

# macOS:
launchctl setenv OLLAMA_NUM_PARALLEL 2 && pkill ollama
```

Configure in `.env.memory`:
```
MEMORY_MODE=hybrid
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_EMBED_URL=http://localhost:11434
```

If ollama is unreachable at boot, abmind logs a warning and continues in signature mode.

### Optional: sqlite-vec (faster vector search)

When installed, abmind uses an HNSW vector index for embedding search instead of brute-force scanning. Matters at 1K+ memories — search drops from O(n) to O(log n).

```bash
# Installs automatically as optional dependency:
npm install  # sqlite-vec is in optionalDependencies

# Verify it loaded (check abmind boot log):
abmind status  # should show "vec_memories: available"
```

If sqlite-vec fails to install (unsupported platform, missing build tools), abmind falls back to brute-force vector search silently. No action needed — it just runs slower at scale.

**Platforms supported:** Linux x64, macOS x64/arm64. Windows native not supported (use WSL).

---

## Updating

Update = build the current checkout and activate as a new release.

```bash
git pull                                # get latest source
abmind update                           # build + stage + flip symlink
```

Stale-checkout guard: `update` runs `git fetch` and refuses to proceed if your local branch is behind `origin/<branch>`. Pass `--from-local` to build from your current tree anyway.

For detached HEAD / no upstream / unpushed branches: use `--from-local`.

---

## Rolling back

```bash
abmind rollback                 # flip to previous release (instant)
abmind rollback --to 0.1.0-28f71ef   # specific version
```

If `package-lock.json` hash differs between releases, rollback refuses with:
```
Rollback via symlink is unsafe. Instead:
  git checkout <commit>
  abmind update --from-local
```
— because shared `node_modules/` won't match the old release's deps.

---

## Reset / uninstall

**Clear config only:**
```bash
abmind reset --scope config --yes
# removes ~/.abmind/config/, keeps memory + releases
```

**Clear config + memory:**
```bash
abmind reset --scope config+data --yes
# removes config/, memory/, topics/. Keeps releases (code).
```

**Full uninstall:**
```bash
abmind reset --scope full --yes
# removes ~/.abmind/ entirely AND PATH symlinks we own.
# Writes automatic backup to ~/.abmind.reset-<ts>.bak/ unless --no-backup.
```

All destructive operations:
- Support `--dry-run` to preview without executing
- Refuse to operate on unsafe targets (`/`, `$HOME`, anything outside `$HOME`)
- Require `--yes` in non-interactive mode

---

## Troubleshooting

### `abmind: command not found`

`~/.local/bin` isn't on your `$PATH`. Fix:
```bash
export PATH="$HOME/.local/bin:$PATH"
# Add to ~/.bashrc or ~/.zshrc to persist.
```
Or re-run `abmind install` — it warns + prints the exact line if missing.

### `error: Lock held by pid N`

Another `abmind update` / `install` is running. Check:
```bash
abmind status    # shows lock state
```
If stale (PID dead or >1h old), it'll be auto-stolen on next attempt.

### `disk I/O error` from memory-manager

Usually means two processes competing for `memory.db`. Common cause: running `npm test` in abmind/ while a bridge/consumer holds the DB. Stop the consumer first.

### `sqlite3_errstr: no such table: X`

Schema migration didn't complete. Check `abmind status` — version should reflect the latest migration number. Re-run `abmind update` to rebuild + re-migrate.

### Ollama warnings at boot

`nomic-embed-text not pulled` → `ollama pull nomic-embed-text`
`ollama not running` → start via systemd (Linux) or launchd (macOS).
Non-fatal — abmind degrades to signature search.

---

## Uninstalling (manual fallback)

If the CLI is itself broken:
```bash
rm -rf ~/.abmind
rm -f ~/.local/bin/abmind ~/.local/bin/abmind-embed
# Remove the git checkout if done
rm -rf ~/workspace/ab/abmind
```

---

## For package authors / CI

Non-interactive install flow (no prompts, explicit flags):
```bash
abmind install --force               # re-seed config from examples
abmind reset --scope full --yes --non-interactive --no-backup    # CI cleanup
```

Agentbridge compat check (bridge reads abmind manifest):
```bash
abmind status    # version must be compatible with bridge's package.json dep range
```

---

## See also

- `abtars/docs/install.md` — bridge install + how it consumes abmind
- `abproject/docs/plans/158-deploy-rewrite.md` — design doc for this lifecycle
- `abproject/docs/asbuilts/memory.asbuilt.md` — memory system architecture
- `abproject/docs/asbuilts/config-abmind.asbuilt.md` — full `.env.memory` reference
