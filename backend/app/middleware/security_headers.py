"""Security-headers middleware applied to every HTTP response."""

from app.config import settings


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
