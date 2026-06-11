# Backups & Restore

FlowMiner's durable state is three things:

| What | Where | Backed up by |
|---|---|---|
| **Database** (projects, users, dashboards, alerts, connector config, …) | Postgres 16 — `postgres_data` volume | `pg_dump -Fc` |
| **Uploaded files** (event-log CSV/XES/Parquet/OCEL, ETL outputs, model cache) | `upload_data` volume → `/data/uploads` | `tar` |
| **The encryption key** | `FLOWMINER_ENCRYPTION_KEY` in `.env` | **YOU — store it separately** |

Redis (`redis_data`) is Celery job state + cache. It is **not** part of a backup and should **not** be restored — let it start fresh.

> ⚠️ **The encryption key is the silent killer of restores.** `FLOWMINER_ENCRYPTION_KEY` (or, if unset, a key derived from `SECRET_KEY`) decrypts every stored connector credential and LLM API key. It is **not** in any database dump. Restore a database onto an instance with a *different* key and the app boots fine — but every credential is unreadable garbage, with no error. **Store the key (and `.env`) separately and securely** — a password manager or secrets vault, not next to the dumps.

---

## Taking a backup

```bash
make backup
```

This (stack must be running):

1. `pg_dump -Fc` the database → `./backups/flowminer-<UTC-stamp>.dump`
   (custom format: natively compressed and restorable with `pg_restore`,
   which supports parallel/selective restore — unlike plain SQL).
2. `tar czf` the uploads volume → `./backups/uploads-<UTC-stamp>.tar.gz`.
   The DB is dumped **first** so any file referenced by a captured row already
   exists on disk when the uploads are archived (consistent ordering).

Override the destination with `BACKUP_OUTPUT_DIR=/path make backup`.

**There is also an automatic nightly backup** (the `backup_database` Celery task)
that writes `pg_dump -Fc` files into the `backup_data` volume (`/data/backups`,
configurable via `BACKUP_DIR`), keeping the last 7. Treat that as a convenience
safety net — `make backup` is the operator-driven path that also captures uploads.

### Get the backups OFF the box

A dump sitting on the same disk as the data is not a backup. Copy `./backups`
(or the `backup_data` volume) to object storage or another host. A `restic`/B2
off-box override is on the roadmap; until then, `rsync`/`rclone` on a cron is fine.

---

## Verifying a backup

```bash
make restore-test            # newest dump in ./backups
./scripts/restore-test.sh path/to/specific.dump
```

Spins up a throwaway Postgres 16 container, `pg_restore`s the dump, and asserts
the core tables (`users`, `projects`, `event_logs`) restored. Catches empty
dumps, corruption, and version drift. Run it after taking a backup and on a
schedule — an unverified backup is a guess.

---

## Restoring

On a target with the **same `FLOWMINER_ENCRYPTION_KEY`** in `.env`:

```bash
# 1. Bring up just the database
docker compose up -d db

# 2. Restore the dump (custom format → pg_restore, NOT psql)
docker compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" db \
  pg_restore -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --clean --if-exists --no-owner --no-acl < ./backups/flowminer-<stamp>.dump

# 3. Restore uploaded files
docker compose up -d backend
docker compose exec -T backend sh -c 'tar xzf - -C /data/uploads' < ./backups/uploads-<stamp>.tar.gz

# 4. Start the rest + sanity-check
docker compose up -d
make doctor
```

For moving an entire install to a new server, see the migration runbook
(roadmap item — `MIGRATION_RUNBOOK.md`). The short version: logical
dump + restore (never a raw volume copy across hosts), copy `.env` including
the encryption key, restore with `pg_restore` (not `psql`), and don't bring
back Redis.

---

## What's intentionally not here yet

- **Point-in-time recovery (WAL archiving / pgBackRest / WAL-G).** A 6-hour RPO
  via `pg_dump` covers a pre-1.0 single-node deployment. Revisit at large DB
  size or a contractual sub-hour RPO.
- **Built-in off-box offload / scheduled retention to S3.** Use `rclone`/`restic`
  on a cron for now; a first-class override is planned.
