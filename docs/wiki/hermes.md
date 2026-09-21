# Using abmind with Hermes-Agent

abmind plugs into [Hermes-Agent](https://github.com/NousResearch/hermes-agent)
as a memory provider: automatic recall before every turn, automatic turn
capture, compression-safe checkpoints, nightly sleep maintenance, and explicit
memory tools — all backed by your local abmind database. The same memories are
shared with any other abmind-connected tool, so context follows you when you
switch tools.

## What you get

| Event | What happens |
|-------|-------------|
| Session start | Recent facts and profile hydrated into context |
| Before each turn | Relevant memories recalled and injected (judged, compact) |
| After each turn | Turn recorded automatically |
| Context compression | Uncommitted messages checkpointed durably before discard |
| Nightly | One sleep run: extract, consolidate, age, detect contradictions |
| On demand | `abmind_recall` / `abmind_store` tools for explicit use |

Recalled context is fenced and labeled; injections never silently suppress
later recall, and failures always degrade to ordinary operation rather than
invented answers.

## Requirements

- Node.js 22+
- `abmind` installed ([Install](install.md)), ideally running as a service
  ([Service](service.md))
- Hermes-Agent with the memory provider slot free (one external provider at a time)

## Install

```bash
# 1. Copy the plugin into Hermes (from an abmind checkout)
mkdir -p ~/.hermes/plugins/abmind
cp hermes-plugin/__init__.py hermes-plugin/plugin.yaml \
   hermes-plugin/SKILL.md hermes-plugin/config_schema.py \
   hermes-plugin/cli.py ~/.hermes/plugins/abmind/
```

```yaml
# 2. In ~/.hermes/config.yaml:
memory:
  provider: abmind
  abmind:
    mode: local   # or: remote (see below)
```

```bash
# 3. Verify
hermes memory status     # abmind listed as the active provider
hermes abmind status     # bridge up, lifecycle ready
```

## Enabling automatic capture

Reading memories works out of the box. **Writing** (turn capture,
checkpoints, mirrors) additionally requires the daemon to name your principal
as an enabled lifecycle writer — otherwise capture is skipped with a reason,
never failed open.

Find your principal first: it defaults to your Hermes user id. Then enable it
on the daemon. If you run the daemon directly:

```bash
abmind-daemon.js --lifecycle-write-owners <principal>
```

If you run it as a managed service, set the environment in the service
definition instead (systemd override or launchd `EnvironmentVariables`):

```bash
ABMIND_LIFECYCLE_WRITE_OWNERS=<principal>
```

Restart the daemon, then check `hermes abmind status` again and confirm a
chat turn is remembered with `abmind recall --translated "<a phrase from the turn>"`.

## Configuration reference

Settings resolve in this order: `ABMIND_*` environment variables, then the
dashboard panel (`$HERMES_HOME/abmind/config.json`, written by the memory
provider panel), then `memory.abmind` in `config.yaml`. The bridge binary is
found automatically from the installed `abmind` command; `ABMIND_BRIDGE_BIN`
overrides that for custom layouts.

| Key | Env | Default | Meaning |
|-----|-----|---------|---------|
| `mode` | `ABMIND_MODE` | `local` | `local` Unix socket, or `remote` signed profile |
| `socket_path` | `ABMIND_SOCKET` | `~/.abmind/run/abmind.sock` | Local daemon socket |
| `remote_profile` | `ABMIND_REMOTE_PROFILE` | — | Remote profile name (remote mode) |
| `principal` | `ABMIND_PRINCIPAL` | Hermes user id | abmind identity to act as |
| `recall_limit` | `ABMIND_RECALL_LIMIT` | `5` | Max recall hits per turn (1–50) |
| `recall_max_chars` | `ABMIND_RECALL_MAX_CHARS` | `2000` | Max injected chars per turn |
| `fallback` | `ABMIND_FALLBACK` | `off` | `cli` opts into legacy CLI reads when the bridge is down |

The same fields are editable from the Hermes dashboard (memory provider panel).

### Remote mode

```yaml
memory:
  provider: abmind
  abmind:
    mode: remote
    remote_profile: myprofile
```

Remote connections fail closed: an authentication or transport failure never
falls back to a different local store.

## Tools

The provider registers six tools (gated by the `memory` toolset like any
provider):

- `abmind_recall` / `abmind_store` — explicit search and deliberate stores.
- `abmind_sleep` — start, status, events, cancel, resume maintenance runs.
- `abmind_sleep_runtime` — the maintenance-agent lease flow (the scheduled
  nightly job uses these; humans rarely need them).
- `abmind_operational_recall` / `abmind_operational_draft` — working memory
  (lessons and drafts under review). Drafts are proposals; nothing is
  promoted automatically. This is separate from private long-term memory.

Writes from built-in Hermes memory tools are mirrored into abmind; revisions
carrying an old text and removals are kept as reviewable observations —
nothing is silently superseded or deleted.

## Sleep (memory maintenance)

On first run in a gateway, the provider registers exactly one nightly
maintenance job (03:00) using the real cron registry — one per profile and
owner, duplicates paused automatically. The scheduled run opens its own
short-lived connection, performs a bounded maintenance pass, and closes it.
Session-end hooks never trigger sleep. In CLI-only Hermes, scheduling is
reported unavailable and nothing is registered.

## Backup

Hermes backup does not include abmind state (the live database must never be
raw-copied). Back up memory separately with `abmind backup` (see
[Backup](backup.md)).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `hermes abmind status`: no bridge binary | No `abmind` command resolves on PATH | Install abmind, or set `ABMIND_BRIDGE_BIN` for a custom layout |
| Turns are not remembered | Principal not enabled for capture | Set `ABMIND_LIFECYCLE_WRITE_OWNERS` / flag, restart daemon |
| `abmind_recall` returns nothing | Empty memory, or provider inert | Check `hermes abmind status`; store something first |
| Sleep job missing | CLI-only Hermes, or gateway cron unavailable | Expected in CLI mode; gateway registers on first primary run |
| Memory tools absent from the agent | `memory` toolset gated off | Check platform toolsets / disabled toolsets for the session |
