#!/usr/bin/env bash
# Rebuild and publish @jaximus/tandem-mcp to npm.
#
# Usage:
#   ./publish.sh           # bump patch version, build, publish
#   ./publish.sh minor     # bump minor version
#   ./publish.sh major     # bump major version
#   ./publish.sh --no-bump # publish current version as-is
set -euo pipefail

cd "$(dirname "$0")"

BUMP="${1:-patch}"

if [ "$BUMP" != "--no-bump" ]; then
  echo "-> bumping $BUMP version..."
  # npm version updates package.json (and would tag, so disable git tagging)
  npm version "$BUMP" --no-git-tag-version
fi

VERSION="$(node -p "require('./package.json').version")"
echo "-> building @jaximus/tandem-mcp@${VERSION} ..."
# Invoke tsup directly (not `pnpm run build`) so pnpm's verify-deps-before-run
# preflight doesn't try to `pnpm install` and choke on ignored build scripts.
pnpm exec tsup

echo "-> publishing @jaximus/tandem-mcp@${VERSION} to npm ..."
# --ignore-scripts skips prepublishOnly (which would re-run `pnpm run build`
# and hit the same verify-deps preflight); we already built above.
npm publish --ignore-scripts

echo "OK: published @jaximus/tandem-mcp@${VERSION}"
echo "Restart Claude Code (and any MCP client) to pick up the new tool metadata."
