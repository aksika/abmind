#!/usr/bin/env bash
# scripts/smoke-publish.sh — dry-run the npm publish artifact.
#
# Runs npm pack, installs the tarball into a scratch dir, and verifies the
# contents match what external users would see after `npm i -g abmind`.
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
    echo "  ✓ $label: $path"
  else
    echo "  ✗ MISSING $label: $path"
    exit 1
  fi
}

check "dist/src/index.js"          "library entry (JS)"
check "dist/src/index.d.ts"        "library entry (types)"
check "dist/cli/abmind.js"         "CLI bin"
check "dist/cli/abmind-sleep.js"   "sleep subcommand"
check "prompts/sleep/01-gc-noise.md" "shipped prompt (gc-noise)"
check "prompts/sleep/basic.md"     "shipped prompt (basic)"
check "scripts/deploy_abmind.sh"   "deploy script"
check "README.md"                  "README"
check "LICENSE"                    "LICENSE"
check "CHANGELOG.md"               "CHANGELOG"

echo "── Runtime smoke ──"
node -e "
  const m = require('$PKG_ROOT');
  const needed = ['runSleepCycle', 'MemoryManager', 'parseLevel', 'SleepStateGatherer', 'hasSleepAuditToday'];
  for (const name of needed) {
    if (typeof m[name] !== 'function' && typeof m[name] !== 'object') {
      console.error('  ✗ MISSING export:', name);
      process.exit(1);
    }
    console.log('  ✓ export:', name, '(' + typeof m[name] + ')');
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
