"""Demo write-guard middleware (armed only when DEMO_MODE is set)."""

import logging

from app.config import settings

logger = logging.getLogger(__name__)


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
