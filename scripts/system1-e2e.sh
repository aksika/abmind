#!/usr/bin/env bash
# scripts/system1-e2e.sh — explicit E2E lane for #1812 (never in npm test).
#
# Real production composition against scratch homes: packaged sidecar + real
# Laya weights, foreground daemon, real CLI store/recall, real status/doctor
# output, and the kill-sidecar fallback. Nothing here runs by default;
# invoke directly:
#
#   bash scripts/system1-e2e.sh [--port N] [--keep]
#
# Prerequisites: python3 with laya==0.3.4 (`pip install "laya==0.3.4"`),
# node/npm, and the Hugging Face weight cache (the first sidecar start
# downloads ~2 GB; later runs reuse it). Exits non-zero on the first
# failed assertion. Scratch homes are removed unless --keep is given.
#
# Exit codes: 0 pass, 1 assertion/infra failure.

set -euo pipefail
cd "$(dirname "$0")/.."

PORT="18765"
KEEP=""
for arg in "$@"; do
  case "$arg" in
    --port=*) PORT="${arg#--port=}" ;;
    --keep) KEEP="1" ;;
    *) echo "usage: bash scripts/system1-e2e.sh [--port=N] [--keep]"; exit 1 ;;
  esac
done

TMPHOME="$(mktemp -d)"
SIDELOG="$TMPHOME/sidecar.log"
DAEMONLOG="$TMPHOME/daemon.log"
SIDECAR_PID=""
DAEMON_PID=""

cleanup() {
  for pidvar in DAEMON_PID SIDECAR_PID; do
    local pid="${!pidvar}"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  if [ -z "$KEEP" ]; then rm -rf "$TMPHOME"; else echo "kept: $TMPHOME"; fi
}
trap cleanup EXIT

fail() { echo "  ✗ FAIL $1"; exit 1; }
pass() { echo "  ✓ $1"; }

export ABMIND_HOME="$TMPHOME"
export ABMIND_USER_ID="e2e-user"
export SYSTEM1="laya"
export LAYA_URL="http://127.0.0.1:$PORT"
export SYSTEM1_RECALL="on"

echo "── Prerequisites ──"
python3 -c "import laya; assert laya.__version__ == '0.3.4', laya.__version__" \
  || fail "python3 needs laya==0.3.4 (pip install \"laya==0.3.4\")"
pass "python3 has laya $(python3 -c "import laya; print(laya.__version__)")"

echo "── Build + native deps ──"
npm run build --silent > /dev/null || fail "npm run build"
node dist/cli/abmind.js deps install > /dev/null 2>&1 || fail "abmind deps install"
pass "build + native deps"

echo "── Scratch install ──"
# The daemon-service step does not come up in a scratch home; install is
# accepted when it completes and seeds memory.db.
node dist/cli/abmind.js install --non-interactive > "$TMPHOME/install.log" 2>&1 || true
grep -q "abmind install complete" "$TMPHOME/install.log" || { tail -5 "$TMPHOME/install.log"; fail "abmind install"; }
[ -f "$TMPHOME/memory/memory.db" ] || fail "memory.db missing"
pass "install into $TMPHOME"

echo "── Start packaged sidecar ──"
python3 scripts/laya-server.py --port "$PORT" > "$SIDELOG" 2>&1 &
SIDECAR_PID="$!"
ready=""
for _ in $(seq 1 45); do
  if curl -sf "http://127.0.0.1:$PORT/health" | grep -q '"status": *"ready"'; then ready="1"; break; fi
  sleep 2
done
[ -n "$ready" ] || { tail -5 "$SIDELOG"; fail "sidecar not ready"; }
pass "sidecar ready (pid $SIDECAR_PID)"

echo "── Start foreground daemon ──"
node dist/cli/abmind-daemon.js --foreground --socket "$TMPHOME/run/abmind.sock" > "$DAEMONLOG" 2>&1 &
DAEMON_PID="$!"
up=""
for _ in $(seq 1 30); do
  if node dist/cli/abmind.js recall --translated "warmup" --user-id e2e-user --limit 1 > /dev/null 2>&1; then up="1"; break; fi
  sleep 2
done
[ -n "$up" ] || { tail -5 "$DAEMONLOG"; fail "daemon not ready"; }
pass "daemon ready (pid $DAEMON_PID)"

echo "── Seed memories ──"
seed() {
  node dist/cli/abmind.js store --translated "$1" --content-original "X" \
    --memory-type fact --emotion-score 0 --user-id e2e-user 2>/dev/null | grep -q '"stored": *true'
}
seed "Production deploys run via slash-deploy prod after CI" || fail "store 1"
seed "Tuesday lesson deploys fail when CI is skipped" || fail "store 2"
seed "The user prefers dark mode in the dashboard" || fail "store 3"
pass "3 memories stored"

echo "── Baseline recall (judging off) ──"
SYSTEM1_RECALL=off node dist/cli/abmind.js recall --translated "deploy" --user-id e2e-user --limit 10 > "$TMPHOME/baseline.json" || fail "baseline recall"
python3 -c "import json;d=json.load(open('$TMPHOME/baseline.json'));assert isinstance(d,list) and len(d)>0,d" || fail "baseline empty"
pass "baseline recall works"

echo "── Judged recall (sidecar live) ──"
node dist/cli/abmind.js recall --translated "deploy" --user-id e2e-user --limit 10 > "$TMPHOME/judged.json" || fail "judged recall"
python3 -c "import json;d=json.load(open('$TMPHOME/judged.json'));assert isinstance(d,list) and len(d)>0,d" || fail "judged empty"
grep -q "predict q=" "$SIDELOG" || fail "sidecar saw no predict call"
pass "judged recall works; sidecar served predict calls"

echo "── Status reflects the backend ──"
node dist/cli/abmind.js status 2>/dev/null | grep -q "system1:.*laya" || fail "status shows laya"
pass "status shows laya"

echo "── Doctor validates the live backend ──"
# Doctor exits 1/2 on warnings/errors by design; assert on the JSON content.
node dist/cli/abmind.js doctor --json > "$TMPHOME/doctor.json" 2>/dev/null || true
python3 -c "
import json,sys
checks={c['name']:c for c in json.load(open('$TMPHOME/doctor.json'))['checks']}
assert checks.get('system1 config',{}).get('status')=='ok',checks.get('system1 config')
assert checks.get('system1 reachable',{}).get('status')=='ok',checks.get('system1 reachable')
" || fail "doctor system1 checks"
pass "doctor reports system1 configured and reachable"

echo "── Kill sidecar: recall degrades, doctor warns, nothing breaks ──"
kill "$SIDECAR_PID" 2>/dev/null || true
wait "$SIDECAR_PID" 2>/dev/null || true
SIDECAR_PID=""; sleep 1
node dist/cli/abmind.js recall --translated "deploy" --user-id e2e-user --limit 10 > "$TMPHOME/fallback.json" || fail "fallback recall"
python3 -c "import json;d=json.load(open('$TMPHOME/fallback.json'));assert isinstance(d,list) and len(d)>0,d" || fail "fallback empty"
node dist/cli/abmind.js doctor --json > "$TMPHOME/doctor-down.json" 2>/dev/null || true
python3 -c "
import json
checks={c['name']:c for c in json.load(open('$TMPHOME/doctor-down.json'))['checks']}
assert checks.get('system1 reachable',{}).get('status')=='failed',checks.get('system1 reachable')
" || fail "doctor warns on down sidecar"
pass "fallback recall works; doctor warns on down sidecar"

echo ""
echo "E2E PASS: system1 laya journey (sidecar, daemon, recall, status, doctor, fallback)"
