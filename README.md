# FlowMiner

Open-source process mining platform. Upload an event log, get an
interactive process map, drill into bottlenecks and variants, and
ask an AI assistant about your process in plain English.

<p align="center">
  <img src="docs/media/screenshot-process-map.png" alt="Process map screenshot" width="720" />
</p>

> **Status:** actively developed, pre-1.0. API is mostly stable, UI
> is still evolving. Issues and PRs welcome.

---

## Features

**Process mining**
- Directly-follows graph, inductive miner, heuristic miner,
  alpha miner
- Variant explorer with happy-path comparison
- Bottleneck + rework + conformance analysis
- Dotted chart, process spectrum, social network, four-eyes
- Animated process replay
- OCEL 2.0 object-centric process mining (OC-DFG, OC-Petri-net,
  object lifecycle, cross-object improvement reports)
- Case clustering, declare-rule discovery, log skeleton,
  feature export, agent mining

**AI, grounded in your data**
- Floating Ask-AI chat panel scoped to the current log
- Tool-use mode: the LLM calls backend tools and renders charts
  or filter proposals inline in the chat
- OCPM improvement narrative tuned against real findings (with
  resource-type detection and legitimate-wait reclassification
  so it doesn't tell you to "cut inventory dwell in half")
- Provider-agnostic — works with OpenRouter, Anthropic, OpenAI,
  Ollama, or the built-in null provider for demos
- Model Context Protocol (MCP) server so Claude Desktop / Cursor
  / Zed can query your FlowMiner instance as a tool

**Collaboration**
- Projects with role-based access (admin / analyst / viewer)
- Annotations, case tags, dashboards, scheduled PDF reports
- Audit log of every mutation
- JWT auth with token revocation
- Optional SAML / SSO

**Operational**
- Postgres + Redis + Celery worker + beat scheduler
- Connectors: CSV, XES, OCEL 2.0, REST API, SQL databases,
  Jira, GitHub, Zendesk, Odoo
- Scheduled ingestion + alerting
- Data-quality + timestamp-repair tools

---

## Quick start

Requirements: Docker Engine 20.10+ with the `docker compose` V2
plugin (not the legacy `docker-compose` Python package).

```bash
# 1. Clone
git clone https://github.com/<you>/flowminer.git
cd flowminer

# 2. Create your .env from the template
cp .env.example .env
# Edit .env: generate real secrets for SECRET_KEY, POSTGRES_PASSWORD,
# REDIS_PASSWORD, and (recommended) FLOWMINER_ENCRYPTION_KEY.
# The .env.example file has the openssl/python commands inline.

# 3. Start the full stack (production-safe defaults)
docker compose up -d

# 4. Wait for health checks
docker compose ps

# 5. Open the UI
open http://localhost:3000
```

**First run:**

1. Register a user at `http://localhost:3000/register`
2. Promote yourself to admin (we don't ship a default admin on purpose):
   ```bash
   docker compose exec db psql -U flowminer -d flowminer \
     -c "UPDATE users SET role='admin' WHERE email='you@example.com';"
   ```
3. Log in, create a project, upload `docs/examples/running-example.csv`.
4. Map columns (Case ID / Activity / Timestamp) — FlowMiner will
   auto-detect for standard formats.
5. Explore the process map.

**Want the AI features?** After logging in as an admin, go to
`Settings → AI` and paste an OpenRouter / Anthropic / OpenAI key.
Keys are encrypted at rest with the server-side encryption key.

---

## Development

Dev mode bind-mounts the source trees into the containers and runs
uvicorn + Vite with hot-reload:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

Edits under `./backend` and `./frontend` apply immediately.

For more detail — how to add a new analysis, how to add a new AI
tool, code style, testing — see [`CONTRIBUTING.md`](./CONTRIBUTING.md).

---

## Architecture

```
┌────────────────────┐     ┌────────────────────────┐
│  React SPA (Vite)  │────▶│  FastAPI backend       │
│  Tailwind + Zustand│     │  (uvicorn, 2 workers)  │
└────────┬───────────┘     └──────┬─────────────────┘
         │                        │
         ▼                        ▼
     nginx SPA                 PostgreSQL 16
     (static bundle)           (primary store)
                                  │
                                  ▼
                            Celery worker ◀── Redis (broker)
                                  │
                                  ▼
                            Celery beat
```

**Backend stack**

- FastAPI 0.135 + uvicorn
- SQLAlchemy 2 (async) + Alembic migrations
- pm4py for process mining primitives
- Celery + Redis for background work
- Fernet-based symmetric encryption for secrets at rest
- Pluggable LLM layer (anthropic / openai / openrouter / ollama /
  null) with streaming + tool-use

**Frontend stack**

- React 18 + TypeScript strict mode
- Vite 5, Tailwind CSS
- Zustand for global state, React Router for routing
- Cytoscape.js for process map rendering
- Recharts for charts

**Data flow**

Event log upload → parsed into pandas DataFrame → column mapping →
cached in Redis keyed by event-log ID → mining endpoints pull from
the cache → React SPA renders results.

---

## Documentation

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to set up, build, test,
  and add features
- [`SECURITY.md`](./SECURITY.md) — security model, secret handling,
  how to report vulnerabilities
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- [`docs/mcp-claude-desktop.md`](./docs/mcp-claude-desktop.md) —
  connect Claude Desktop to FlowMiner via MCP
- [`docs/examples/`](./docs/examples/) — sample event logs
- [`docs/roadmap/`](./docs/roadmap/) — open planning notes

---

## License

MIT. See [`LICENSE`](./LICENSE).
