# Security Policy

FlowMiner is an open-source process-mining platform that handles
business process data that may include PII, financial records, or
operational details. We take security reports seriously and want
to make it easy to report issues privately.

## Reporting a vulnerability

If you believe you've found a security vulnerability in FlowMiner,
please **do not open a public GitHub issue**. Instead:

1. Email **security@flowminer.io** with:
   - A description of the vulnerability
   - Steps to reproduce (proof-of-concept if possible)
   - The impact you've observed or believe is possible
   - Your GitHub username (optional — for credit in the advisory)
2. You'll get an acknowledgement within 72 hours.
3. We'll work with you on a fix and a coordinated disclosure timeline
   (usually 30–90 days depending on severity).
4. You'll be credited in the security advisory unless you'd prefer
   to stay anonymous.

## Supported versions

FlowMiner is pre-1.0. Security fixes ship on the `main` branch
only. Once 1.0 lands we'll support the most recent minor release
for at least 12 months.

## Security-relevant defaults

When you deploy FlowMiner with the default `docker-compose.yml`,
the following protections are active out of the box:

- All long-running services run as non-root users
  (`flowminer` uid 1000 for the backend, `nginx` for the frontend).
- Postgres and Redis bind only to `127.0.0.1` on the host, not to
  `0.0.0.0`. They are reachable only via the internal Docker
  network by default.
- The backend refuses to start in `ENV=production` with any
  insecure default secrets (`SECRET_KEY`, `DATABASE_URL`,
  `REDIS_URL`). See `backend/app/config.py:validate_production_secrets`.
- Every authenticated request runs through an audit middleware
  that scrubs sensitive body fields (`password`, `token`,
  `api_key`, etc.) before persisting.
- JWTs are revocable — `POST /api/v1/auth/logout` adds the
  token's `jti` to a Redis blocklist until the token's original
  expiry.
- SQL sandbox (`/api/v1/analytics/sql-sandbox`) refuses to run
  if DuckDB's `enable_external_access` setting can't be
  disabled, so a query that smuggles `read_csv_auto('/etc/passwd')`
  past the denylist still cannot read host files.
- API keys for LLM providers (OpenRouter, Anthropic, OpenAI) are
  stored Fernet-encrypted at rest in the `system_settings`
  table. The plaintext key is never returned by any API
  endpoint — only a `has_api_key` flag and the last 4
  characters.
- All LLM completions and streaming responses are grounded in
  the event log's actual data via the context-builder pipeline.
  The LLM is never given database credentials, file-system
  paths, or user-session tokens.

## Things the operator must still do

- **Generate your own secrets.** `.env.example` shows the
  `openssl rand -hex 32` commands. Default values from the
  example file will cause the backend to refuse to start
  in production.
- **Rotate secrets periodically.** Rotate `SECRET_KEY`,
  `FLOWMINER_ENCRYPTION_KEY`, and any provider API keys on
  your own schedule. Rotating `FLOWMINER_ENCRYPTION_KEY`
  will make existing encrypted connector credentials and
  stored LLM API keys unreadable — plan accordingly.
- **Put TLS in front.** The stock `docker-compose.yml` ships
  the SPA on plain HTTP. Run a TLS-terminating reverse proxy
  (Traefik, Caddy, Cloudflare, a managed load balancer)
  between the internet and the `frontend` / `nginx` containers.
- **Back up the Postgres volume.** `docker-compose.yml` uses a
  named Docker volume for `postgres_data`. Running `pg_dump` on
  a schedule is on you.
- **Review CORS.** The backend's `CORS_ORIGINS` is an allowlist.
  Don't add wildcards in production.

## Out of scope

- Rate-limiting at the nginx layer — we rate-limit at the
  application layer via slowapi, but not at the edge. Use a CDN
  or a reverse proxy if you need L7 throttling.
- TLS cert management — not something FlowMiner itself does.
- Multi-tenant isolation for the public-preview
  `/api/v1/dashboards/shared/{share_token}` route — anyone with
  the token sees the dashboard. Keep your share tokens secret.
