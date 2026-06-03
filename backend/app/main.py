import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse

from app.config import settings
from app.database import init_db
from app.services.infra.audit import AuditLogMiddleware
from app.services.infra.logging_setup import configure_logging, init_sentry, request_id_ctx
from app.services.infra.rate_limit import limiter, rate_limit_handler
from app.services.infra.request_id import RequestIDMiddleware
from app.middleware.demo_guard import DemoWriteGuardMiddleware
from app.middleware.security_headers import SecurityHeadersMiddleware
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

logger = logging.getLogger(__name__)

# Install JSON structlog as the first thing the process does, so even
# startup errors come out as structured records.
configure_logging()
init_sentry()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup and shutdown events."""
    # Startup
    await init_db()
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)

    # Sample-data seeder. Runs whenever either:
    #   - DEMO_MODE=1 — full public-demo behaviour (seed + lock-down +
    #     anonymous /auth/demo + hourly Celery purge), or
    #   - SEED_SAMPLE_DATA_ON_FIRST_BOOT=1 — seed only, no lock-down.
    # The seeder is idempotent (skips projects whose name already
    # exists for the demo user), so a container restart never
    # duplicates data. Any exception here is logged but doesn't
    # prevent the app from starting — sample data is a best-effort
    # convenience on top of the real product.
    if settings.DEMO_MODE or settings.SEED_SAMPLE_DATA_ON_FIRST_BOOT:
        try:
            from app.database import async_session
            from app.services.demo_seeder import seed_demo_data

            async with async_session() as session:
                await seed_demo_data(session)
            mode = "demo mode" if settings.DEMO_MODE else "sample-data seed"
            logger.info("%s: seed complete", mode)
        except Exception:
            logger.exception("sample-data seed failed — continuing anyway")

    yield
    # Shutdown (cleanup if needed)


_IS_PRODUCTION = settings.ENV.lower() == "production"

app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="Open-source web-based process mining platform",
    lifespan=lifespan,
    redirect_slashes=False,
    # Disable the interactive docs / OpenAPI schema in production so we
    # don't publish the full API surface to unauthenticated crawlers.
    docs_url=None if _IS_PRODUCTION else "/docs",
    redoc_url=None if _IS_PRODUCTION else "/redoc",
    openapi_url=None if _IS_PRODUCTION else "/openapi.json",
)

# CORS middleware. `allow_credentials=True` requires an explicit origin
# allowlist (which we have). Methods and headers are restricted to
# what the SPA actually uses rather than the earlier wildcard.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "authorization",
        "content-type",
        "accept",
        "origin",
        "x-request-id",
        "x-requested-with",
    ],
    expose_headers=["X-Request-ID"],
    max_age=600,
)


# Global exception handler: in production, never leak internal error
# messages or stack traces. Log the full exception server-side with
# the request ID so operators can correlate, return a generic message
# to the caller. In dev we still expose the message for fast debugging.
@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    rid = request_id_ctx.get("-") if request_id_ctx else "-"
    logger.exception(
        "Unhandled exception on %s %s (request_id=%s)",
        request.method,
        request.url.path,
        rid,
    )
    if _IS_PRODUCTION:
        detail = "Internal server error"
    else:
        # Truncate in case a library dumps a multi-KB error message.
        detail = f"{type(exc).__name__}: {str(exc)[:200]}"
    return JSONResponse(
        status_code=500,
        content={"detail": detail, "request_id": rid},
        headers={"X-Request-ID": rid},
    )


app.add_middleware(SecurityHeadersMiddleware)
# Demo write-guard — no-op unless DEMO_MODE is on. Must come after
# SecurityHeaders (so the 403 still picks up CSP + HSTS) and before
# the route dispatch so the blocked write never reaches a handler.
app.add_middleware(DemoWriteGuardMiddleware)
app.add_middleware(AuditLogMiddleware)
# RequestIDMiddleware must wrap everything else so the contextvar is set
# before any downstream middleware or handler logs.
app.add_middleware(RequestIDMiddleware)

# Rate limiting — attaches a limiter state to `request.app` and installs
# the 429 handler. Individual routes opt in via @limiter.limit(...).
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, rate_limit_handler)
app.add_middleware(SlowAPIMiddleware)

# --- Router registration ---
# Each import is wrapped individually so the application can start even when
# some modules have not been implemented yet.

_routers: list[tuple[str, str, list[str]]] = [
    ("app.api.auth", "/api/v1/auth", ["auth"]),
    ("app.api.users", "/api/v1/users", ["users"]),
    ("app.api.projects", "/api/v1/projects", ["projects"]),
    ("app.api.event_logs", "/api/v1/event-logs", ["event-logs"]),
    ("app.api.mining", "/api/v1/mining", ["mining"]),
    ("app.api.mining_reports", "/api/v1/mining", ["mining"]),
    ("app.api.search", "/api/v1/search", ["search"]),
    ("app.api.dashboards", "/api/v1/dashboards", ["dashboards"]),
    ("app.api.alerts", "/api/v1/alerts", ["alerts"]),
    ("app.api.connectors", "/api/v1/connectors", ["connectors"]),
    ("app.api.templates", "/api/v1/templates", ["templates"]),
    ("app.api.annotations", "/api/v1/annotations", ["annotations"]),
    ("app.api.ocel", "/api/v1/ocel", ["ocel"]),
    ("app.api.ocel_improvements", "/api/v1/ocel", ["ocel"]),
    ("app.api.scheduled_reports", "/api/v1/scheduled-reports", ["scheduled-reports"]),
    ("app.api.case_tags", "/api/v1/case-tags", ["case-tags"]),
    ("app.api.custom_kpis", "/api/v1/kpis", ["kpis"]),
    ("app.api.version_history", "/api/v1/versions", ["versions"]),
    ("app.api.privacy", "/api/v1/privacy", ["privacy"]),
    ("app.api.etl", "/api/v1/etl", ["etl"]),
    ("app.api.streaming", "/api/v1/streaming", ["streaming"]),
    ("app.api.initiatives", "/api/v1/initiatives", ["initiatives"]),
    ("app.api.action_rules", "/api/v1/action-rules", ["action-rules"]),
    ("app.api.analytics", "/api/v1/analytics", ["analytics"]),
    ("app.api.log_builder", "/api/v1/log-builder", ["log-builder"]),
    ("app.api.audit_logs", "/api/v1/audit-logs", ["audit-logs"]),
    ("app.api.lineage", "/api/v1/lineage", ["lineage"]),
    ("app.api.sso", "/api/v1/auth", ["sso"]),
    ("app.api.password_reset", "/api/v1/auth", ["auth"]),
    ("app.api.teams", "/api/v1/teams", ["teams"]),
    ("app.api.project_io", "/api/v1/projects", ["project-io"]),
    ("app.api.api_keys", "/api/v1/api-keys", ["api-keys"]),
    ("app.api.ai", "/api/v1/ai", ["ai"]),
    ("app.api.ai_tools", "/api/v1/ai", ["ai"]),
    ("app.api.task_mining", "/api/v1/task-mining", ["task-mining"]),
    ("app.api.journeys", "/api/v1/journeys", ["journeys"]),
    ("app.api.change_requests", "/api/v1/change-requests", ["change-requests"]),
    ("app.api.usage", "/api/v1/usage", ["usage"]),
    ("app.api.scorecards", "/api/v1/scorecards", ["scorecards"]),
    ("app.api.saml", "/api/v1/auth", ["saml"]),
    ("app.api.bi", "/api/v1/bi", ["bi"]),
    ("app.api.process_analytics", "/api/v1/competitive", ["competitive"]),
    ("app.api.governance", "/api/v1/governance", ["governance"]),
    ("app.api.overview", "/api/v1", ["overview"]),
    ("app.api.tasks", "/api/v1/tasks", ["tasks"]),
    ("app.api.system_settings", "/api/v1/system-settings", ["system-settings"]),
]

for module_path, prefix, tags in _routers:
    try:
        # Dynamic import of the router module
        import importlib

        module = importlib.import_module(module_path)
        app.include_router(module.router, prefix=prefix, tags=tags)
    except (ImportError, AttributeError) as e:
        print(f"Warning: Could not import router from {module_path}: {e}")


# --- Core endpoints ---


@app.get("/health", tags=["health"])
async def health_check():
    """Lightweight liveness probe — returns 200 as long as the process is up."""
    return {"status": "healthy", "app": settings.APP_NAME, "version": settings.APP_VERSION}


@app.get("/health/ready", tags=["health"])
async def readiness_check():
    """Deep readiness probe — verifies DB and Redis are actually reachable.

    Load balancers should point at this one before routing real traffic.
    Returns 503 if any dependency is down so k8s / compose pull the pod
    out of rotation.
    """
    from fastapi import HTTPException, status as http_status
    from sqlalchemy import text

    from app.database import engine

    checks = {"database": False, "redis": False}

    # DB check
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        checks["database"] = True
    except Exception as e:
        checks["database_error"] = str(e)

    # Redis check
    try:
        import redis as _redis

        client = _redis.from_url(settings.REDIS_URL, decode_responses=True, socket_timeout=2)
        client.ping()
        checks["redis"] = True
    except Exception as e:
        checks["redis_error"] = str(e)

    if not (checks["database"] and checks["redis"]):
        raise HTTPException(status_code=http_status.HTTP_503_SERVICE_UNAVAILABLE, detail=checks)

    return {"status": "ready", **checks, "app": settings.APP_NAME, "version": settings.APP_VERSION}


@app.get("/", tags=["root"])
async def root():
    """Root endpoint returning application information."""
    return {
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "description": "Open-source web-based process mining platform",
        "docs": "/docs",
        "health": "/health",
        "api_prefix": "/api/v1",
    }


@app.get("/api/v1/demo/status", tags=["demo"])
async def demo_status():
    """Unauthenticated — lets the frontend detect whether this instance
    is a locked-down demo (auto-login, banner, read-only writes).

    Returns ``{"demo_mode": false}`` on every normal deployment."""
    return {
        "demo_mode": bool(settings.DEMO_MODE),
        "demo_user_email": settings.DEMO_USER_EMAIL if settings.DEMO_MODE else None,
    }
