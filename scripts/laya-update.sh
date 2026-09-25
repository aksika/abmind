#!/usr/bin/env bash
# scripts/laya-update.sh — upgrade the laya package and restart the sidecar.
#
# `abmind deps update` only touches native Node deps; the Laya model server
# lives in a Python venv ($HOME/.laya-venv) and a supervisor unit, so it needs
# its own update path. This script upgrades the package in place (safe while
# the sidecar runs — the old process keeps its loaded weights), restarts the
# supervised sidecar to load the new version, and polls /health until the
# reported layaVersion changes. Judgments fail closed to baseline while the
# sidecar is down, so the restart is safe on a live host.
#
#   bash scripts/laya-update.sh [--port N] [--url URL]
#
# Exit codes: 0 updated and serving the new version, 1 on failure,
# 2 package updated but no supervisor found (restart the sidecar manually).
#
# Prerequisites: the venv per docs/wiki/laya.md ($HOME/.laya-venv).

set -euo pipefail

PORT="8765"
URL=""
for arg in "$@"; do
  case "$arg" in
    --port=*) PORT="${arg#--port=}" ;;
    --url=*) URL="${arg#--url=}" ;;
    *) echo "usage: bash scripts/laya-update.sh [--port=N] [--url=URL]"; exit 1 ;;
  esac
done
if [ -z "$URL" ]; then URL="http://127.0.0.1:${PORT}"; fi

VENV_PY="${HOME}/.laya-venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
  echo "laya venv missing at ${VENV_PY} — create it per docs/wiki/laya.md" >&2
  exit 1
fi

old_pkg="$("$VENV_PY" -c "import laya; print(getattr(laya,'__version__','unknown'))" 2>/dev/null || echo unknown)"
old_serving="$(curl -s -m 5 "${URL}/health" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('layaVersion','down'))" 2>/dev/null || echo down)"
echo "package: ${old_pkg}  serving: ${old_serving}"

echo "upgrading laya package..."
"$VENV_PY" -m pip install -U laya
new_pkg="$("$VENV_PY" -c "import laya; print(getattr(laya,'__version__','unknown'))")"
echo "package now: ${new_pkg}"
if [ "$new_pkg" = "$old_pkg" ]; then
  echo "already up to date (${new_pkg}); restarting anyway to resync the process."
fi

restarted=""
if command -v launchctl >/dev/null 2>&1 && launchctl list 2>/dev/null | grep -q "ai.abmind.laya-sidecar"; then
  launchctl kickstart -k "gui/$(id -u)/ai.abmind.laya-sidecar"
  restarted="launchd"
elif command -v systemctl >/dev/null 2>&1 && systemctl --user list-units --full --all 2>/dev/null | grep -q "laya-sidecar.service"; then
  systemctl --user restart laya-sidecar.service
  restarted="systemd"
fi
if [ -z "$restarted" ]; then
  echo "package updated to ${new_pkg} but no supervised sidecar found;" >&2
  echo "restart the sidecar manually to load it." >&2
  exit 2
fi
echo "restarted via ${restarted}; waiting for ${new_pkg} to serve..."

for _ in $(seq 1 90); do
  serving="$(curl -s -m 5 "${URL}/health" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('layaVersion','') if d.get('status')=='ready' else '')" 2>/dev/null || true)"
  if [ "$serving" = "$new_pkg" ]; then
    echo "serving: ${serving} (was ${old_serving})"
    exit 0
  fi
  sleep 2
done
echo "timed out waiting for ${new_pkg} (last seen: ${serving:-none}); check the sidecar log." >&2
exit 1
