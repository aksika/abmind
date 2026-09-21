#!/usr/bin/env bash
# scripts/hermes-e2e.sh — explicit E2E lane for the Hermes provider (#1383/#1823).
# Never part of `npm test`; invoke directly:
#
#   bash scripts/hermes-e2e.sh [--hermes-dir=PATH] [--python=BIN] [--keep]
#
# Two passes against scratch homes:
#   1. stub lane   — real Hermes MemoryManager + provider + scripted bridge
#                    (wire-level assertions; no daemon needed)
#   2. real lane   — the same harness against a real foreground daemon, a real
#                    `abmind bridge` process, real SQLite, and a
#                    launcher-shaped PATH shim so the provider's bridge
#                    derivation is exercised for real (capture, checkpoint
#                    convergence, leased-runtime lease flow)
#
# Prerequisites: node/npm, a python 3.11+ with no extra packages, and a
# hermes-agent checkout (default ~/workspace/hermes-agent, or --hermes-dir).
# Scratch homes are removed unless --keep. Exit codes: 0 pass, 1 failure.

set -euo pipefail
cd "$(dirname "$0")/.."

HERMES_DIR="${HERMES_AGENT_DIR:-$HOME/workspace/hermes-agent}"
PYTHON_BIN=""
KEEP=""
for arg in "$@"; do
  case "$arg" in
    --hermes-dir=*) HERMES_DIR="${arg#--hermes-dir=}" ;;
    --python=*) PYTHON_BIN="${arg#--python=}" ;;
    --keep) KEEP="1" ;;
    *) echo "usage: bash scripts/hermes-e2e.sh [--hermes-dir=PATH] [--python=BIN] [--keep]"; exit 1 ;;
  esac
done

pass() { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; exit 1; }

TMPHOME="$(mktemp -d)"
DAEMONLOG="$TMPHOME/daemon.log"
DAEMON_PID=""
SHIMDIR="$TMPHOME/shim"
SOCK="$TMPHOME/run/abmind.sock"

cleanup() {
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  if [ -z "$KEEP" ]; then rm -rf "$TMPHOME"; else echo "kept: $TMPHOME"; fi
}
trap cleanup EXIT

echo "── Prerequisites ──"
command -v node > /dev/null || fail "node not found"
command -v npm > /dev/null || fail "npm not found"
if [ -z "$PYTHON_BIN" ]; then
  for cand in python3.12 python3.11 python3; do
    if command -v "$cand" > /dev/null 2>&1 &&
       "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
      PYTHON_BIN="$cand"; break
    fi
  done
fi
[ -n "$PYTHON_BIN" ] || fail "python 3.11+ not found (pass --python=BIN)"
[ -d "$HERMES_DIR/agent" ] || fail "no hermes-agent checkout at $HERMES_DIR (pass --hermes-dir=PATH)"
pass "node $(node --version), $PYTHON_BIN, hermes at $HERMES_DIR"

echo "── Build + native deps ──"
npm run build --silent > /dev/null || fail "npm run build"
node dist/cli/abmind.js deps install > /dev/null 2>&1 || fail "abmind deps install"
pass "build + native deps"

echo "── Scratch install ──"
export ABMIND_HOME="$TMPHOME"
export ABMIND_USER_ID="e2e-user"
export ABMIND_ENDPOINT="$SOCK"
node dist/cli/abmind.js install --non-interactive > "$TMPHOME/install.log" 2>&1 || true
grep -q "abmind install complete" "$TMPHOME/install.log" || { tail -5 "$TMPHOME/install.log"; fail "abmind install"; }
[ -f "$TMPHOME/memory/memory.db" ] || fail "memory.db missing"
pass "install into $TMPHOME"

# Launcher-shaped shim: the provider derives the bridge from an `abmind`
# command on PATH exactly as a standalone install would.
mkdir -p "$SHIMDIR"
cat > "$SHIMDIR/abmind" <<EOF
#!/bin/sh
exec node "$PWD/dist/cli/abmind.js" "\$@"
EOF
chmod +x "$SHIMDIR/abmind"
pass "PATH shim at $SHIMDIR/abmind"

echo "── Stub lane (no daemon, scripted bridge) ──"
HERMES_AGENT_DIR="$HERMES_DIR" "$PYTHON_BIN" hermes-plugin/tests/test_provider_contract.py || fail "stub lane"
pass "stub lane green"

echo "── Start foreground daemon ──"
node dist/cli/abmind-daemon.js --foreground --socket "$SOCK" \
  --lifecycle-write-owners e2e-user >> "$DAEMONLOG" 2>&1 &
DAEMON_PID="$!"
ready=""
for _ in $(seq 1 30); do
  if PATH="$SHIMDIR:$PATH" abmind recall --translated warmup --user-id e2e-user --limit 1 > /dev/null 2>&1; then
    ready="1"; break
  fi
  sleep 2
done
[ -n "$ready" ] || { tail -5 "$DAEMONLOG"; fail "daemon not ready"; }
pass "daemon ready (pid $DAEMON_PID)"

echo "── Real lane (real bridge + daemon + SQLite) ──"
PATH="$SHIMDIR:$PATH" \
HERMES_AGENT_DIR="$HERMES_DIR" \
ABMIND_E2E_BRIDGE=real \
ABMIND_E2E_PRINCIPAL=e2e-user \
ABMIND_SOCKET="$SOCK" \
"$PYTHON_BIN" hermes-plugin/tests/test_provider_contract.py || {
  echo "  daemon log tail:"; tail -10 "$DAEMONLOG"
  fail "real lane"
}
pass "real lane green"

echo ""
echo "E2E PASS: Hermes provider (stub wire contract + real daemon composition)"
