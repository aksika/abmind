#!/bin/sh
# repair-cli.sh — independent emergency repair for abmind standalone CLI.
# Usage: sh repair-cli.sh
# Exit codes: 0 = restored, 1 = missing/inactive current, 2 = broken current, 3 = foreign file
set -eu

ABMIND_HOME="${ABMIND_HOME:-$HOME/.abmind}"
CURRENT_LINK="${ABMIND_HOME}/packages/standalone/current"
PUBLIC_BIN="${HOME}/.local/bin/abmind"
PUBLIC_MOD="${HOME}/.local/lib/node_modules/abmind"
LAUNCHER_MARKER="# abmind-standalone-launcher:v1"

err() { printf 'ERROR: %s\n' "$1" >&2; }

if [ ! -L "$CURRENT_LINK" ]; then
    err "current symlink missing or not a symlink: $CURRENT_LINK"
    exit 1
fi

CURRENT_TARGET="$(readlink "$CURRENT_LINK")"
# Target may be absolute (standalone launcher uses absolute paths)
case "$CURRENT_TARGET" in
    /*) RELEASE_DIR="$CURRENT_TARGET" ;;
    *)  RELEASE_DIR="${ABMIND_HOME}/packages/standalone/${CURRENT_TARGET}" ;;
esac

if [ ! -d "$RELEASE_DIR" ]; then
    err "current symlink target missing: $RELEASE_DIR"
    exit 1
fi

if [ ! -f "${RELEASE_DIR}/release.json" ]; then
    err "release.json missing in: $RELEASE_DIR"
    exit 2
fi

LAUNCHER="${RELEASE_DIR}/bin/abmind"
if [ ! -f "$LAUNCHER" ]; then
    err "launcher missing: $LAUNCHER"
    exit 2
fi

if ! grep -q "$LAUNCHER_MARKER" "$LAUNCHER" 2>/dev/null; then
    err "launcher marker missing in: $LAUNCHER"
    exit 2
fi

ENTRYPOINT="${RELEASE_DIR}/node_modules/abmind/dist/cli/abmind.js"
if [ ! -f "$ENTRYPOINT" ]; then
    err "entrypoint missing: $ENTRYPOINT"
    exit 2
fi

chmod 0755 "$LAUNCHER"

LINK_TARGET="$LAUNCHER"
if [ -L "$PUBLIC_BIN" ] || [ ! -e "$PUBLIC_BIN" ]; then
    ln -sf "$LINK_TARGET" "$PUBLIC_BIN"
elif [ -f "$PUBLIC_BIN" ]; then
    if grep -q "$LAUNCHER_MARKER" "$PUBLIC_BIN" 2>/dev/null; then
        rm -f "$PUBLIC_BIN"
        ln -s "$LINK_TARGET" "$PUBLIC_BIN"
    else
        err "foreign file at public bin path: $PUBLIC_BIN"
        exit 3
    fi
else
    err "unexpected filesystem object at public bin path: $PUBLIC_BIN"
    exit 3
fi

MOD_TARGET="${RELEASE_DIR}/node_modules/abmind"
if [ -L "$PUBLIC_MOD" ] || [ ! -e "$PUBLIC_MOD" ]; then
    ln -sf "$MOD_TARGET" "$PUBLIC_MOD"
elif [ -d "$PUBLIC_MOD" ]; then
    CURRENT_MOD_TARGET="$(readlink "$PUBLIC_MOD" 2>/dev/null || echo '')"
    if echo "$CURRENT_MOD_TARGET" | grep -qF "${ABMIND_HOME}/packages/standalone/" 2>/dev/null; then
        rm -f "$PUBLIC_MOD"
        ln -s "$MOD_TARGET" "$PUBLIC_MOD"
    else
        err "foreign directory at public module path: $PUBLIC_MOD"
        exit 3
    fi
else
    err "unexpected filesystem object at public module path: $PUBLIC_MOD"
    exit 3
fi

if [ ! -L "$PUBLIC_BIN" ]; then
    err "public bin link not restored: $PUBLIC_BIN"
    exit 1
fi
BIN_TARGET="$(readlink "$PUBLIC_BIN")"
if [ "$BIN_TARGET" != "$LINK_TARGET" ]; then
    err "public bin link points to wrong target: $BIN_TARGET"
    exit 2
fi
if [ ! -f "$BIN_TARGET" ]; then
    err "public bin link target missing: $BIN_TARGET"
    exit 2
fi

exit 0
