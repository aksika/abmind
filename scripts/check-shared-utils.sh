#!/usr/bin/env bash
set -euo pipefail

# Check that SHARED deploy-lib files match the canonical hashes in abproject.
# Run in standalone CI to detect drift between abtars and abmind copies.
#
# Expected hashes — update both repos simultaneously when changing these files.
# See abproject/docs/shared-utils.lock for the canonical registry.

SHARED_FILES=(
  "src/deploy-lib/safe-copy.ts:42eba091be9c7a300082b0965148973ef94a861676441b5b61e431ae70d58c96"
  "src/deploy-lib/cleanup.ts:2259e2cc2252239bd981439609236e96a656da1c62d91ff5101e4f7c50d6e92f"
  "src/deploy-lib/lock.ts:1911ca9ef55a1fd5317662b5c155ed8895c7addf51b20bd489e92dd721889067"
)

errors=0
for entry in "${SHARED_FILES[@]}"; do
  file="${entry%%:*}"
  expected="${entry##*:}"
  if [ ! -f "$file" ]; then
    echo "MISSING: $file"
    errors=$((errors + 1))
    continue
  fi
  actual=$(sha256sum "$file" | cut -d' ' -f1)
  if [ "$actual" != "$expected" ]; then
    echo "DRIFT: $file"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    errors=$((errors + 1))
  fi
done

if [ $errors -gt 0 ]; then
  echo "FAILED: $errors shared file(s) drifted. Update both repos together."
  exit 1
fi
echo "OK: all shared deploy-lib files match canonical hashes."
