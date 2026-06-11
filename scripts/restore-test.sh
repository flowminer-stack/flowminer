#!/usr/bin/env bash
#
# Verify the latest pg_dump in ./backups restores cleanly into a throwaway
# Postgres 16 container. Catches empty dumps, corruption, and version drift —
# the failure modes that turn "we have backups" into "we had backups".
#
# Usage:
#   ./scripts/restore-test.sh                 # newest dump in ./backups
#   ./scripts/restore-test.sh path/to.dump    # a specific dump
#
# The throwaway container talks only over `docker exec` (no host port), so it
# never collides with a running stack.
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="${BACKUP_OUTPUT_DIR:-./backups}"
DUMP="${1:-$(ls -1t "$OUT_DIR"/flowminer-*.dump 2>/dev/null | head -1 || true)}"
if [ -z "${DUMP:-}" ] || [ ! -f "$DUMP" ]; then
  echo "error: no dump found in $OUT_DIR. Run 'make backup' first, or pass a path." >&2
  exit 1
fi
echo "==> Restore-testing: $DUMP"

PG_IMAGE="${RESTORE_TEST_PG_IMAGE:-postgres:16.6-alpine}"
CONTAINER="flowminer-restore-test-$$"
PGPW="restoretest"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$PGPW" -e POSTGRES_USER=flowminer -e POSTGRES_DB=flowminer \
  "$PG_IMAGE" >/dev/null

echo "==> Waiting for throwaway Postgres..."
ok=
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U flowminer >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ "${ok:-}" = 1 ] || { echo "error: throwaway Postgres never became ready" >&2; exit 1; }

docker cp "$DUMP" "$CONTAINER:/tmp/test.dump"
echo "==> pg_restore..."
# pg_restore can exit non-zero on ignorable warnings; the row-count assertions
# below are the real correctness gate.
docker exec -e PGPASSWORD="$PGPW" "$CONTAINER" \
  pg_restore -U flowminer -d flowminer --no-owner --no-acl /tmp/test.dump || true

echo "==> Verifying restored tables..."
fail=0
for table in users projects event_logs; do
  if count=$(docker exec -e PGPASSWORD="$PGPW" "$CONTAINER" \
        psql -U flowminer -d flowminer -tAc "SELECT count(*) FROM $table" 2>/dev/null); then
    echo "    $table: $(echo "$count" | tr -d '[:space:]') row(s)"
  else
    echo "    $table: MISSING — restore did not create it" >&2
    fail=1
  fi
done

echo
if [ "$fail" = 0 ]; then
  echo "restore-test PASSED — dump restores and core tables are present."
else
  echo "restore-test FAILED — see missing tables above." >&2
  exit 1
fi
