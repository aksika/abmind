#!/bin/sh
# repair-cli.sh — independent emergency repair for abmind standalone CLI.
#
# Invoked with `sh "$ABMIND_HOME/scripts/repair-cli.sh"`. Its own mode is
# irrelevant. Reconstructs launcher permissions and the public command/module
# links solely from the already-active release. It does NOT call abmind,
# execute the JavaScript entrypoint, import abtars, run npm, or infer an nvm
# prefix.
#
# Exit codes: 0 = restored, 1 = missing/inactive current, 2 = broken current,
#             3 = foreign (non-abmind) file at a public path
set -eu

ABMIND_HOME="${ABMIND_HOME:-$HOME/.abmind}"
CURRENT_LINK="${ABMIND_HOME}/packages/standalone/current"
PUBLIC_BIN="${HOME}/.local/bin/abmind"
PUBLIC_MOD="${HOME}/.local/lib/node_modules/abmind"
LAUNCHER_MARKER="# abmind-standalone-launcher:v1"

err() { printf 'ERROR: %s\n' "$1" >&2; }

# Atomic symlink replacement: create a temp link beside the target path, then
# rename() it into place. rename is atomic on the same filesystem and replaces
# any existing entry. Temp lives in the link's own directory to guarantee the
# same filesystem.
atomic_ln() {
    _tgt="$1"; _lnk="$2"; _dir="."
    case "$_lnk" in
        */*) _dir="${_lnk%/*}" ;;
    esac
    _tmp="${_dir}/.abmind-repair-ln.$$"
    if ! ln -s "$_tgt" "$_tmp"; then
        rm -f "$_tmp"; return 1
    fi
    if ! mv -f "$_tmp" "$_lnk"; then
        rm -f "$_tmp"; return 1
    fi
}

# ── Validate the active release chain ─────────────────────────────────────
if [ ! -L "$CURRENT_LINK" ]; then
    err "current symlink missing or not a symlink: $CURRENT_LINK"
    exit 1
fi

CURRENT_TARGET="$(readlink "$CURRENT_LINK")"
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

# ── Repair launcher mode (only the launcher needs +x) ─────────────────────
chmod 0755 "$LAUNCHER"

# ── Recreate the public command link ──────────────────────────────────────
LINK_TARGET="$LAUNCHER"
PUBLIC_BIN_DIR="$(dirname "$PUBLIC_BIN")"
mkdir -p "$PUBLIC_BIN_DIR"
if [ -L "$PUBLIC_BIN" ] || [ ! -e "$PUBLIC_BIN" ]; then
    atomic_ln "$LINK_TARGET" "$PUBLIC_BIN"
elif [ -f "$PUBLIC_BIN" ] && grep -q "$LAUNCHER_MARKER" "$PUBLIC_BIN" 2>/dev/null; then
    # abmind-owned marked regular launcher — safe to replace.
    atomic_ln "$LINK_TARGET" "$PUBLIC_BIN"
elif [ -f "$PUBLIC_BIN" ]; then
    err "foreign file at public bin path: $PUBLIC_BIN"
    exit 3
else
    err "unexpected filesystem object at public bin path: $PUBLIC_BIN"
    exit 3
fi

# ── Recreate the public module link ───────────────────────────────────────
MOD_TARGET="${RELEASE_DIR}/node_modules/abmind"
PUBLIC_MOD_DIR="$(dirname "$PUBLIC_MOD")"
mkdir -p "$PUBLIC_MOD_DIR"
if [ -L "$PUBLIC_MOD" ] || [ ! -e "$PUBLIC_MOD" ]; then
    atomic_ln "$MOD_TARGET" "$PUBLIC_MOD"
elif [ -d "$PUBLIC_MOD" ]; then
    # A real directory (symlinks handled above). Only replace if it already
    # points into the standalone tree.
    _cur="$(readlink "$PUBLIC_MOD" 2>/dev/null || true)"
    if printf '%s' "$_cur" | grep -qF "${ABMIND_HOME}/packages/standalone/" 2>/dev/null; then
        atomic_ln "$MOD_TARGET" "$PUBLIC_MOD"
    else
        err "foreign directory at public module path: $PUBLIC_MOD"
        exit 3
    fi
else
    err "unexpected filesystem object at public module path: $PUBLIC_MOD"
    exit 3
fi

# ── Final verification of both link chains ────────────────────────────────
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

if [ ! -L "$PUBLIC_MOD" ]; then
    err "public module link not restored: $PUBLIC_MOD"
    exit 1
fi
MOD_RESOLVED="$(readlink "$PUBLIC_MOD")"
if [ "$MOD_RESOLVED" != "$MOD_TARGET" ]; then
    err "public module link points to wrong target: $MOD_RESOLVED"
    exit 2
fi

exit 0
