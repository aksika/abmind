# abmind — Hermes-Agent Memory Plugin

Persistent cross-session memory for [Hermes-Agent](https://github.com/NousResearch/hermes-agent) via [abmind](https://github.com/aksika/abmind).

## What you get

- **Automatic recall** — relevant memories injected before every turn (no tool call needed)
- **Automatic recording** — every conversation turn stored automatically
- **Pre-compress capture** — saves context before Hermes discards it during compaction
- **Memory tools** — `abmind_recall` + `abmind_store` for explicit agent use
- **Sleep cycles** — nightly maintenance (extract facts, consolidate, detect contradictions)
- **Encrypted secrets** — class 3 memories encrypted at rest

## Install

```bash
# 1. Install abmind (if not already)
curl -fsSL https://raw.githubusercontent.com/aksika/abmind/main/scripts/install-standalone.sh -o install-standalone.sh
sh install-standalone.sh
abmind install

# 2. Copy plugin to Hermes
mkdir -p ~/.hermes/plugins/abmind
cp hermes-plugin/__init__.py hermes-plugin/plugin.yaml hermes-plugin/SKILL.md hermes-plugin/config_schema.py hermes-plugin/cli.py ~/.hermes/plugins/abmind/

# 3. Configure Hermes
# Add to ~/.hermes/config.yaml:
#   memory:
#     provider: abmind
#     abmind:
#       mode: local              # or: remote
#       socket_path: ~/.abmind/run/abmind.sock
#       # remote_profile: myprofile   # remote mode only
#       # principal: myuser       # default: Hermes user id
# Settings resolve as: ABMIND_* env > dashboard panel
# ($HERMES_HOME/abmind/config.json) > memory.abmind in config.yaml.
# The bridge is found automatically from the installed `abmind`
# (ABMIND_BRIDGE_BIN overrides a custom layout).
# Env overrides: ABMIND_MODE, ABMIND_SOCKET, ABMIND_REMOTE_PROFILE,
# ABMIND_PRINCIPAL, ABMIND_BRIDGE_BIN, ABMIND_RECALL_LIMIT,
# ABMIND_RECALL_MAX_CHARS, ABMIND_FALLBACK (cli to opt into legacy fallback)
#
# The daemon must enable this principal for automatic capture, e.g.:
#   abmind daemon --lifecycle-write-owners myuser

# 4. Verify
hermes memory status    # should show "abmind" as active provider
```

## Known limitations

- Hermes does not validate `requires_bins` in plugin.yaml. If neither
  `abmind-client-bridge` nor `abmind` is on PATH, the provider stays inert
  (see `unavailable_reason`). Ensure one of them resolves before starting.
- Recall tools need no configuration beyond the provider itself.

## Sleep (memory maintenance)

## Sleep (memory maintenance)

**If using `hermes gateway`** (daemon mode): one maintenance agent job is
auto-registered on first primary-session run (03:00 daily, via the real cron
API, one job per profile+owner). The scheduled agent opens a runtime lease,
starts a sleep run when idle, serves bounded completion requests, and closes
the lease. Never the legacy `abmind sleep` CLI, and no per-session trigger.

**If using CLI only**: scheduling is unavailable; the provider logs that and
does nothing. Do not add a second timer.

**If using CLI only**: add to your system cron:
```bash
crontab -e
# Add: 0 3 * * * abmind sleep --level normal
```

## Verification

Two lanes, neither part of `npm test`:

- `python3.12 tests/test_provider_contract.py` (from the plugin directory, with
  `HERMES_AGENT_DIR` set) — real Hermes `MemoryManager` + provider + scripted
  bridge; asserts the wire contract (identity, policy bounds, execution/author
  binding, idempotency, no suppression refs or attribution) without a daemon.
- `bash scripts/hermes-e2e.sh` — adds the real composition: scratch install,
  foreground daemon, launcher-shaped `abmind` shim, real bridge process and
  SQLite, capture/checkpoint outcomes, and a bounded sleep-runtime lease flow.
  Options: `--hermes-dir=PATH`, `--python=BIN`, `--keep`.



- `abmind` installed and on `$PATH`
- Node.js 22+ (for abmind)
- Optional: ollama with `nomic-embed-text` (for semantic search)

## How it works

| Event | What happens |
|-------|-------------|
| Session start | Wake-up context injected (recent facts, profile) |
| Before each turn | Relevant memories recalled and injected |
| After each turn | Turn recorded in background |
| Context compression | Messages checkpointed durably before discard (strict mode keeps the transcript on failure) |
| Session end | No-op by design — extraction runs on the sleep scheduler |
| Nightly (cron) | Full sleep cycle — extract, consolidate, age |
