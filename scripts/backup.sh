#!/usr/bin/env bash
#
# FlowMiner backup — dumps Postgres (custom format) and archives the uploads
# volume into ./backups. The stack must be running (this uses
# `docker compose exec`). Verify a dump restores with `make restore-test`.
#
# IMPORTANT: this does NOT capture FLOWMINER_ENCRYPTION_KEY. Store that key
# (and the rest of .env) separately and securely — without the matching key, a
# restored DB's connector credentials and stored LLM keys are unreadable, with
# no error at boot. See docs/BACKUP.md.
#
# Override the output directory with BACKUP_OUTPUT_DIR (default ./backups).
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
  echo "error: .env not found in $(pwd). Run from the repo root with the stack configured." >&2
  exit 1
fi
# Load POSTGRES_* from .env without leaking every var into the log.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

POSTGRES_USER="${POSTGRES_USER:-flowminer}"
POSTGRES_DB="${POSTGRES_DB:-flowminer}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in .env}"

OUT_DIR="${BACKUP_OUTPUT_DIR:-./backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
DUMP="$OUT_DIR/flowminer-$STAMP.dump"
UPLOADS="$OUT_DIR/uploads-$STAMP.tar.gz"

echo "==> [1/2] Dumping Postgres -> $DUMP"
# Dump the DB FIRST so any file referenced by a captured row already exists on
# disk when we archive uploads next (consistent point-in-time ordering).
if ! docker compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" db \
      pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -Fc --no-owner --no-acl > "$DUMP"; then
  echo "error: pg_dump failed (is the 'db' service up?)" >&2
  rm -f "$DUMP"
  exit 1
fi

echo "==> [2/2] Archiving uploads -> $UPLOADS"
if ! docker compose exec -T backend tar -czf - -C /data/uploads . > "$UPLOADS"; then
  echo "error: uploads archive failed (is the 'backend' service up?)" >&2
  rm -f "$UPLOADS"
  exit 1
fi

echo
echo "Backup complete:"
echo "  DB:      $DUMP   ($(du -h "$DUMP" | cut -f1))"
echo "  uploads: $UPLOADS ($(du -h "$UPLOADS" | cut -f1))"
echo
echo "REMINDER:"
echo "  * Store FLOWMINER_ENCRYPTION_KEY (and .env) SEPARATELY and securely."
echo "    Without the matching key, restored credentials are unrecoverable."
echo "  * Copy these archives OFF-BOX (object storage / another host) — a"
echo "    backup on the same disk as the data is not a backup."
echo "  * Verify with: make restore-test"
