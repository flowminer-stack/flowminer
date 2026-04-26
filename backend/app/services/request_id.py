"""Request ID middleware.

Assigns every incoming request a unique UUID (or picks up the X-Request-ID
header if the client sent one — useful for distributed tracing), stores it
in a contextvar so every log line inside the request gets stamped with it,
and echoes it back on the response so clients can correlate their logs
with server logs.

Implemented as a pure ASGI middleware (not ``BaseHTTPMiddleware``) because
``BaseHTTPMiddleware`` buffers streaming responses — it waits for the full
body before forwarding them — which breaks the AI chat stream and any
other ``StreamingResponse`` endpoint. Pure ASGI wraps ``send`` instead of
consuming the response object, so chunks flow through untouched.
"""

from __future__ import annotations

import uuid

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Receive, Scope, Send

from app.services.logging_setup import request_id_ctx


class RequestIDMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Look up x-request-id from the incoming request headers.
        incoming = None
        for key, value in scope.get("headers", []):
            if key == b"x-request-id":
                incoming = value.decode("latin-1")
                break
        rid = incoming if incoming else uuid.uuid4().hex
        token = request_id_ctx.set(rid)

        async def send_wrapper(message: dict) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["X-Request-ID"] = rid
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            request_id_ctx.reset(token)
