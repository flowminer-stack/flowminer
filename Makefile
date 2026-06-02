.PHONY: init-env dev prod setup migrate seed clean test test-quick test-backend test-frontend localhost wait

# First-run helper — generate .env with strong secrets.
init-env:
	./scripts/init-env.sh $(if $(force),--force,)

# Dev: full stack with hot-reload bind mounts. Foregrounded so logs
# are visible. The legacy `make dev` target that backgrounded uvicorn
# / vite / celery with `&` was removed — those processes were reaped
# the moment make exited, so the target had been quietly broken.
dev:
	docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

# Localhost — direct self-host without a reverse proxy. Publishes
# the SPA on host port 3000 (or $$FLOWMINER_FRONTEND_PORT). Don't
# use this on Dokploy / Traefik / production hosts where another
# stack already owns port 3000.
localhost:
	docker compose -f docker-compose.yml -f docker-compose.localhost.yml up -d

# Block until /health/ready returns 200 — eg. after `make localhost`
# so a new operator doesn't have to keep poking `docker compose ps`.
wait:
	./scripts/wait-ready.sh

# One-shot: start the stack on localhost AND wait for it to be ready.
up: localhost wait

# Production
prod:
	docker compose --profile production up --build -d

# Setup
setup:
	cd backend && pip install -r requirements.txt
	cd frontend && npm install

# Database
migrate:
	cd backend && alembic upgrade head

migrate-create:
	cd backend && alembic revision --autogenerate -m "$(msg)"

# Seed templates
seed:
	curl -X POST http://localhost:8000/api/v1/templates/seed -H "Authorization: Bearer $(token)"

# Clean
clean:
	docker compose down -v
	rm -rf frontend/node_modules frontend/dist
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

# Test — regression gate. `make test` runs backend pytest + frontend
# typecheck + build (see scripts/run-tests.sh). Run it after making changes.
test:
	./scripts/run-tests.sh

# Faster inner loop: skip the vite build, keep backend tests + tsc.
test-quick:
	./scripts/run-tests.sh --quick

# Granular targets. test-backend prefers the backend venv interpreter, falling
# back to python3, so it works whether or not a venv is set up.
test-backend:
	cd backend && PY=$$([ -x venv/bin/python ] && echo venv/bin/python || command -v python3 || echo python); $$PY -m pytest tests/ -q -W ignore

# `npm test` is wired to `tsc --noEmit` (type regressions). A unit-test runner
# (vitest) needs a network install; tsc + the vite build are the offline gate.
test-frontend:
	cd frontend && npm test
