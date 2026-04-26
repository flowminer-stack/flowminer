# Contributing to FlowMiner

Thanks for wanting to help. FlowMiner is an open-source
process-mining platform with a Python backend, React frontend, and
a pluggable LLM layer. This document tells you how to get set up,
how the codebase is organised, and the rules we'd like contributors
to follow.

---

## Quick start (local development)

Requirements:

- Docker Engine 20.10+ with the Compose V2 plugin
  (`docker compose`, not the legacy `docker-compose`)
- ~8 GB RAM free for the containers
- A copy of this repo

Steps:

```bash
# 1. Clone
git clone https://github.com/<you>/flowminer.git
cd flowminer

# 2. Create your .env from the template
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, REDIS_PASSWORD, SECRET_KEY, and
# FLOWMINER_ENCRYPTION_KEY. Commands that generate strong values
# are inside .env.example.

# 3. Start the full stack with hot-reload for dev
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

# 4. Wait ~30s for migrations to finish, then open
#    http://localhost:3000 in a browser.
#    The first user to register is auto-promoted to admin. To
#    promote a later user, use the ops CLI:
docker compose exec backend python -m app.cli user promote \
  --email you@example.com
```

That's it — edits under `./backend` and `./frontend` hot-reload
without rebuilding.

---

## Repo layout

```
flowminer/
├── backend/            # FastAPI + Celery
│   ├── app/
│   │   ├── api/        # FastAPI routers, one file per resource
│   │   ├── models/     # SQLAlchemy ORM models
│   │   ├── schemas/    # Pydantic request/response models
│   │   ├── services/   # Business logic (mining, LLM, connectors, ...)
│   │   ├── workers/    # Celery tasks (beat schedule, background jobs)
│   │   ├── mcp/        # Model Context Protocol server (stdio)
│   │   ├── config.py   # Pydantic-settings env loader
│   │   ├── database.py # Async + sync SQLAlchemy engines
│   │   └── main.py     # FastAPI app, middleware wiring, router registration
│   ├── alembic/        # DB migrations
│   ├── scripts/        # One-off dev scripts (prompt tuning, bench, etc.)
│   └── tests/
├── frontend/           # React + Vite + Zustand + Tailwind
│   ├── src/
│   │   ├── api/        # API client (auth, mining, ai, ...)
│   │   ├── components/ # Reusable UI grouped by feature
│   │   ├── pages/      # Top-level routed pages
│   │   ├── store/      # Zustand slices (ui, auth, filters, ...)
│   │   ├── types/      # Shared TypeScript types
│   │   └── hooks/      # Custom React hooks
│   └── nginx.conf      # Serves the built SPA + proxies /api to backend
├── docs/               # User + contributor documentation
│   ├── examples/       # Sample event logs (OCEL, XES, CSV)
│   ├── roadmap/        # Feature planning notes
│   └── mcp-claude-desktop.md
├── deploy/             # Kubernetes / helm / BI integration stubs
├── docker-compose.yml       # Production-safe default
├── docker-compose.dev.yml   # Dev override (hot-reload, bind mounts)
├── Makefile
├── CONTRIBUTING.md          # ← you are here
├── LICENSE
├── SECURITY.md
└── README.md
```

---

## Coding standards

### Backend (Python)

- **Python 3.11.** Use type hints on all new public functions.
- **PEP 8** via `ruff check`. Line length is 100 (not 79).
- **Imports**: stdlib → third-party → local, blank line between groups.
- **Docstrings**: every public module and function. Prefer a
  one-sentence summary followed by a paragraph explaining *why*
  something is the way it is, not just *what* it does. The rest of
  the codebase is written this way — match the tone.
- **No `print()`** in production code. Use the `logging` module
  (structlog is wired up in `services/logging_setup.py`).
- **Error handling**: catch at the boundary, not the middle. Inside
  a service function it's usually fine to let exceptions propagate.
- **DB access**: async session via `Depends(get_db)` for request
  handlers. Sync engine (`app.database.sync_engine`) only for
  subprocess paths and the MCP server.
- **Tests**: pytest + async. Add tests alongside new features under
  `backend/tests/`.

### Frontend (TypeScript / React)

- **TypeScript strict mode.** No `any` without a `// eslint-disable`
  comment explaining why.
- **Functional components only.** No class components.
- **Zustand for state.** Don't add a new state manager; split the
  existing store into more slices if it's getting unwieldy.
- **Tailwind utility classes.** No CSS files (except the one Vite
  entry). Keep class lists legible — multi-line ternaries are fine.
- **API calls via `@/api/client`.** Don't call `fetch` directly from
  components.
- **File naming**: PascalCase for components and pages, camelCase
  for hooks and utilities.
- **Imports**: react / third-party / `@/` (internal) / relative.

### Git + commits

- **Branch naming**: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`,
  `refactor/<topic>`, `chore/<topic>`.
- **Commit messages**: short imperative subject line (≤60 chars),
  blank line, a body if the *why* isn't obvious from the subject.
  Conventional-Commits prefixes (`feat:`, `fix:`, etc.) are
  welcome but not required.
- **Squash-merge PRs** unless there's a strong reason to preserve
  individual commits.
- **Never force-push to `main`.**

---

## Adding a new analysis

Most features fall into one of two buckets:

### 1. A new "classical" mining analysis

Example: you want to add a new bottleneck metric.

1. Add the computation as a method on the relevant service in
   `backend/app/services/` (usually `mining_engine.py` delegates
   to a submodule — e.g. `discovery.py`, `conformance.py`).
2. Add a Pydantic response schema in `backend/app/schemas/`.
3. Add an endpoint in the matching router under
   `backend/app/api/` — follow the existing pattern, including
   the `_assert_event_log_access` call for row-level authorization.
4. Add a client method in `frontend/src/api/client.ts`.
5. Use it from a page or component.
6. Write tests.

### 2. A new AI tool

Example: you want the chat panel to be able to call a new
backend operation.

1. Add a new entry to `CHAT_TOOL_SCHEMAS` in
   `backend/app/services/chat_tools.py` using the OpenAI
   function-calling format.
2. Add a runner function `_run_your_tool(df, args)` returning
   the standard envelope `{data, render, summary}`.
3. Add a case in `_RUNNERS`.
4. Add a new render type in `frontend/src/api/client.ts` if the
   tool returns a shape not already supported.
5. Add a renderer component in
   `frontend/src/components/AI/FloatingAIChat.tsx`.

---

## Running the test suites

```bash
# Backend
docker compose exec backend pytest -xvs

# Frontend
docker compose exec frontend npm test  # once we ship vitest setup
```

The security audit expects this project to reach ≥70% coverage on
critical paths (auth, mining, conformance, LLM routing) before we
tag a 1.0 release. Patches that add coverage are very welcome.

---

## Reporting security issues

Do NOT open a public GitHub issue for a security vulnerability.
See `SECURITY.md` for the disclosure process.

---

## Licensing

By contributing you agree that your contribution is released
under the MIT License (see `LICENSE`).
