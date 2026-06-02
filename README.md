# FlowMiner

**The depth of Celonis, the self-host freedom of open source — without
the AGPL trap, the open-core paywall, or the six-figure non-cancelable
contract.**

FlowMiner is a complete, self-hostable process mining platform —
process discovery, conformance, simulation, object-centric mining, and
a data-grounded AI assistant — under a permissive MIT licence, that
runs on a 4GB VPS you control. Upload an event log, get an interactive
process map, drill into bottlenecks and variants, and ask an AI
assistant about your process in plain English.

<p align="center">
  <img src="docs/media/screenshot-process-map.png" alt="Process map screenshot" width="720" />
</p>

> **Status:** actively developed, pre-1.0. API is mostly stable, UI
> is still evolving. Issues and PRs welcome.

## Why FlowMiner

Process mining usually asks you to trade depth for freedom. The
commercial platforms (Celonis, Signavio) are deep but cloud-only,
priced in six figures, and sold on multi-year contracts that put your
data on someone else's infrastructure. The open-source tools are free
but either copyleft (pm4py is AGPL-3.0), open-core (Apromore walls
conformance, simulation, and connectors behind its enterprise edition
and archived its OSS repos), or a research toolkit with no product
around it. FlowMiner refuses the trade.

| | **FlowMiner** | Celonis | Apromore CE | Disco | pm4py |
|---|---|---|---|---|---|
| **License** | MIT (permissive) | Proprietary | Open-core | Proprietary | AGPL-3.0 (copyleft) |
| **Self-host** | Yes — full stack | No (cloud-only) | CE only; rest enterprise | Desktop only | Yes (library) |
| **Conformance** | Yes | Yes | Enterprise tier | No | Yes (library) |
| **Simulation** | Yes (discrete-event) | Yes | Enterprise tier | No | Partial (library) |
| **OCEL / object-centric** | Yes — OCEL 2.0 + state-aware OCPM | Yes (flagship) | Limited | No | Yes (library) |
| **AI assistant** | Yes — grounded chat + MCP | Yes (cloud) | No | No | No |
| **Connectors** | CSV, XES, OCEL 2.0, REST, SQL, Jira, GitHub, Zendesk, Odoo | 150+ (enterprise) | Enterprise tier | File import | File import (library) |
| **Pricing** | Free (MIT) | Six-figure, multi-year | Free CE / paid enterprise | Per-seat licence | Free (AGPL) |

The headline reasons to switch:

- **Permissive MIT.** No AGPL trap, no open-core paywall — conformance,
  simulation, object-centric mining, every connector, and the AI
  assistant are all in this one repository under the one licence.
- **Your data, your exit.** Full project export to JSON
  (`GET /projects/{id}/export`), analysis export to CSV / Excel /
  BPMN, OCEL 2.0 in and out, and any-source ingestion mean no lock-in
  — no three-year non-cancelable contract and no per-query data-access
  tax. (The Celonis-vs-SAP data-access dispute and the S/4HANA
  migration deadline are exactly the kind of toll booth this avoids.)
- **No Center of Excellence, no SI engagement, no proprietary query
  language.** Auto column-mapping on upload, a data-anchored AI chat
  instead of Celonis's PQL, and an Extraction Copilot that writes the
  SQL for you.
- **Disco-fast to start.** `git clone` → first process map in minutes
  on a 4GB VPS — no Apromore CE Java 8 / MySQL 5.6 / Kafka install
  dance, no ProM Gatekeeper friction.
- **On-prem and sovereign by default.** Regulated buyers that cloud-only
  Celonis/Signavio structurally cannot serve. Privacy is, precisely,
  **pseudonymisation + RBAC + audit** — the built-in anonymiser is a
  deterministic, *reversible* hash, so RBAC is the real boundary, not
  the hash.
- **Object-centric process mining open and MIT.** OCEL 2.0 plus
  state-aware OCPM — the capability Celonis is proudest of. (OPerA-style
  performance overlays are on the near-term roadmap, not shipped yet.)

Read the full argument, including the honest caveats, in
[`docs/why-flowminer.md`](./docs/why-flowminer.md).

---

## Features

**Process mining**
- Directly-follows graph, inductive miner, heuristic miner,
  alpha miner
- Variant explorer with happy-path comparison
- Bottleneck + rework + conformance analysis
- Discrete-event simulation (Simod-style) for what-if scenarios
- Dotted chart, process spectrum, social network, four-eyes
- Animated process replay
- OCEL 2.0 object-centric process mining (OC-DFG, OC-Petri-net,
  object lifecycle, state-aware OCPM, cross-object improvement reports)
- Case clustering, declare-rule discovery, log skeleton,
  feature export, agent mining

**AI, grounded in your data**
- Floating Ask-AI chat panel scoped to the current log
- Tool-use mode: the LLM calls backend tools and renders charts
  or filter proposals inline in the chat
- Extraction Copilot — conversational helper that writes the SQL to
  turn raw source-system tables into a clean event log
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
- Pseudonymisation + per-role raw-data gating + full audit log
- Full project export/import (JSON manifest); analysis export to
  CSV / Excel / BPMN
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

# 2. Generate a .env with strong secrets
make init-env
# (Or run `./scripts/init-env.sh` directly. The script generates
#  SECRET_KEY, POSTGRES_PASSWORD, REDIS_PASSWORD, and a Fernet
#  FLOWMINER_ENCRYPTION_KEY; everything else is left at template
#  defaults for you to fill in.)

# 3. Start the full stack and wait until it's ready
make up
# (`make up` runs `make localhost` then `make wait`. The wait step
#  polls /health/ready until DB + Redis report healthy — usually
#  30-90s on a cold first build, near-instant on subsequent boots.)

# 4. Open the UI
open http://localhost:3000
```

**First run:**

1. Register a user at `http://localhost:3000/register`. The first
   registration on a fresh deployment is automatically promoted to
   admin — no manual SQL needed.
2. Log in, create a project, upload `docs/examples/running-example.csv`.
3. Map columns (Case ID / Activity / Timestamp) — FlowMiner will
   auto-detect for standard formats.
4. Explore the process map.

> **Deploying behind a reverse proxy / Dokploy / Traefik?** Skip the
> `docker-compose.localhost.yml` override — the bare
> `docker-compose.yml` keeps the SPA off any host port and lets your
> proxy route traffic to the container over the Docker network.

**Want the AI features?** After logging in as an admin, go to
`Settings → AI` and paste an OpenRouter / Anthropic / OpenAI key.
Keys are encrypted at rest with the server-side encryption key.

### Ops CLI

For routine user management — promoting an admin, resetting a
forgotten password, unlocking an account — FlowMiner ships a small
typed CLI inside the backend container. No raw SQL needed.

```bash
docker compose exec backend python -m app.cli user list
docker compose exec backend python -m app.cli user promote --email alice@corp.com
docker compose exec backend python -m app.cli user demote  --email alice@corp.com
docker compose exec backend python -m app.cli user reset-password --email alice@corp.com
```

`reset-password` without `--password` generates a strong random one
and prints it once at the end — copy it immediately. Run
`docker compose exec backend python -m app.cli --help` to see every
command (also covers `activate` / `deactivate`).

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
