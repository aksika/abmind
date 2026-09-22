#!/bin/sh
# install.sh — one-liner installer for abmind standalone.
#
# Piped usage (no download step, installs latest dev commit by default):
#   curl -fsSL https://raw.githubusercontent.com/aksika/abmind/main/scripts/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --stable
#   curl -fsSL .../install.sh | sh -s -- --alpha
#
# This script is self-contained so it survives the pipe transport: it never
# reads answers from stdin itself, and the interactive first-time onboarding
# step is reattached to /dev/tty (or downgraded to --non-interactive when no
# terminal exists). Its only writes are its private temp directory; ALL
# release staging/activation is delegated to the TypeScript installer, exactly
# like scripts/install-standalone.sh (download-then-run path). If you change
# the acquire/extract/delegate flow here, mirror it there.
#
# Environment:
#   ABMIND_HOME               override ~/.abmind runtime root
#   ABMIND_BOOTSTRAP_TARBALL  bootstrap from this local .tgz instead of `npm pack`
#   ABMIND_INSTALL_ARGS       extra args for the first-time `abmind install`
#                             (e.g. "--non-interactive --passphrase x --username y")
#
# Default channel: --dev (latest dev commit)
# Exit codes: 0 = success, 1 = bad usage/prereqs, 2 = acquisition/install failed
set -eu

CHANNEL="dev"
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
Usage: curl -fsSL <raw>/scripts/install.sh | sh [-s -- [--dev [DIR]|--stable|--alpha]]
  --dev      Clone dev into \$ABMIND_HOME/src/abmind (no DIR), or build DIR as-is (default)
  --stable   Install latest stable
  --alpha    Install latest alpha
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
if [ "$CHANNEL" = "dev" ] && [ -z "$DEV_DIR" ] && [ -z "${ABMIND_BOOTSTRAP_TARBALL:-}" ]; then
    command -v git >/dev/null 2>&1 || { err "git is required for --dev (no DIR) but not installed"; exit 1; }
fi

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
# shellcheck disable=SC2086  # intentional word-splitting of installer args
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
# When piped (curl ... | sh), stdin is the script stream, not the terminal,
# so the interactive onboarding must not inherit stdin blindly.
if [ ! -f "${ABMIND_HOME}/manifest.json" ]; then
    echo "Running first-time setup..."
    # shellcheck disable=SC2086  # intentional word-splitting of opt string
    if [ -t 0 ]; then
        "$BIN" install ${ABMIND_INSTALL_ARGS:-}
    elif [ -r /dev/tty ]; then
        "$BIN" install ${ABMIND_INSTALL_ARGS:-} < /dev/tty
    else
        case " ${ABMIND_INSTALL_ARGS:-} " in
            *" --non-interactive "*) "$BIN" install ${ABMIND_INSTALL_ARGS:-} ;;
            *) "$BIN" install --non-interactive ${ABMIND_INSTALL_ARGS:-} ;;
        esac
    fi
fi

echo "abmind standalone installed successfully."
exit 0
