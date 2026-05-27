#!/usr/bin/env bash
# Rebuild and restart the Tandem container after editing frontend or backend.
#
# Usage:
#   ./scripts/rebuild.sh              # rebuild + run in the foreground
#   ./scripts/rebuild.sh -d           # detached
#   ./scripts/rebuild.sh --no-cache   # force a full rebuild (slower)
#   ./scripts/rebuild.sh down         # stop and remove the container

# Note: we intentionally don't use `set -u` because bash 3.2 (the /bin/sh on
# macOS) errors on empty-array expansions like ${ARR[@]} under -u, which
# breaks the script when invoked via `sh scripts/rebuild.sh`. We validate
# the few variables we care about explicitly below instead.
set -eo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f .env ]]; then
  echo "✗ .env missing. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "✗ docker not found in PATH." >&2
  exit 1
fi

# Pick `docker compose` (v2) or `docker-compose` (v1) automatically.
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  echo "✗ Neither 'docker compose' nor 'docker-compose' is available." >&2
  exit 1
fi

NO_CACHE=""
COMMAND="up"
EXTRA_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --no-cache) NO_CACHE="--no-cache" ;;
    down|logs|ps|stop|restart) COMMAND="$arg" ;;
    *) EXTRA_ARGS+=("$arg") ;;
  esac
done

case "$COMMAND" in
  up)
    if [[ -n "$NO_CACHE" ]]; then
      echo "→ docker compose build --no-cache"
      "${DC[@]}" build --no-cache
    fi
    echo "→ ${DC[*]} up --build ${EXTRA_ARGS[*]}"
    exec "${DC[@]}" up --build ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
    ;;
  down)
    exec "${DC[@]}" down ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
    ;;
  logs|ps|stop|restart)
    exec "${DC[@]}" "$COMMAND" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
    ;;
esac
