# Laya sidecar

[Laya](https://github.com/NandhaKishorM/laya) is the self-hosted backend for
[System One judgments](judgment.md). It runs as a small HTTP service on the same
machine as abmind — the "sidecar" — and answers typed `choice` / `score` /
`noul` questions about recall candidates. Everything stays on loopback, so no
memory content ever leaves the host.

abmind never starts or supervises the sidecar. You install it, run it (ideally
as an OS service), and point abmind at it. If the sidecar is missing or not
ready, abmind falls back silently to baseline recall — nothing breaks, and no
data is lost.

## Requirements

- Python 3.10+ with `venv`
- A few GB of free disk for the model checkpoint and a few GB of RAM while the
  sidecar runs (the model stays resident for the process lifetime)
- macOS (Apple Silicon uses the GPU via MPS) or Linux (CPU-only works, slower)
- No network access is needed after the first start

## 1. Install

```bash
python3 -m venv ~/.laya-venv
~/.laya-venv/bin/pip install --upgrade pip
~/.laya-venv/bin/pip install laya
```

Laya is early-stage, so the package and checkpoint versions are deliberately
not pinned. To install from a source checkout instead, use
`~/.laya-venv/bin/pip install /path/to/laya` (or a git URL) in place of
`pip install laya`.

The sidecar script ships with abmind: `scripts/laya-server.py` in the installed
package or source checkout. Save its path — the service definitions below refer
to it as `<abmind-dir>/scripts/laya-server.py`.

## 2. First start (checkpoint download)

Run it once in the foreground to fetch the checkpoint and confirm the device:

```bash
~/.laya-venv/bin/python <abmind-dir>/scripts/laya-server.py
```

Useful options:

| Option | Default | Notes |
|---|---|---|
| `--host` | `127.0.0.1` | Keep loopback; the sidecar is not designed to be exposed |
| `--port` | `8765` | Must match `LAYA_URL` if changed |
| `--model` | `convaiinnovations/laya` | Any Laya checkpoint, e.g. `convaiinnovations/laya-multilingual` |
| `--device` | auto | `mps`, `cuda`, or `cpu` |

The first start downloads the checkpoint (a few GB) into the Hugging Face cache
(`~/.cache/huggingface`); later starts reuse it offline and are much faster.
Stdout shows progress and readiness:

```
loading convaiinnovations/laya (laya 0.3.4)...
ready in 55.5s on mps; serving 127.0.0.1:8765
```

Stop it with Ctrl-C once startup is confirmed.

## 3. Run it as a service

Managed (recommended): `abmind service install` installs and starts the
sidecar unit automatically when `SYSTEM1=laya`, then starts the daemon only
after the sidecar is healthy — the first recall already gets judgments. The
manual definitions below are the fallback when the service manager is
unavailable.

### macOS (launchd)

Create `~/Library/LaunchAgents/ai.abmind.laya-sidecar.plist`, replacing
`<home>` with the account's home directory (launchd does not expand `~`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.abmind.laya-sidecar</string>
  <key>ProgramArguments</key>
  <array>
    <string>&lt;home&gt;/.laya-venv/bin/python</string>
    <string>&lt;abmind-dir&gt;/scripts/laya-server.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.abmind.laya-sidecar.plist
launchctl list | grep laya
```

Add `StandardOutPath` / `StandardErrorPath` keys if you want persistent logs.

### Linux (systemd user unit)

Create `~/.config/systemd/user/laya-sidecar.service`:

```ini
[Unit]
Description=Laya System One sidecar for abmind
After=network-online.target

[Service]
ExecStart=%h/.laya-venv/bin/python <abmind-dir>/scripts/laya-server.py
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now laya-sidecar
```

## 4. Point abmind at it

The defaults already target the sidecar, so normally there is nothing to
configure:

```ini
# ~/.abmind/config/.env.memory — only needed to change defaults
SYSTEM1=laya                      # laya | jev | off
SYSTEM1_RECALL=on                 # rerank recall candidates with judgments
LAYA_URL=http://127.0.0.1:8765    # must be a bare loopback URL
```

abmind probes the sidecar once at boot and there is no hot reload, so restart
the daemon after starting or changing the sidecar:

```bash
abmind service restart
```

## 5. Verify

```bash
curl -s http://127.0.0.1:8765/health
# {"status":"ready","model":"...","layaVersion":"...","device":"...","contractVersion":1}
# returns 503 with "warming" until the model is loaded

abmind status    # system1: laya 127.0.0.1:8765 (recall on, ...)
abmind service status  # daemon + laya sidecar unit state (loaded + pid)
abmind doctor    # system1 config / system1 reachable: laya healthy
```

The daemon log also records which backend it booted with:

```
[memory-manager] system1: laya http://127.0.0.1:8765/
[memory-manager] system1: disabled (sidecar unreachable)   # fallback case
```

## Operations

- **Update laya:** stop the service, `~/.laya-venv/bin/pip install -U laya`,
  start it again. A newer package may select a newer checkpoint on first start.
- **Change checkpoint:** set `--model` in the service definition and restart.
- **Concurrency:** the sidecar handles one inference at a time; concurrent
  callers get `503` and stay on baseline recall for that turn.
- **Failure mode:** sidecar down or warming means baseline recall — recall never
  blocks on judgments.
- **Privacy:** traffic is loopback-only and request bodies are never logged.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/health` returns `503` with `warming` | Checkpoint still loading; wait and retry |
| `system1: disabled (sidecar unreachable)` at boot | Service not running, wrong port, or `LAYA_URL` mismatch; check the service and `curl /health` |
| `503 busy` on `/predict` | Another inference is in flight; expected under concurrency |
| `413` / `400` from `/predict` | Malformed or oversize request body; see the contract in [System One judgments](judgment.md) |
| Model load fails or runs out of memory | Reduce RAM pressure, or use `--device cpu` as a fallback |
