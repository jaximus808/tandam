#!/usr/bin/env bash
# Apply pending SQL migrations in migrations/ to a Postgres (Supabase) database.
#
# Migrations are the hand-written, numbered files in migrations/ (0001_*.sql,
# 0002_*.sql, ...). They are NOT idempotent — most do bare CREATE TABLE / ADD
# COLUMN — so this runner records which versions are already applied in a
# schema_migrations table and only runs the ones that are new. Each migration
# and its bookkeeping row commit together in ONE transaction, so a failure
# rolls both back: you never get a half-applied migration or a version marked
# applied that didn't run.
#
# Usage:
#   DATABASE_URL=postgres://... ./scripts/migrate.sh
#       Apply every migration not yet recorded, in filename order.
#
#   DATABASE_URL=postgres://... ./scripts/migrate.sh --baseline
#       Record ALL current migrations as applied WITHOUT running them. Run this
#       ONCE against a database whose schema already matches migrations/ — e.g.
#       the existing prod DB whose 0001..NNNN were applied by hand before this
#       runner existed. Without it, the first real run would try to re-run those
#       migrations and fail on the already-existing tables.
#
# DATABASE_URL must be a full Postgres connection string. From the Supabase
# dashboard use Project Settings → Database → Connection string. GitHub-hosted
# runners are IPv4-only and Supabase's *direct* connection is IPv6-only, so in
# CI use the **Session pooler** URI (host aws-0-<region>.pooler.supabase.com),
# not the direct one.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/migrations"

: "${DATABASE_URL:?Set DATABASE_URL to the Postgres connection string}"

if ! command -v psql >/dev/null 2>&1; then
  echo "✗ psql not found in PATH (install the postgresql-client package)." >&2
  exit 1
fi

BASELINE=0
if [[ "${1:-}" == "--baseline" ]]; then
  BASELINE=1
elif [[ -n "${1:-}" ]]; then
  echo "✗ Unknown argument: $1 (expected nothing or --baseline)." >&2
  exit 1
fi

# ON_ERROR_STOP=1: abort (non-zero exit) on the first SQL error instead of
# plowing on. --no-psqlrc: ignore any developer ~/.psqlrc. -q: quiet.
PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc -q)

# Tracking table. IF NOT EXISTS so this is safe on every run.
"${PSQL[@]}" >/dev/null <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT        PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

applied=0
shopt -s nullglob
migrations=("$MIGRATIONS_DIR"/*.sql)

if [[ ${#migrations[@]} -eq 0 ]]; then
  echo "✗ No .sql files found in $MIGRATIONS_DIR." >&2
  exit 1
fi

for file in "${migrations[@]}"; do
  version="$(basename "$file" .sql)"

  already="$("${PSQL[@]}" -tA -c \
    "SELECT 1 FROM schema_migrations WHERE version = '$version'")"
  if [[ "$already" == "1" ]]; then
    continue
  fi

  if [[ "$BASELINE" == "1" ]]; then
    echo "→ baseline: recording $version as applied (not running it)"
    "${PSQL[@]}" >/dev/null -c \
      "INSERT INTO schema_migrations (version) VALUES ('$version')"
    applied=$((applied + 1))
    continue
  fi

  echo "→ applying $version"
  # --single-transaction wraps the whole heredoc (the migration via \i plus the
  # bookkeeping INSERT) in one transaction; ON_ERROR_STOP rolls it all back on
  # any error. \i reads the file whole, so dollar-quoted function bodies are
  # fine.
  "${PSQL[@]}" --single-transaction >/dev/null <<SQL
\i $file
INSERT INTO schema_migrations (version) VALUES ('$version');
SQL
  applied=$((applied + 1))
done

if [[ "$applied" -eq 0 ]]; then
  echo "✓ Up to date — no pending migrations."
elif [[ "$BASELINE" == "1" ]]; then
  echo "✓ Baseline recorded $applied migration(s) as already applied."
else
  echo "✓ Applied $applied migration(s)."
fi
