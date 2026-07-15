#!/bin/sh
# install-standalone.sh — fresh machine bootstrap for abmind standalone.
#
# Acquires a packaged abmind artifact via npm pack, extracts the installer
# entrypoint, and delegates all staging/activation to the TypeScript installer.
# The shell owns no release layout writes.
#
# Usage:
#   sh install-standalone.sh [--stable|--alpha|--dev [DIR]]
#
# Default: --stable
# Exit codes: 0 = success, 1 = missing prerequisites, 2 = install failed
set -eu

CHANNEL="stable"
DEV_DIR=""

while [ $# -gt 0 ]; do
    case "$1" in
        --stable) CHANNEL="stable" ;;
        --alpha) CHANNEL="alpha" ;;
        --dev)
            CHANNEL="dev"
            if [ -n "${2:-}" ] && ! echo "$2" | grep -q '^--'; then
                DEV_DIR="$2"
                shift
            fi
            ;;
        --help|-h)
            echo "Usage: sh install-standalone.sh [--stable|--alpha|--dev [DIR]]"
            echo "  --stable   Install latest stable (default)"
            echo "  --alpha    Install latest alpha"
            echo "  --dev      Install from dev source (optionally from DIR)"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
    shift
done

err() { printf 'ERROR: %s\n' "$1" >&2; }

command -v node >/dev/null 2>&1 || { err "node is required but not installed"; exit 1; }
command -v npm >/dev/null 2>&1 || { err "npm is required but not installed"; exit 1; }

ABMIND_HOME="${ABMIND_HOME:-$HOME/.abmind}"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

echo "Acquiring abmind@${CHANNEL}..."

if [ "$CHANNEL" = "dev" ]; then
    if [ -n "$DEV_DIR" ]; then
        if [ -f "${DEV_DIR}/dist/cli/abmind.js" ]; then
            npm pack --pack-destination "$SCRATCH" "$DEV_DIR" >/dev/null 2>&1
        else
            (cd "$DEV_DIR" && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1)
            npm pack --pack-destination "$SCRATCH" "$DEV_DIR" >/dev/null 2>&1
        fi
    elif [ -d "${ABMIND_HOME}/src/abmind" ] && [ -f "${ABMIND_HOME}/src/abmind/dist/cli/abmind.js" ]; then
        npm pack --pack-destination "$SCRATCH" "${ABMIND_HOME}/src/abmind" >/dev/null 2>&1
    else
        npm pack --json --pack-destination "$SCRATCH" "abmind@dev" >/dev/null 2>&1
    fi
elif [ "$CHANNEL" = "alpha" ]; then
    npm pack --json --pack-destination "$SCRATCH" "abmind@alpha" >/dev/null 2>&1
else
    npm pack --json --pack-destination "$SCRATCH" "abmind@latest" >/dev/null 2>&1
fi

TARBALL=""
for f in "$SCRATCH"/abmind-*.tgz; do
    if [ -f "$f" ]; then
        TARBALL="$f"
        break
    fi
done

if [ -z "$TARBALL" ]; then
    err "failed to acquire abmind artifact"
    exit 2
fi

echo "Extracting installer..."
mkdir -p "$SCRATCH/extract"
tar -xzf "$TARBALL" -C "$SCRATCH/extract" --strip-components=1 2>/dev/null || {
    mkdir -p "$SCRATCH/extract/node_modules/abmind"
    tar -xzf "$TARBALL" -C "$SCRATCH/extract/node_modules/abmind" --strip-components=1 2>/dev/null
}

ENTRYPOINT=""
for candidate in \
    "$SCRATCH/extract/dist/cli/abmind.js" \
    "$SCRATCH/extract/node_modules/abmind/dist/cli/abmind.js"; do
    if [ -f "$candidate" ]; then
        ENTRYPOINT="$candidate"
        break
    fi
done

if [ -z "$ENTRYPOINT" ]; then
    err "CLI entrypoint not found in the acquired artifact"
    ls -la "$SCRATCH/extract/" 2>/dev/null || true
    exit 2
fi

echo "Running standalone installer..."
ARGS="--${CHANNEL}"
if [ -n "$DEV_DIR" ]; then
    ARGS="--dev ${DEV_DIR}"
fi

ABMIND_HOME="$ABMIND_HOME" node "$ENTRYPOINT" install-standalone $ARGS

echo "Verifying installation..."
if [ -f "${HOME}/.local/bin/abmind" ]; then
    "${HOME}/.local/bin/abmind" --version
    echo "abmind standalone installed successfully."
else
    err "abmind binary not found at ~/.local/bin/abmind"
    echo "Check PATH ordering and ensure ~/.local/bin is in your PATH."
    exit 2
fi

if [ ! -f "${ABMIND_HOME}/manifest.json" ]; then
    echo "Running first-time setup..."
    "${HOME}/.local/bin/abmind" install
fi

exit 0
