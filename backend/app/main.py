import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest

from app.config import settings
from app.database import init_db
from app.services.infra.audit import AuditLogMiddleware
from app.services.infra.logging_setup import configure_logging, init_sentry, request_id_ctx
from app.services.infra.rate_limit import limiter, rate_limit_handler
from app.services.infra.request_id import RequestIDMiddleware
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


class DemoWriteGuardMiddleware:
    """Block file uploads and destructive mutations for the demo user.

    Only armed when ``settings.DEMO_MODE`` is true. Uses a blocklist
    approach: everything is allowed EXCEPT the specific endpoints that
    create/delete data (upload, project CRUD, settings, user mgmt).
    This avoids the whack-a-mole of maintaining an allowlist every
    time a new analytics endpoint is added.

    Pure ASGI (not BaseHTTPMiddleware) to avoid buffering streaming
    responses from endpoints like ``/api/v1/ai/chat``.
    """

    # Only block PUT/PATCH/DELETE unconditionally + POST on specific paths.
    # Most POST endpoints are read-only analytics queries with request bodies.
    _ALWAYS_BLOCKED_METHODS = {"PUT", "PATCH", "DELETE"}

    # POST requests to these prefixes are blocked for the demo user.
    # Everything else (mining, AI, competitive, OCEL, analytics, etc.)
    # is allowed through.
    _BLOCKED_POST_PREFIXES = (
        "/api/v1/event-logs/upload",
        "/api/v1/event-logs/ingest",
        "/api/v1/projects",
        "/api/v1/admin/",
        "/api/v1/settings",
        "/api/v1/users",
        "/api/v1/teams",
        "/api/v1/api-keys",
        "/api/v1/connectors",
        "/api/v1/scheduled-reports",
        "/api/v1/privacy",
    )

    def __init__(self, app) -> None:
        self.app = app
        # The demo user's UUID is resolved lazily on first request so
        # this middleware can be instantiated before the seeder runs.
        self._demo_user_id: str | None = None

    async def _resolve_demo_user_id(self) -> str | None:
        if self._demo_user_id is not None:
            return self._demo_user_id
        try:
            from app.database import async_session
            from app.models import User
            from sqlalchemy import select

            async with async_session() as session:
                result = await session.execute(
                    select(User.id).where(User.email == settings.DEMO_USER_EMAIL)
                )
                row = result.first()
                if row is None:
                    return None
                self._demo_user_id = str(row[0])
                return self._demo_user_id
        except Exception:
            logger.exception("demo guard: failed to resolve demo user id")
            return None

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or not settings.DEMO_MODE:
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "").upper()
        if method == "GET":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")

        # PUT/PATCH/DELETE are always blocked for the demo user.
        # POST is only blocked on specific write-heavy endpoints.
        if method == "POST":
            is_blocked = any(path.startswith(p) for p in self._BLOCKED_POST_PREFIXES)
            if not is_blocked:
                await self.app(scope, receive, send)
                return
        elif method not in self._ALWAYS_BLOCKED_METHODS:
            await self.app(scope, receive, send)
            return

        # Decode the bearer token from headers. We tolerate missing /
        # malformed tokens by just passing through — the route's own
        # auth dependency will reject the request normally.
        auth_header = ""
        for name, value in scope.get("headers", []):
            if name == b"authorization":
                auth_header = value.decode("latin-1", errors="ignore")
                break
        if not auth_header.lower().startswith("bearer "):
            await self.app(scope, receive, send)
            return

        token = auth_header.split(None, 1)[1].strip()
        try:
            from jose import jwt, JWTError
            payload = jwt.decode(
                token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
            )
            sub = str(payload.get("sub") or "")
        except Exception:
            # Token couldn't be decoded — let the route reject it.
            await self.app(scope, receive, send)
            return

        if not sub:
            await self.app(scope, receive, send)
            return

        demo_user_id = await self._resolve_demo_user_id()
        if demo_user_id is None or sub != demo_user_id:
            await self.app(scope, receive, send)
            return

        # It's the demo user hitting an unsafe non-allowlisted endpoint.
        import json as _json

        body = _json.dumps(
            {
                "detail": (
                    "Demo sessions are read-only. Self-host FlowMiner "
                    "to upload logs, create projects, or change settings — "
                    "see https://github.com/flowminer/flowminer."
                ),
                "demo_mode": True,
            }
        ).encode("utf-8")

        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


class SecurityHeadersMiddleware:
    """Adds standard security headers to every HTTP response.

    Implemented as pure ASGI middleware (not ``BaseHTTPMiddleware``)
    because the latter buffers streaming response bodies, breaking
    ``StreamingResponse`` endpoints like ``/api/v1/ai/chat``.
    """

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                from starlette.datastructures import MutableHeaders
                headers = MutableHeaders(scope=message)
                headers["X-Content-Type-Options"] = "nosniff"
                headers["X-Frame-Options"] = "DENY"
                headers["X-XSS-Protection"] = "1; mode=block"
                headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
                headers["Permissions-Policy"] = (
                    "geolocation=(), microphone=(), camera=(), payment=()"
                )
                # HSTS only in production — we don't want to pin a dev
                # hostname to HTTPS during local Docker testing.
                if settings.ENV.lower() == "production":
                    headers["Strict-Transport-Security"] = (
                        "max-age=31536000; includeSubDomains; preload"
                    )
                # CSP — conservative defaults for the API host. The SPA
                # serves its own CSP via nginx; this protects the docs
                # page and any directly-served HTML (e.g. /docs).
                headers["Content-Security-Policy"] = (
                    "default-src 'self'; "
                    "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; "
                    "style-src 'self' 'unsafe-inline' cdn.jsdelivr.net; "
                    "img-src 'self' data: https:; "
                    "font-src 'self' data: cdn.jsdelivr.net; "
                    "connect-src 'self'; "
                    "frame-ancestors 'none';"
                )
            await send(message)

        await self.app(scope, receive, send_wrapper)


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
    ("app.api.competitive", "/api/v1/competitive", ["competitive"]),
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
