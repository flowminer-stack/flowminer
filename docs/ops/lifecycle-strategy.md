# FlowMiner — Ops & Lifecycle Strategy: Updates, Export, Backups, and Long-Term QoL

> Produced 2026-06-10 by a multi-agent audit (4 codebase mappers + 4 web researchers →
> Opus synthesis → 3-lens adversarial verification against the real code → Opus finalize).
> Every recommendation is grounded in a real file/line. Effort sizes: S/M/L/XL.

## 1. TL;DR / Verdict

- **Updates: cut the chicken-and-egg blocker first.** The single most important move is to **tag `v0.1.0` and let `release.yml` push to GHCR** — everything (`release.yml`, multi-arch, OCI labels, CHANGELOG) is already written and has *never fired*. Self-hosters today must build from source because `docker-compose.yml` still uses `flowminer-backend:local` / `flowminer-frontend:local` (lines 152/190/234/283). The CHANGELOG `[Unreleased]` entry *claims* this is already done ("production compose now references `ghcr.io/flowminer/backend:0.1.0`") — that is a false statement of completed work. Do the compose flip *and* fix the CHANGELOG lie.
- **Migrations: get the Helm race fixed and make migrations visible.** In compose, the migration race is **already mitigated** — `worker` and `beat` depend on `backend: condition: service_healthy`, and the backend only reports healthy after `init_db()` finishes `alembic upgrade head`. The real, unmitigated race is in Helm (`replicas.backend=2`, no migrate Job, no initContainer). Move migrations to a one-shot `migrate` service/Job for **visibility and Helm correctness**, and add a **schema-newer-than-image guard** so an accidental image rollback refuses to boot instead of corrupting data.
- **Backups are a phantom feature — fix it before it bites a customer.** The nightly `backup_database` task (`backend/app/workers/tasks.py:1313`) **silently no-ops on every deployment** because `pg_dump` isn't in the image (`backend/Dockerfile` installs only `libpq5, graphviz, procps`), and even when it runs it writes *inside* `upload_data` — the very volume you'd be restoring. It also produces **plain-text SQL piped through Python gzip** (lines 1335–1354), so only `psql` can restore it, never `pg_restore`. Add `postgresql-client-16`, switch to `-Fc`, drop the manual gzip, and write to a separate volume.
- **The encryption key is the silent killer of every restore/transfer.** `FLOWMINER_ENCRYPTION_KEY` (or its `SECRET_KEY`-derived fallback in `secret_box.py`) decrypts all connector creds and stored LLM keys. Restore the DB without the matching key and the app boots fine but every credential is garbage, *with no error*. Back it up *separately* and call it out loudly in every runbook.
- **Export to other PM tools: BUILD it — partial, table-stakes only.** A *clear yes*. It's load-bearing for the EU-sovereignty / anti-lock-in pitch (EU Data Act portability, GDPR Art. 20), nearly free because **pm4py is already a dependency** (`write_xes` / `write_ocel2_*` available), and there's a real gap: **FlowMiner reads XES but cannot write it** (`write_xes` → zero hits in `backend/app/`), and **there is no raw-event-log download at all**. Build raw download + XES + interop-CSV/Parquet + OCEL2. Skip the Celonis push-connector.
- **QoL: the highest-leverage cheap wins are a `doctor` preflight, `make backup`/`make upgrade`, and a support bundle.** These reuse helper machinery that exists (Typer app in `app/cli.py`, secret-scrubbing regex in `logging_setup.py`, `validate_production_secrets()`, `/health/ready`, `wait-ready.sh`) but are net-new commands and Makefile targets — none exist today.
- **Telemetry: opt-in only, default OFF.** An update-check beacon must be explicit opt-in. A `/api/v1/version` endpoint comparing against GitHub Releases (cached in Redis) is the privacy-respecting middle ground; never phone home by default.
- **Don't build the enterprise machinery yet.** No PITR/WAL-G, no Flower, no HPA, no license server, no Celonis connector, no blue-green. You're pre-v0.1.0 — right-size.

---

## 2. Updates (the core ask)

FlowMiner has two distribution modes that need *different* update philosophies but **one image and one versioning scheme**:

| Mode | Channel | Cadence | Who triggers |
|---|---|---|---|
| Vendor SaaS (`demo.flowminer.io`, Dokploy prod) | continuous deploy | every merge to `main` | git push → Dokploy rebuild |
| Customer self-hosted (compose / Helm) | **stable, pinned releases** | deliberate, on `v*` tags | operator runs `make upgrade` |

### 2.1 Versioning scheme

**Use semver (`MAJOR.MINOR.PATCH`), not CalVer.** Semver suits products with a stability contract and batched breaking changes (GitLab, n8n, Forgejo, Plausible, Langfuse) — exactly what a self-hosted customer needs. CalVer (Sentry) suits pure continuous-ship. FlowMiner already declares semver (`0.1.0`), so this is the path of least resistance. Post-1.0, `MAJOR` signals a breaking migration or removed feature.

**Fix the version-source-of-truth bug.** `APP_VERSION` is a hardcoded Pydantic field (`backend/app/config.py:89`, `APP_VERSION: str = "0.1.0"`), so *every* image reports `0.1.0` regardless of tag, and the `VERSION` build-arg that `release.yml` passes is silently dropped — **neither `backend/Dockerfile` nor `frontend/Dockerfile` declares `ARG VERSION`**. Concrete fix:

- `backend/Dockerfile`: add `ARG VERSION=dev` and `ENV FLOWMINER_VERSION=${VERSION}`.
- `frontend/Dockerfile`: add the same `ARG VERSION` (it does **not** currently receive it), and pass `VITE_APP_VERSION=${VERSION}` into the `npm run build` step.
- `backend/app/config.py:89`: change to source from `FLOWMINER_VERSION`, defaulting to `dev`.
- **Critical precedence trap:** `.env.example` ships `APP_VERSION=0.1.0` (line 71). Pydantic Settings loads `.env` ahead of process env, so a baked-in image `ENV` would be silently overridden. Use a **new var name** (`FLOWMINER_VERSION`) that is *not* in `.env.example`, and remove the stale `APP_VERSION` line — otherwise the fix is a no-op for any operator who copied the example.

Then `/health` (`main.py:217`) reports the real image version — essential for upgrade UX and support bundles. Effort **S**.

### 2.2 GHCR publishing + channels

`release.yml` builds multi-arch (`amd64+arm64`) on `v*` tags but currently emits **only two tags per image** via a hardcoded `tags:` block: the exact version and `latest` (no `docker/metadata-action`). To add float channels, **switch the publish steps to `docker/metadata-action` first** (the hardcoded block must be replaced, not appended to), then enable:

- `type=semver,pattern={{major}}.{{minor}}` → `v0.1` (auto-updated on patch releases — the recommended self-hoster pin).
- `type=semver,pattern={{major}}` → `v0` (the 0.x series).
- A `stable` raw tag enabled only on non-prerelease tags (so `v0.2.0-rc1` doesn't move `stable`).

Channel contract to document:

| Tag | Mutability | Audience |
|---|---|---|
| `v0.1.0` | immutable | production self-hosters who pin exactly |
| `v0.1` | moving (patches only) | self-hosters who want auto-patch, no surprise minors |
| `stable` | moving (latest non-prerelease) | "just give me the good one" |
| `latest` | moving (any release) | demos / quick-start only |

**GHCR namespace mismatch — own blocker, fix before the first tag.** Three references disagree and will 404 on first Helm/compose pull:
- `release.yml` pushes to `ghcr.io/${{github.repository_owner}}/flowminer-backend:v0.1.0` (dynamic, correct).
- `deploy/helm/flowminer/values.yaml` hardcodes `ghcr.io/flowminer/flowminer-backend` (wrong owner).
- `CHANGELOG.md` `[Unreleased]` references `ghcr.io/flowminer/backend:0.1.0` (wrong owner, wrong image name, no `v` prefix).

Reconcile all three to the `github.repository_owner` / `flowminer-backend` / `v`-prefixed form.

### 2.3 How self-hosters pin & upgrade

**Flip `docker-compose.yml` off `:local`.** Lines 152/190/234/283 use `:local`, forcing a from-source rebuild. The CHANGELOG already *claims* this is done — it is not; both the compose file and the CHANGELOG need fixing. Change the production compose to:

```yaml
image: ghcr.io/flowminer-stack/flowminer-backend:${FLOWMINER_VERSION:-v0.1.0}
build:                       # keep build stanza for dev override
  context: ./backend
```

With `FLOWMINER_VERSION` in `.env`, an operator upgrades by bumping one line. Keep `docker-compose.dev.yml` building from source.

### 2.4 SAFE migration handling

Three concrete changes, in order:

**(a) Extract a one-shot `migrate` service — for visibility and Helm.** In compose, the boot-time race is already handled by the `depends_on: backend: service_healthy` chain, so this is a **hygiene/visibility improvement** there, *not* a corruption fix. It is a **correctness requirement for Helm**, which has no equivalent wait. Add to `docker-compose.yml`:

```yaml
migrate:
  image: ghcr.io/flowminer-stack/flowminer-backend:${FLOWMINER_VERSION:-v0.1.0}
  command: ["alembic", "upgrade", "head"]
  restart: "no"
  depends_on:
    db: { condition: service_healthy }
  env_file: .env
```

Then `backend`/`worker`/`beat` gain `depends_on: migrate: { condition: service_completed_successfully }`. `init_db()` (`backend/app/database.py`) already has two-path logic — `create_all + stamp` for a fresh DB (`not inspector.has_table('users')`) and `alembic upgrade head` for an existing one. **Remove the `alembic upgrade head` branch entirely** and delegate upgrades to the migrate service; keep (or also move) only the fresh-DB fast-path. For Helm, add the equivalent **`migrate` Job** (or initContainer) — the chart has neither, so `replicas.backend=2` races today.

**(b) Refuse to start if the schema is newer than the image.** Add ~8 lines to `backend/app/database.py`: read the DB's `alembic_version` head; if it's *not* in this image's migration chain (someone rolled the image back without reverting the DB), `sys.exit(1)` with `"DB schema is newer than this image (rev X not in chain). Upgrade the image or restore from a matching backup."` This is the single cheapest data-loss prevention available. Effort **S**.

**(c) Backup-before-migrate.** The `make upgrade` flow (§2.6) takes a backup *before* invoking the migrate service. One migration is permanently irreversible (`c4d5e6f7a8b9` Shopify-enum — `ALTER TYPE ADD VALUE` has a no-op downgrade), so the rollback story for a *full revert* is "restore the pre-upgrade backup," not "downgrade to base." Make that explicit.

Also encode **expand/contract migration rules in `CONTRIBUTING.md`** now, while all 13 migrations are still purely additive (CONTRIBUTING currently has none): never add `NOT NULL` without a default, never rename in one step (add+copy+drop), always `CREATE INDEX CONCURRENTLY`, separate data migrations from schema migrations. Costs nothing today; prevents the first breaking-migration disaster.

### 2.5 Rollback

There is no rollback today (no git tags, `:local` images, no prior artifact). Once GHCR tags exist, image rollback is `FLOWMINER_VERSION=v0.1.0 docker compose up -d`. For schema:

- **Reversing a single migration one step** (`alembic downgrade -1`) is safe for the 12 standard migrations (the irreversible one is `c4d5e6f7a8b9` — its downgrade is a no-op).
- **Never run `alembic downgrade base` / `alembic downgrade 252a7b6ad654`** — the baseline downgrade calls `Base.metadata.drop_all` and destroys everything. Consider a guard that refuses a downgrade targeting the baseline revision.
- For a *full version revert*, the honest path is **restore the pre-upgrade backup + revert the image tag**, not a multi-step downgrade. Document this in `UPGRADE.md`.

### 2.6 The `update`/`upgrade` path

Add `scripts/upgrade.sh` + a `make upgrade` target (~60 lines, modeled on PostHog's `bin/upgrade-hobby`). Note: the Makefile today has **no `backup`, `restore-test`, `upgrade`, or `doctor` target** — all are net-new. The existing `make migrate` runs alembic on the host (outside Docker), so introducing `docker compose run --rm migrate` is a deliberate pattern change, not a drop-in.

1. Print current version from `/health`.
2. **Mandatory backup** (reuse `make backup`, §4) — refuse to proceed if it fails.
3. `docker compose pull`.
4. `docker compose run --rm migrate` (separated, visible).
5. `docker compose up -d --remove-orphans`.
6. Poll `scripts/wait-ready.sh` (already exists) until `/health/ready` is 200.
7. Print new version; run `python -m app.cli doctor` (§5) as a post-upgrade check.

Add a `--dry-run` flag.

**Dokploy note (production SaaS path).** Prod runs Dokploy+Traefik, *not* vanilla `docker compose pull && up -d`. Document the Dokploy-specific flow separately: SaaS continuous-deploy is git-push → Dokploy rebuild; for an image-tag bump, set the new `FLOWMINER_VERSION` in the Dokploy stack env and redeploy via Dokploy's UI/webhook. Verify the `migrate` one-shot service behaves as `service_completed_successfully` inside Dokploy's stack concept (it manages compose stacks but its lifecycle handling of `restart: "no"` one-shots should be confirmed before relying on it).

### 2.7 Breaking-change comms

CHANGELOG already uses Keep-a-Changelog. Add per-release:

- An **"Upgrade Notes"** subsection (usually "No breaking changes").
- A top-level **"Versions to Avoid"** and **"Known-Good Upgrade Paths"** list — start now even while empty.
- Fix the placeholder: `[0.1.0] — 2025-01-01` predates the real git history (2026); set it to the real tag date.
- Fix the false `[Unreleased]` "Pinned image tags" claim (§2.3) and its wrong GHCR paths (§2.2).

For SaaS, a Dokploy webhook on new GHCR tags can auto-deploy; for self-hosted, the contract is "read CHANGELOG, then `make upgrade`." **Do not recommend Watchtower** — archived Dec 2025, universally advised against for stateful services. If you want auto-bump assistance, point operators at Renovate to open a PR against the pinned tag in their `.env`.

---

## 3. Export to Other PM Tools

**Verdict: BUILD — partial, table-stakes formats only. A clear yes, not a maybe.** Three reasons, all grounded:

1. **It's the product story, not a churn risk.** FlowMiner's entire positioning is EU sovereignty / anti-vendor-lock-in / cheaper-than-Celonis. The EU Data Act's portability provisions applied Sept 2025; GDPR Art. 20 adds a machine-readable export right (process logs are often personal data — who did what, when). "Your data, always exportable in open standards, no hostage data" is a sales weapon against Celonis, *especially* with EU procurement teams who treat portability as mandatory. The churn risk of offering export is far lower than the trust/sales lift.
2. **pm4py is already a dependency** (`==2.7.22.4`, pinned for OCEL 2.0). `write_xes`, `write_ocel2_json/xml/sqlite`, `write_pnml`, `ocel_flattening` are all installed. Export endpoints are mostly column-renaming + a `StreamingResponse`.
3. **There is a real, embarrassing gap.** FlowMiner *reads* XES but **cannot write it** (`write_xes` → zero hits in `backend/app/`). Worse, **there is no raw-event-log download at all** — a user who uploaded a CSV cannot get their own data back off the server (`event_logs.py` has upload/list/preview/delete but no `/download`). For a sovereignty pitch, "you can't even re-download what you uploaded" is a credibility hole.

### Ranked build list

| # | Format / endpoint | Target tools | Table-stakes? | Effort | Notes |
|---|---|---|---|---|---|
| 1 | **Raw event-log download** `GET /event-logs/{id}/download` (original CSV/Parquet/XES bytes) | everything; GDPR Art.20 | **Table-stakes** | S | The primitive. Stream `EventLog.file_path` (already stored). Gate to project admin/owner. The #1 sovereignty fix. |
| 2 | **XES export** `GET /export/{id}/xes` via `pm4py.write_xes` | ProM, Disco, Apromore, Celonis, Signavio | **Table-stakes** | S | Rename to `case:concept:name`/`concept:name`/`time:timestamp` (cols already stored on `EventLog`). Stream `application/xml`, `.xes`. The single biggest interop gap. |
| 3 | **Interop CSV** `GET /export/{id}/csv-interop` (CaseID, Activity, Timestamp, Resource) | Disco, Celonis, Apromore, Signavio | **Table-stakes** | S | A format-translation layer *on top of #1*. Distinct from the existing `/export/{id}/csv` (mining.py:1862), which exports *analysis results*, not the raw log. **Duplicate the timestamp as start+end** so Apromore and Celonis (both require End Timestamp) accept it. |
| 4 | **Parquet export** `GET /export/{id}/parquet` | Celonis, Apromore | **Table-stakes** (large logs) | S | `df.to_parquet`; pyarrow already in stack. Preserves timestamp types — avoids Celonis date-parse ambiguity at BPIC scale. |
| 5 | **OCEL 2.0 download** `GET /export/ocel/{id}/ocel2?format=json\|xml\|sqlite` | ocpa, researchers, Celonis OCDM | Table-stakes (you sell OCPM) | S | `write_ocel2_*` already used internally (`ocel.py`, `log_builder.py`). **Use `write_ocel2_*` explicitly** (not 1.0 writers) or O2O relations silently drop. Also exposes the *enriched* OCEL from State-Aware that's currently stranded on disk. |
| 6 | **BPMN as file** — add `Content-Disposition` + `?download=1` to the existing `/export-bpmn/{id}` | Camunda, Signavio | Nice-to-have | S | Today the BPMN XML ships inside a JSON envelope; serve it as a `.bpmn` attachment. |
| 7 | **PNML export** `GET /export/{id}/pnml` via `pm4py.write_pnml` | ProM, pm4py | Nice-to-have | S | The Petri net is already discovered in `mining.py:807` then thrown away after BPMN conversion. |
| 8 | **OCEL→XES flatten** `GET /export/ocel/{id}/xes?object_type=…` | ProM/Disco for OCPM users | Nice-to-have | M | `ocel_flattening` per object type, then `write_xes`. Bridge for tools without OCEL2 support. |

### Don't build (export)
- **No Celonis EMS/CEML push-connector.** Celonis ingests CSV/Parquet directly; a push connector is a large maintenance surface for a tool you're positioning *against*. Pull-export covers the real switcher workflow. (The OCDM connector is a separate Celonis tool, not a CSV upload — don't oversell "one-click Celonis OCEL.")
- **No streaming/chunked XES rewrite yet.** `write_xes` materializes the full log in memory (risk on 512MB containers at BPIC scale). Defer the chunked generator + `rustxes` streaming path to pre-1.0. (`rust_accel`/`rustxes` is already baked into the prod image, so it's available when needed.)

### UI framing
Add an **"Export & Portability"** settings section — "Your Data, Always" — listing the open formats, linking the standards, reusing the existing `project_io` manifest as a "download everything" entry point. Zero backend work if it just links the endpoints above; pure sales/trust value.

---

## 4. Backups & DR

Today there are **zero working backups** (the nightly task silently skips) and **no restore/transfer runbook**. This is the highest operational risk in the codebase. Right-sized for a pre-1.0 single-node app: **logical `pg_dump` (custom format) + tar of uploads + off-box `restic`. No PITR.**

### 4.1 What to capture

| Asset | How | Notes |
|---|---|---|
| Postgres (all tables + `alembic_version`) | `pg_dump -Fc` | `-Fc` (custom format) enables compression + parallel `pg_restore --jobs`. pg_dump is already transactionally consistent by design — no `--single-transaction` needed for a full schema+data dump. |
| `upload_data` volume (event-log files, OCEL, ETL parquets, model cache, `_outbox`) | `tar` read-only | **Dump Postgres FIRST, then tar** — MVCC ordering guarantees any file whose DB row was captured exists on disk. |
| **`FLOWMINER_ENCRYPTION_KEY`** (+ `SECRET_KEY`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`) | **separately**, in a password manager / vault | Restore without the matching key = app boots, every connector cred + LLM key is unreadable garbage, *no error at boot*. The most likely silent DR failure. |
| `redis_data` | **DO NOT back up / restore** | Celery job state + cache. **Security caveat (operator's call):** it also holds the **JWT revocation blocklist** (`token_revocation.py`), keyed per-JTI with TTL = remaining token life (`ACCESS_TOKEN_EXPIRE_MINUTES=1440`, worst case ~24h). On restore from empty Redis, any token revoked for a **security event** (not routine logout) becomes valid again. **Runbook rule: if Redis held tokens revoked for a suspected breach, rotate `SECRET_KEY` after restore (before bringing the stack online) to invalidate all tokens.** Otherwise let Redis start fresh. |
| Beat schedule (`/home/flowminer/.beat`) | **back it up — give it a named volume** | The beat command writes the schedule to `/home/flowminer/.beat/celerybeat-schedule`, which is **not on any named volume**. Losing it on every restart re-fires all periodic tasks immediately — a thundering-herd of CPU-heavy jobs on every deploy. **Medium impact.** One-line fix: add a `beat_data` volume mounted at `/home/flowminer/.beat`. |

### 4.2 The must-fix bugs before any backup works

1. **`pg_dump` is not in the image.** Add `postgresql-client-16` to the runtime stage of `backend/Dockerfile` (currently `libpq5, graphviz, procps` only) — version-matched to `postgres:16` for `pg_dump`/`pg_restore` parity. Until this lands, `backup_database` (`backend/app/workers/tasks.py:1313`) returns `{status: skipped}` on every run.
2. **The existing dump is `pg_restore`-incompatible.** The task (lines 1335–1354) runs `pg_dump --no-owner` to **plain-text SQL**, then gzips it in Python. Switch to `-Fc`, drop the manual gzip (custom format compresses natively). Plain `+gzip` can only be restored with `psql`, not `pg_restore` — no selective or parallel restore.
3. **Backups land inside the volume being backed up** (`tasks.py:1313`-region → `UPLOAD_DIR/_backups`). Move to a dedicated `backup_data` volume.

### 4.3 Compose-based design

**Pick one backup engine — don't run both.** Once `pg_dump -Fc` is in the worker image (§4.2), the **existing Celery beat task becomes the primary path** and the sidecar is unnecessary. Use a separate sidecar *only* if you want backups decoupled from worker health; do not run the Celery task and a sidecar simultaneously (two divergent backup sets). Recommended: keep the Celery task as primary, add `restic` purely for off-box offload.

- Schedule: every 6h is fine for pre-1.0 (RPO 6h acceptable).
- **Off-box offload (tier 2):** add `restic` via `djmaze/resticker` in a `docker-compose.backup.yml` override, pointing at Backblaze B2 **via the S3-compatible endpoint** (restic's native B2 connector is flagged unreliable in its own docs). AES-256 client-side encryption; repo password = a *separate* `BACKUP_ENCRYPTION_PASSPHRASE` (don't co-locate with `FLOWMINER_ENCRYPTION_KEY`). **Optional** — gate behind the override; air-gapped customers skip it.
- **Retention (GFS):** `restic forget --keep-daily 14 --keep-weekly 4 --keep-monthly 12`. Local dumps: keep 7–14 daily.
- **Failure alerting:** ping a healthchecks.io / Uptime Kuma / webhook URL on success; dead-man's-switch fires if no ping within 1.5× interval. Silent backup failure is the #1 DR disaster — ~2 lines.

### 4.4 Makefile + verification

All four targets below are **net-new** (the Makefile has none today):

- `make backup` — `pg_dump -Fc` + tar uploads + (optional) restic push. Table-stakes for the sovereignty pitch; the first thing a technical evaluator looks for.
- `make restore-test` — spin up a throwaway `postgres:16-alpine`, `pg_restore` the latest dump, assert `SELECT count(*)` on `users`/`projects`/`event_logs` > 0, tear down. Catches empty dumps, corruption, version drift. Wire into a **weekly CI job** — there is currently *no* backup/restore coverage in the test suite.
- Document the `FLOWMINER_ENCRYPTION_KEY` separate-backup requirement loudly in `.env.example` and a new `BACKUP.md`.

### 4.5 "Transfer to a new instance" runbook (`MIGRATION_RUNBOOK.md`)

Use **logical dump+restore, never raw volume copy** (volume copy needs identical PG minor version + cold Postgres and is the #1 cause of un-restorable backups). The EU pitch implies customers *will* move between VPS providers, so this must be tested and written down:

1. Lower DNS TTL to 60s **24h before** the window (Traefik/Dokploy host).
2. On source: `docker compose stop worker beat backend` (quiesce writes).
3. `pg_dump -Fc` → `flowminer.dump`.
4. `tar czf uploads.tar.gz` the `upload_data` volume.
5. `scp` both archives **+ copy `.env` (incl. `FLOWMINER_ENCRYPTION_KEY`)** to target.
6. On target: `docker compose up -d db`; `pg_restore` the dump; restore uploads tar.
7. **Check `alembic current` against the target image before migrating.** If the schema guard (§2.4(b)) is implemented, `docker compose run --rm migrate` will refuse a dump that's ahead of the image; until then verify manually that the dump is not newer than the image, then run migrate.
8. `docker compose up -d`; run `make doctor` smoke check.
9. Update DNS A record; restore TTL after propagation.

Explicit warnings: **don't restore `redis_data`** (and the breach-revocation rule, §4.1); **the encryption key must match or all creds are lost**; **never raw-rsync the Postgres data dir while running**; the dump is custom-format, so restore with **`pg_restore`, not `psql`**.

Also fix opportunistically: `etl.py:204` uses `os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")` instead of `settings.UPLOAD_DIR` — if `UPLOAD_DIR` is ever unset, ETL outputs land in ephemeral `/tmp` and vanish on restart. One-line fix (roadmap #28).

### 4.6 Secrets rotation (write the runbook)

For a sovereignty pitch, operators must be able to rotate and audit secrets — but several rotations are currently footguns with no documented procedure or tooling:

- **`SECRET_KEY`** — if `FLOWMINER_ENCRYPTION_KEY` is *unset*, encryption falls back to a `SECRET_KEY`-derived key (`secret_box.py`); rotating `SECRET_KEY` then silently corrupts every stored connector cred + LLM key. **Rule: set an explicit `FLOWMINER_ENCRYPTION_KEY` first**, then `SECRET_KEY` is safe to rotate (it only invalidates JWTs).
- **`FLOWMINER_ENCRYPTION_KEY`** — there is **no re-encryption utility today**; rotating it orphans all existing ciphertext. Document this gap; a `cli.py rotate-encryption-key` (re-encrypt all stored secrets) is a future S/M add.
- **`POSTGRES_PASSWORD`** — must be changed in both `.env` and the running Postgres role (`ALTER USER`), in that order.

Capture the ordering constraints in a `SECRETS.md` runbook.

---

## 5. Other Long-Term QoL

Ranked by leverage; all reuse existing helper functions, but the CLI commands and Makefile targets below are **net-new** (today `app/cli.py` has only a `user` sub-command group; the Makefile has no `doctor`/`backup`/etc.).

**(a) `python -m app.cli doctor` — preflight (S, do first).** A net-new Typer command that composes existing helpers (`validate_production_secrets()` at `config.py:116`, `/health/ready`, the secret regex) into a standalone check runnable *before* `docker compose up` and in CI: secrets set + entropy of `FLOWMINER_ENCRYPTION_KEY`, **warn if the `SECRET_KEY`-derived fallback is active**, DB `SELECT 1`, Redis ping, upload-dir writable, and **`alembic current == heads`**. Non-zero exit on any red. ~100 lines.

**(b) Extend the existing HealthTab + `/system-settings/health` (S, next).** **The admin system-health UI already exists** — `frontend/src/components/Settings/HealthTab.tsx` is admin-gated, calls `/system-settings/health`, renders every `ComponentStatus` (database, redis, encryption, llm_provider, smtp, upload_dir) with color-coded badges and a Refresh button, and already shows an **amber warning when encryption is the `SECRET_KEY`-derived fallback**. Do **not** build a new `/admin/system` page. Instead, extend `SystemHealthResponse` + `HealthTab.tsx` with the missing fields: alembic head state, Celery queue depth (`LLEN` on the default `celery` Redis key — no named queues configured, so this is correct; no Flower needed), active worker count (`celery inspect ping`, 2s timeout, cached 60s), and `upload_data` disk usage. Effort **S** (extension, not a new page). This eliminates any need for a separate Flower deploy.

**(c) `python -m app.cli supportpacket` (M, next).** A net-new command producing a single redacted `.zip` for support tickets: scrubbed `.env` (reuse `logging_setup.py._SENSITIVE_KEY_RE` — *never* copy `.env` raw), `alembic current/heads`, `docker compose ps`, last 500 log lines, queue depth, `pg_database_size`, `du -sh` of uploads, version. Highest support-throughput multiplier — currently every ticket needs manual log gathering.

**(d) Opt-in update check (M, next) — privacy-respecting.** `GET /api/v1/version` returns `{current, latest, needs_update}` where `latest` comes from the GitHub Releases API cached 1h in Redis. Frontend shows an admin-only dismissible banner. Gate behind `UPDATE_CHECK_ENABLED: bool = True` (operators can disable for air-gap). For any *outbound* beacon, make it **`FLOWMINER_TELEMETRY=False` by default** — for a sovereignty product, one unsolicited startup HTTP call destroys trust. Document a `FLOWMINER_AIR_GAP=1` that suppresses all optional external calls.

**Offline-transfer via `docker save | docker load`.** Document this as an air-gap sales tool — **but note the multi-arch caveat**: GHCR images are `amd64+arm64` manifest lists, and `docker save` on an amd64 host saves only the amd64 layer. Air-gap transfers must pass `--platform linux/amd64` (or the target arch) explicitly, or the manifest transfers partially.

**(e) Scaling knobs as env vars (S).** Compose hardcodes `--workers 1` (line 165) and `--concurrency=2` (line 206). Expose `CELERY_WORKER_CONCURRENCY` and add `--max-tasks-per-child ${CELERY_WORKER_MAX_TASKS_PER_CHILD:-200}` (pm4py accumulates memory; without this the worker OOM-kills rather than recycling). Add a sizing table to docs: ≤10k events → 1 worker/conc 2/2GB; 10k–100k → 2 workers/conc 4/4GB; >100k → `docker compose up --scale worker=N`.

**(f) Editions hook (S).** Add `FLOWMINER_EDITION: str = "community"` + a 3-line `is_enterprise()` helper, single image, env-gated (the `DEMO_MODE` pattern proves this works). **Don't gate SAML** — it is already opt-in via `SAML_ENABLED` (`saml.py:31`), a sufficient deployment-level gate. The natural first candidates for edition-gating are **audit-log export** (`audit_logs.py` exists, no plan gate) and multi-team admin features. **No license server** — that's an M follow-on only after revenue justifies it.

**(g) Helm chart fixes (M — but one is a hard crash).** Real blockers: **no beat Deployment template** (scheduled tasks never run), **no migrate Job** (replicas race), `secrets.secretKey` defaults to the literal `"change-me-in-production"`, and — most severe — **the beat container is missing `SECRET_KEY` entirely** (`worker-deployment.yaml` line 73: it has `REDIS_URL`/`DATABASE_URL`/`SYNC_DATABASE_URL` but no `SECRET_KEY`, unlike the worker container at line 32). Because `config.py:145` runs `validate_production_secrets()` at import, **beat hard-crashes on boot with `InsecureConfigurationError` in production ENV** — a guaranteed boot failure for any Helm deploy. If Helm is a near-term channel, this is do-next, not later.

**(h) Observability — Prometheus (M, later).** `prometheus-fastapi-instrumentator` (3 lines in `main.py`) + a `celery-exporter` sidecar (`danihodovic/celery-exporter`, requires `worker_send_task_events=True`). **Audience split:** `/metrics` serves external ops tooling (Grafana/PagerDuty); the HealthTab (§5b) serves the product's own admin UI — build both deliberately. **Keep `/metrics` off the public Traefik port** (it leaks queue depth/error rates) — internal-only or behind Traefik `ipWhiteList`/`basicAuth`. Structured JSON logging + Sentry (opt-in) already exist. Add a `LOG_LEVEL` env var (currently hardcoded `INFO` in `logging_setup.py:150`) and add `SIEM_HEC_URL`/`SIEM_HEC_TOKEN` to `.env.example` — they exist in `deploy/helm/flowminer/values.yaml` (lines 40–41) but are absent from the compose `.env.example` path.

**(i) Plan-tier admin surface (S, later).** `teams.plan` (free/standard/enterprise) drives `TIER_LIMITS` but there's no API/CLI to change it (`TeamUpdate` at `teams.py:30` has only `name`; `update_team` writes only `name`). Add a `plan` field or a `cli.py team set-plan` subcommand so operators stop editing SQL.

---

## 6. Prioritized Roadmap

| # | Item | Theme | Effort | Impact | Depends-on |
|---|---|---|---|---|---|
| **DO FIRST** | | | | | |
| 1 | Add `postgresql-client-16` to `backend/Dockerfile`; switch backup task to `pg_dump -Fc` (drop manual gzip); move output to `backup_data` volume | Backups | S | Critical — backups currently silently no-op + are pg_restore-incompatible | — |
| 2 | Thread `VERSION` build-arg → `ENV FLOWMINER_VERSION` in **both** Dockerfiles → `config.py`; remove stale `APP_VERSION` from `.env.example` | Updates | S | High — `/health` truth, prereq for upgrade UX | — |
| 3 | Tag `v0.1.0`; switch `release.yml` to metadata-action + `v0.1`/`v0`/`stable`; reconcile GHCR namespace across release.yml/values.yaml/CHANGELOG | Updates | S | Critical — unblocks self-host without source build | 2 |
| 4 | Flip `docker-compose.yml` off `:local` → pinned GHCR tag; fix the false CHANGELOG "pinned tags" claim | Updates | S | High | 3 |
| 5 | `make backup` + `make restore-test` + document `FLOWMINER_ENCRYPTION_KEY` separate backup | Backups | S | Critical — sovereignty table-stakes | 1 |
| 6 | `python -m app.cli doctor` preflight (net-new command) | QoL | S | High — support deflection | — |
| 7 | Raw event-log download `GET /event-logs/{id}/download` | Export | S | High — sovereignty credibility hole | — |
| 8 | XES export `GET /export/{id}/xes` | Export | S | High — biggest interop gap | — |
| **DO NEXT** | | | | | |
| 9 | One-shot `migrate` compose service + drop `alembic upgrade head` from `init_db()`; **Helm migrate Job** | Updates | M | High — Helm correctness + visibility | 4 |
| 10 | Schema-newer-than-image guard in `database.py` | Updates | S | High — data-loss prevention | — |
| 11 | Helm: add beat `SECRET_KEY`, beat Deployment, replace `change-me-in-production` default | QoL/Updates | S | High — beat hard-crashes in prod ENV today | — |
| 12 | `scripts/upgrade.sh` + `make upgrade` (backup→pull→migrate→up→verify) + Dokploy variant | Updates | S | High — #1 self-host ticket category | 4,5,9 |
| 13 | Interop CSV + Parquet export (dup timestamp for Apromore/Celonis) | Export | S | High | 7,8 |
| 14 | OCEL 2.0 download (`write_ocel2_*`, json/xml/sqlite) | Export | S | Med-High | — |
| 15 | `UPGRADE.md` + `MIGRATION_RUNBOOK.md` + `SECRETS.md` + CHANGELOG upgrade-notes/versions-to-avoid | Updates/Backups | S | High — sovereignty/transfer story | 10,12 |
| 16 | restic off-box backup (compose override → B2 S3 endpoint, GFS, failure alert) | Backups | M | High | 5 |
| 17 | Extend HealthTab + `/system-settings/health` (queue depth, worker count, migration state, disk) | QoL | S | Med-High — UI already exists, extend not rebuild | — |
| 18 | `app.cli supportpacket` (net-new command) | QoL | M | Med-High | 6 |
| 19 | Opt-in `/api/v1/version` update check + admin banner (air-gap toggle, multi-arch save note) | QoL | M | Med | 3 |
| 20 | Expand/contract migration rules in `CONTRIBUTING.md` | Updates | S | Med — prevents first bad migration | — |
| **LATER** | | | | | |
| 21 | Beat schedule `beat_data` named volume (stop thundering-herd on restart) | Backups | S | Med | — |
| 22 | BPMN-as-file + PNML export | Export | S | Med | 8 |
| 23 | Celery concurrency env vars + `--max-tasks-per-child` + sizing table | QoL | S | Med | — |
| 24 | `FLOWMINER_EDITION` + `is_enterprise()` hook (gate audit-log export, not SAML) | QoL | S | Med — monetization foundation | — |
| 25 | OCEL→XES flatten export | Export | M | Low-Med | 8,14 |
| 26 | Prometheus instrumentator + celery-exporter (internal-only `/metrics`) | QoL | M | Med (SaaS) | — |
| 27 | Team plan-tier admin API/CLI; `LOG_LEVEL` env; add SIEM vars to `.env.example` | QoL | S | Low-Med | — |
| 28 | Fix `etl.py:204` `UPLOAD_DIR` `/tmp` fallback → `settings.UPLOAD_DIR` | Backups | S | Low — but silent data loss if unset | — |
| 29 | `cli.py rotate-encryption-key` re-encryption utility | Backups | M | Low-Med | — |
| 30 | Weekly CI restore-test job | Backups | M | Med | 5 |

---

## 7. Explicitly DON'T Build (push-back)

- **PITR / WAL-G / pgBackRest / Barman.** 6-hour RPO via `pg_dump` covers ~95% of needs for a pre-1.0 single-node app. PITR needs custom Postgres config, WAL archiving, lag monitoring. Revisit only at DB > 50GB or a contractual <1h RPO. If ever needed, prefer WAL-G (simpler setup). Stub WAL-G env vars in `.env.example` to document the upgrade path; build nothing.
- **A Celonis EMS/CEML push-connector.** Large maintenance surface for a tool you're positioning against. Pull-export (CSV/Parquet/XES) covers the real switcher workflow.
- **Flower.** Unauthenticated by default, periods of abandoned maintenance. Queue depth via `LLEN` + the HealthTab extension covers the need; `celery-exporter` is the production path.
- **Watchtower / any auto-update of stateful services.** Archived Dec 2025; universally advised against for Postgres/Redis. Manual `make upgrade` after reading CHANGELOG is correct. Renovate-PR if you want bump assistance.
- **A real license-key server.** `FLOWMINER_EDITION` env check is enough until there's revenue.
- **Separate SaaS vs self-hosted images.** PostHog's cautionary tale — divergence + backport debt. Single image, env-gated (`DEMO_MODE`/`FLOWMINER_EDITION`). Already the right architecture; keep it.
- **Blue-green / zero-downtime migration tooling (pgroll, etc.).** All 13 migrations are additive; you have one replica. The migrate-service + a 5–30min maintenance window is appropriate. Encode expand/contract *rules* now; don't build automated zero-downtime infra.
- **HPA / autoscaling in Helm.** `docker compose up --scale worker=N` and fixed Helm replicas are fine pre-1.0.
- **Streaming/chunked XES export and the full project-manifest file-bundling rewrite.** Defer the BPIC-scale XES streaming path. The raw-download endpoint (#7) solves "get my data out" more directly.
- **Don't promise a multi-step `alembic downgrade` as full rollback.** One migration is irreversible (`c4d5e6f7a8b9`) and the baseline downgrade drops all tables. Single-step `alembic downgrade -1` is fine for reversing one standard migration; a full version revert = restore the pre-upgrade backup + revert the image tag. Never `alembic downgrade base`.
