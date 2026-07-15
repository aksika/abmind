#!/bin/sh
# install-standalone.sh — fresh-machine bootstrap for abmind standalone.
#
# Acquires ONE packaged abmind artifact (registry, or a local tarball via
# $ABMIND_BOOTSTRAP_TARBALL), extracts the installer entrypoint, and delegates
# ALL staging/activation to the TypeScript installer. The shell owns no release
# layout writes — its only writes are its private temp directory.
#
# Usage:
#   sh install-standalone.sh [--stable|--alpha|--dev [DIR]]
#
# Environment:
#   ABMIND_HOME               override ~/.abmind runtime root
#   ABMIND_BOOTSTRAP_TARBALL  bootstrap from this local .tgz instead of `npm pack`
#   ABMIND_INSTALL_ARGS       extra args for the first-time `abmind install`
#                             (e.g. "--non-interactive --passphrase x --username y")
#
# Default channel: --stable
# Exit codes: 0 = success, 1 = bad usage/prereqs, 2 = acquisition/install failed
set -eu

CHANNEL="stable"
DEV_DIR=""

while [ $# -gt 0 ]; do
    case "$1" in
        --stable) CHANNEL="stable" ;;
        --alpha) CHANNEL="alpha" ;;
        --dev)
            CHANNEL="dev"
            case "${2:-}" in
                ""|--*) ;;          # no dir → owned-dev pull mode
                *) DEV_DIR="$2"; shift ;;
            esac
            ;;
        --help|-h)
            cat <<EOF
Usage: sh install-standalone.sh [--stable|--alpha|--dev [DIR]]
  --stable   Install latest stable (default)
  --alpha    Install latest alpha
  --dev      Clone dev into \$ABMIND_HOME/src/abmind (no DIR), or build DIR as-is
EOF
            exit 0
            ;;
        *) printf 'ERROR: unknown option: %s\n' "$1" >&2; exit 1 ;;
    esac
    shift
done

err() { printf 'ERROR: %s\n' "$1" >&2; }

command -v node >/dev/null 2>&1 || { err "node is required but not installed"; exit 1; }
command -v npm >/dev/null 2>&1 || { err "npm is required but not installed"; exit 1; }

ABMIND_HOME="${ABMIND_HOME:-$HOME/.abmind}"
SCRATCH="$(mktemp -d 2>/dev/null || mktemp -d -t abmind)"
trap 'rm -rf "$SCRATCH"' EXIT
chmod 0700 "$SCRATCH"

# ── 1. Acquire the installer artifact ──────────────────────────────────────
# The installer code always comes from a packaged release. For dev, the
# installer itself clones/builds the dev tree — the bootstrap never does.
TARBALL=""
if [ -n "${ABMIND_BOOTSTRAP_TARBALL:-}" ]; then
    [ -f "$ABMIND_BOOTSTRAP_TARBALL" ] || { err "ABMIND_BOOTSTRAP_TARBALL not found: $ABMIND_BOOTSTRAP_TARBALL"; exit 2; }
    cp "$ABMIND_BOOTSTRAP_TARBALL" "$SCRATCH/abmind.tgz"
    TARBALL="$SCRATCH/abmind.tgz"
else
    TAG="latest"
    [ "$CHANNEL" = "alpha" ] && TAG="alpha"
    echo "Acquiring abmind installer (abmind@${TAG})..."
    if ! npm pack --json --pack-destination "$SCRATCH" "abmind@${TAG}" >/dev/null 2>&1; then
        err "npm pack abmind@${TAG} failed (check network/npm auth)"
        exit 2
    fi
    for f in "$SCRATCH"/abmind-*.tgz; do
        if [ -f "$f" ]; then TARBALL="$f"; break; fi
    done
fi
[ -n "$TARBALL" ] || { err "failed to acquire abmind artifact"; exit 2; }

# ── 2. Extract only the installer entrypoint ──────────────────────────────
echo "Extracting installer..."
mkdir -p "$SCRATCH/extract"
if ! tar -xzf "$TARBALL" -C "$SCRATCH/extract" --strip-components=1 2>/dev/null; then
    err "failed to extract artifact"
    exit 2
fi
ENTRYPOINT="$SCRATCH/extract/dist/cli/abmind.js"
if [ ! -f "$ENTRYPOINT" ]; then
    err "CLI entrypoint not found in artifact: $ENTRYPOINT"
    ls -la "$SCRATCH/extract/" 2>/dev/null || true
    exit 2
fi

# ── 3. Delegate staging/activation to the TypeScript installer ─────────────
INSTALL_ARGS="--${CHANNEL}"
if [ -n "$DEV_DIR" ]; then
    INSTALL_ARGS="--dev ${DEV_DIR}"
elif [ -n "${ABMIND_BOOTSTRAP_TARBALL:-}" ]; then
    INSTALL_ARGS="--${CHANNEL} --artifact ${TARBALL}"
fi
echo "Running standalone installer (${INSTALL_ARGS})..."
if ! ABMIND_HOME="$ABMIND_HOME" node "$ENTRYPOINT" install-standalone $INSTALL_ARGS; then
    err "standalone installer failed"
    exit 2
fi

# ── 4. Verify the public command resolves ─────────────────────────────────
echo "Verifying installation..."
BIN="${HOME}/.local/bin/abmind"
if [ ! -L "$BIN" ]; then
    err "abmind command not linked at ${BIN}"
    echo "Ensure ~/.local/bin exists and precedes npm/nvm bins in PATH." >&2
    exit 2
fi
"$BIN" --version

# ── 5. First-time onboarding only when no manifest exists ─────────────────
if [ ! -f "${ABMIND_HOME}/manifest.json" ]; then
    echo "Running first-time setup..."
    # shellcheck disable=SC2086  # intentional word-splitting of opt string
    "$BIN" install ${ABMIND_INSTALL_ARGS:-}
fi

echo "abmind standalone installed successfully."
exit 0
