# System One judgments (#1812)

abmind can ask narrow, typed yes/no and rating questions (System One models:
Choice/Score/Noul) about recall candidates, and use the answers to reorder
results. The capability is optional and off by default; when disabled or
unavailable, recall behaves exactly as without it.

Two backends sit behind one provider slot:

| Backend | Runs | Privacy | Cost |
|---------|------|---------|------|
| Jev (TypeSafe SaaS) | `https://api.typesafe.ai` | Query/candidate text leaves the box — explicit opt-in | Metered API |
| Laya (self-hosted) | Local sidecar you run | Everything stays on-box | Free, CPU-bound |

Judgments are advice: deterministic code combines them (confidence gates,
injection veto, contradiction/staleness demote) and owns the final order.
The rerank only demotes or drops — it never boosts above the base score.

## Setup

Set one selector in `~/.abmind/config/.env.memory`:

```ini
SYSTEM1=off        # off | jev | laya
SYSTEM1_RECALL=off # on enables the recall rerank (keep off until evaluated)
```

Jev additionally needs `JEV_API_KEY` (never committed or logged) and uses the
pinned `JEV_MODEL` (`jev-1.13.0`, never a `latest` alias). Laya needs the
sidecar running at `LAYA_URL` (default `http://127.0.0.1:8765`).
Restart the daemon/CLI process after changing these; there is no hot reload.
Disable by setting `SYSTEM1=off` and restarting.

## Laya sidecar

The sidecar ships in the package as `scripts/laya-server.py`. The operator
runs it — abmind never spawns it — manually or via the OS service manager,
typically at host boot:

```bash
python3 -m venv ~/.laya-venv
~/.laya-venv/bin/pip install "laya==0.3.4"
~/.laya-venv/bin/python scripts/laya-server.py
```

The first start downloads the checkpoint into the Hugging Face cache
(`~/.cache/huggingface`); later starts reuse it. The server preloads the
English checkpoint, serves `POST /predict` and `GET /health` on localhost
only, and handles one inference at a time (concurrent callers get 503 and
stay on baseline recall).

Example systemd unit (`~/.config/systemd/user/laya-sidecar.service`):

```ini
[Unit]
Description=Laya System One sidecar for abmind
After=network-online.target

[Service]
ExecStart=%h/.laya-venv/bin/python /path/to/abmind/scripts/laya-server.py
Restart=on-failure

[Install]
WantedBy=default.target
```

Example launchd plist (`~/Library/LaunchAgents/ai.abmind.laya-sidecar.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.abmind.laya-sidecar</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/.laya-venv/bin/python</string>
    <string>/path/to/abmind/scripts/laya-server.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

## Privacy

- Enabling Jev is the explicit opt-in for off-box egress. Only the English
  query text, an optional topic, and candidate text with dates are sent —
  never transcripts, credentials, hidden metadata, or extra database content.
- Candidates are re-verified under the standing visibility/classification
  policy before serialization; unverifiable rows are not judged.
- Laya traffic never leaves localhost.
- No key, URL credential, query, or memory content appears in logs, status,
  or doctor output. Failure messages carry an error class only.

## Observability

- `abmind status` shows the local `system1:` configuration (backend, model or
  endpoint, recall flag). It performs no network call and is not proof of
  endpoint health.
- `abmind doctor` checks configuration and endpoint reachability through the
  daemon (`system1-config`, `system1-reachable`). The Jev probe is a single
  synthetic question made only by the manual doctor run and costs a few
  tokens. A missing sidecar or key is a warning, not an error; doctor never
  installs, starts, or repairs anything here.
- Boot logs one `system1:` line (backend and model, or disabled) without
  probing the network.
