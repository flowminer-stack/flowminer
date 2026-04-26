.PHONY: dev prod setup migrate seed clean test

# Development
dev:
	docker compose up -d db redis
	@echo "Waiting for services..."
	@sleep 3
	@echo "Starting backend..."
	cd backend && uvicorn app.main:app --reload --port 8000 &
	@echo "Starting frontend..."
	cd frontend && npm run dev &
	@echo "Starting worker..."
	cd backend && celery -A app.workers.celery_app worker --loglevel=info &

dev-docker:
	docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

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

# Test
test-backend:
	cd backend && python -m pytest tests/ -v

test-frontend:
	cd frontend && npm test
