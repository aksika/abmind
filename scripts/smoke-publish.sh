#!/usr/bin/env bash
# scripts/smoke-publish.sh — dry-run the npm publish artifact.
#
# Runs npm pack, installs the tarball into a scratch dir, and verifies the
# contents match what external users would see after installing the standalone
# package (no npm install -g, no bin mapping).
#
# Does NOT publish. Safe to run anytime.
#
# Exit codes:
#   0  all assertions pass
#   1  pack/install failed or an assertion tripped

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TARBALL="abmind-${VERSION}.tgz"
SCRATCH="$(mktemp -d)"

cleanup() {
  rm -rf "$SCRATCH"
  rm -f "$TARBALL"
}
trap cleanup EXIT

echo "── Build ──"
npm run build

echo "── Pack ──"
npm pack --quiet
ls -lh "$TARBALL"

echo "── Scratch install to $SCRATCH ──"
pushd "$SCRATCH" > /dev/null
npm init -y > /dev/null
npm install "$OLDPWD/$TARBALL" --quiet
popd > /dev/null

PKG_ROOT="$SCRATCH/node_modules/abmind"

echo "── Assertions ──"

check() {
  local path="$1"
  local label="$2"
  if [ -e "$PKG_ROOT/$path" ]; then
    echo "  \u2713 $label: $path"
  else
    echo "  \u2717 MISSING $label: $path"
    exit 1
  fi
}

check "dist/src/index.js"          "library entry (JS)"
check "dist/src/index.d.ts"        "library entry (types)"
check "dist/cli/abmind.js"         "CLI entrypoint"
check "dist/cli/abmind-sleep.js"   "sleep subcommand"
check "scripts/install-standalone.sh" "standalone bootstrap script"
check "scripts/repair-cli.sh"      "emergency repair script"
check "prompts/sleep/01-gc-noise.md" "shipped prompt (gc-noise)"
check "prompts/sleep/basic.md"     "shipped prompt (basic)"
check "README.md"                  "README"
check "LICENSE"                    "LICENSE"
check "CHANGELOG.md"               "CHANGELOG"

# Verify no bin mapping exists in the packaged package.json
PACKED_PKG="$PKG_ROOT/package.json"
if node -e "const p = require('$PACKED_PKG'); process.exit(p.bin ? 0 : 1)" 2>/dev/null; then
  echo "  \u2717 UNEXPECTED bin mapping in package.json"
  exit 1
fi
echo "  \u2713 no bin mapping in package.json"

echo "── Runtime smoke ──"
node -e "
  const m = require('$PKG_ROOT');
  const needed = ['runSleepCycle', 'MemoryManager', 'parseLevel', 'SleepStateGatherer', 'hasSleepAuditToday'];
  for (const name of needed) {
    if (typeof m[name] !== 'function' && typeof m[name] !== 'object') {
      console.error('  \u2717 MISSING export:', name);
      process.exit(1);
    }
    console.log('  \u2713 export:', name, '(' + typeof m[name] + ')');
  }
"

echo ""
echo "── All assertions passed ──"
echo "Package contents match expected publish artifact for abmind@$VERSION."
echo ""
echo "Next steps (when ready to publish):"
echo "  npm whoami                    # must equal 'aksika'"
echo "  npm publish"
echo "  git tag v$VERSION && git push --tags"
