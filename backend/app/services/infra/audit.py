"""Audit log middleware.

Intercepts every non-GET request on the API, and — if it succeeds and the
user is authenticated — persists a row in ``audit_logs``. Designed to have
zero impact on the happy path: all DB work happens *after* the response is
sent back to the client, via a background task on the event loop.

Why it lives in services/ and not api/: it's a framework-level concern used
by ``app.main`` rather than a per-router thing.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any
from uuid import UUID

from fastapi import Request, Response
from jose import jwt
from sqlalchemy import select
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import settings
from app.database import async_session
from app.models import AuditLog, User

logger = logging.getLogger(__name__)


# Paths we never want to log (they spam without signal).
_SKIP_PATHS = {
    "/health",
    "/",
    "/docs",
    "/redoc",
    "/openapi.json",
    "/api/v1/auth/login",      # Login attempts logged separately; body has password
    "/api/v1/auth/refresh",
}

# Keys that must be scrubbed from payload snapshots before persisting.
_SENSITIVE_KEYS = {
    "password",
    "current_password",
    "new_password",
    "secret",
    "api_key",
    "apikey",
    "token",
    "access_token",
    "refresh_token",
    "private_key",
    "client_secret",
}

# How much of the request body we keep. We don't want to store giant pipeline
# specs or file uploads in the audit table.
_MAX_PAYLOAD_BYTES = 4096


# Patterns for pulling a resource type + id out of the URL.
# Ordered by specificity — first match wins.
_RESOURCE_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"^/api/v1/projects/(?P<id>[0-9a-f-]+)"), "project"),
    (re.compile(r"^/api/v1/event-logs/(?P<id>[0-9a-f-]+)"), "event_log"),
    (re.compile(r"^/api/v1/dashboards/(?P<id>[0-9a-f-]+)"), "dashboard"),
    (re.compile(r"^/api/v1/alerts/(?P<id>[0-9a-f-]+)"), "alert"),
    (re.compile(r"^/api/v1/connectors/(?P<id>[0-9a-f-]+)"), "connector"),
    (re.compile(r"^/api/v1/templates/(?P<id>[0-9a-f-]+)"), "template"),
    (re.compile(r"^/api/v1/annotations/(?P<id>[0-9a-f-]+)"), "annotation"),
    (re.compile(r"^/api/v1/ocel/(?P<id>[0-9a-f-]+)"), "ocel"),
    (re.compile(r"^/api/v1/kpis/(?P<id>[0-9a-f-]+)"), "custom_kpi"),
    (re.compile(r"^/api/v1/case-tags/(?P<id>[0-9a-f-]+)"), "case_tag"),
    (re.compile(r"^/api/v1/scheduled-reports/(?P<id>[0-9a-f-]+)"), "scheduled_report"),
    (re.compile(r"^/api/v1/initiatives/(?P<id>[0-9a-f-]+)"), "initiative"),
    (re.compile(r"^/api/v1/action-rules/(?P<id>[0-9a-f-]+)"), "action_rule"),
    (re.compile(r"^/api/v1/etl/(?P<id>[0-9a-f-]+)"), "etl_pipeline"),
    (re.compile(r"^/api/v1/privacy/(?P<id>[0-9a-f-]+)"), "privacy_config"),
    (re.compile(r"^/api/v1/versions/(?P<id>[0-9a-f-]+)"), "version_history"),
    (re.compile(r"^/api/v1/users/(?P<id>[0-9a-f-]+)"), "user"),
]


def _extract_resource(path: str) -> tuple[str | None, str | None]:
    for pattern, resource_type in _RESOURCE_PATTERNS:
        m = pattern.match(path)
        if m:
            return resource_type, m.group("id")
    # Paths that don't target a specific resource (e.g. POST /api/v1/projects)
    for pattern, resource_type in [
        (re.compile(r"^/api/v1/projects"), "project"),
        (re.compile(r"^/api/v1/event-logs"), "event_log"),
        (re.compile(r"^/api/v1/dashboards"), "dashboard"),
    ]:
        if pattern.match(path):
            return resource_type, None
    return None, None


def _action_for(method: str) -> str:
    return {
        "POST": "create",
        "PUT": "update",
        "PATCH": "update",
        "DELETE": "delete",
    }.get(method, method.lower())


def _scrub(obj: Any) -> Any:
    """Recursively remove sensitive keys from a JSON-serializable structure."""
    if isinstance(obj, dict):
        return {
            k: ("<redacted>" if k.lower() in _SENSITIVE_KEYS else _scrub(v))
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [_scrub(v) for v in obj]
    return obj


def _user_id_from_bearer(authorization: str | None) -> UUID | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1]
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        sub = payload.get("sub")
        if sub is None:
            return None
        return UUID(sub)
    except Exception:
        return None


async def _persist_audit_entry(
    user_id: UUID | None,
    ip: str | None,
    user_agent: str | None,
    method: str,
    path: str,
    status_code: int,
    resource_type: str | None,
    resource_id: str | None,
    payload_snapshot: Any,
) -> None:
    try:
        async with async_session() as session:
            email = None
            if user_id is not None:
                result = await session.execute(select(User).where(User.id == user_id))
                user = result.scalar_one_or_none()
                if user is not None:
                    email = user.email

            entry = AuditLog(
                user_id=user_id,
                user_email=email,
                ip_address=ip,
                user_agent=user_agent,
                method=method,
                path=path,
                status_code=status_code,
                resource_type=resource_type,
                resource_id=resource_id,
                action=_action_for(method),
                payload_snapshot=payload_snapshot,
            )
            session.add(entry)
            await session.commit()
    except Exception as e:
        # Never let audit failures break the request response.
        logger.warning("Failed to persist audit log entry: %s", e)


class AuditLogMiddleware:
    """Records every mutating request to the audit_logs table.

    Only runs for POST / PUT / PATCH / DELETE on the /api/v1 tree. Skips
    static/health paths and failed (4xx/5xx) requests — we care about
    *successful* mutations. Payload is captured before the handler runs
    (so it can be scrubbed), user identity is pulled from the Authorization
    header, and the row write happens asynchronously in a background task
    after the response is returned.

    Implemented as pure ASGI middleware rather than ``BaseHTTPMiddleware``
    because the latter buffers ``StreamingResponse`` bodies — it reads the
    full response before passing it along — which completely breaks our
    streaming endpoints (``/api/v1/ai/chat`` most importantly). Pure ASGI
    wraps the ``send`` channel so streaming chunks flow through untouched.
    """

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope["method"].upper()
        path = scope["path"]

        # Fast path: not an auditable request — pass through without
        # touching the request or response channels.
        if (
            method == "GET"
            or method == "OPTIONS"
            or path in _SKIP_PATHS
            or not path.startswith("/api/v1")
        ):
            await self.app(scope, receive, send)
            return

        # ── Peek at the request body ─────────────────────────────────
        # Consume all `http.request` messages up front, build the full
        # body, snapshot a scrubbed version, then replay the body to the
        # downstream app via a custom receive channel.
        body_chunks: list[bytes] = []
        more_body = True
        while more_body:
            message = await receive()
            if message["type"] == "http.request":
                body_chunks.append(message.get("body", b""))
                more_body = message.get("more_body", False)
            else:
                # http.disconnect or similar — bail out and pass through.
                more_body = False
        raw_body = b"".join(body_chunks)

        payload: Any = None
        try:
            if raw_body:
                if len(raw_body) > _MAX_PAYLOAD_BYTES:
                    payload = {"_truncated": True, "bytes": len(raw_body)}
                else:
                    try:
                        payload = _scrub(
                            json.loads(raw_body.decode("utf-8", errors="replace"))
                        )
                    except json.JSONDecodeError:
                        payload = {"_non_json": True, "bytes": len(raw_body)}
        except Exception as e:
            logger.debug("Audit middleware body peek failed: %s", e)

        # Replay the cached body to the downstream app. Any subsequent
        # receive call (e.g. after the body is drained) should look like
        # a normal empty-body http.request to keep the ASGI contract.
        body_replayed = False

        async def replay_receive():
            nonlocal body_replayed
            if not body_replayed:
                body_replayed = True
                return {
                    "type": "http.request",
                    "body": raw_body,
                    "more_body": False,
                }
            # After the body has been delivered once, defer to the
            # original receive so http.disconnect events still propagate.
            return await receive()

        # ── Capture the response status without touching the body ───
        status_code_holder: dict[str, int] = {"status": 500}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status_code_holder["status"] = message.get("status", 500)
            await send(message)

        try:
            await self.app(scope, replay_receive, send_wrapper)
        finally:
            status_code = status_code_holder["status"]
            # Only log successful mutations (2xx). Failed ones are noise.
            if 200 <= status_code < 300:
                # Extract request metadata from the ASGI scope.
                auth_header = None
                user_agent = None
                for key, value in scope.get("headers", []):
                    if key == b"authorization":
                        auth_header = value.decode("latin-1")
                    elif key == b"user-agent":
                        user_agent = value.decode("latin-1")
                user_id = _user_id_from_bearer(auth_header)
                client = scope.get("client")
                ip = client[0] if client else None
                resource_type, resource_id = _extract_resource(path)

                import asyncio
                asyncio.create_task(
                    _persist_audit_entry(
                        user_id=user_id,
                        ip=ip,
                        user_agent=user_agent,
                        method=method,
                        path=path,
                        status_code=status_code,
                        resource_type=resource_type,
                        resource_id=resource_id,
                        payload_snapshot=payload,
                    )
                )
