"""Structured logging configuration.

Every log line is rendered as a JSON object with a stable schema:
    {"ts": ..., "level": ..., "logger": ..., "msg": ..., "request_id": ..., ...}

Per-request correlation IDs are stored in a contextvar so any code path
inside a request (including Celery-invoked functions) can log with the
correct request_id without threading it through every call site.

Sentry is initialized lazily — only if ``SENTRY_DSN`` is set. In
development mode without a DSN, Sentry is a no-op.
"""

from __future__ import annotations

import logging
import re
import sys
from contextvars import ContextVar
from typing import Any

import structlog

from app.config import settings

# ContextVar used by the middleware and by structlog's processor below.
request_id_ctx: ContextVar[str | None] = ContextVar("request_id", default=None)


def _add_request_id(logger, method_name, event_dict):
    """Structlog processor that stamps the current request_id onto every event."""
    rid = request_id_ctx.get()
    if rid is not None:
        event_dict["request_id"] = rid
    return event_dict


# ── secret scrubbing ────────────────────────────────────────────────────

# Keys whose values should never appear in logs. Lowercased for the
# case-insensitive membership check below.
_SENSITIVE_KEY_RE = re.compile(
    r"(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|"
    r"private[_-]?key|client[_-]?secret|authorization|auth|"
    r"bearer|cookie|session[_-]?id|csrf|otp|mfa|totp)",
    re.IGNORECASE,
)

# Bearer token regex for free-form strings — catches a JWT or API key
# embedded in an exception message. Matches "Bearer xxxx..." and the
# three-dot JWT shape.
_BEARER_RE = re.compile(r"Bearer\s+[A-Za-z0-9\-_.=]+", re.IGNORECASE)
_JWT_RE = re.compile(r"\b[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\b")
_FMK_RE = re.compile(r"\bfmk_[A-Za-z0-9_\-]{10,}\b")

_REDACTED = "[REDACTED]"


def _scrub_value(value: Any) -> Any:
    """Recursively redact values inside a dict/list/tuple by key name,
    and scrub bearer tokens / JWTs / API keys out of string bodies.
    """
    if isinstance(value, dict):
        return {k: _scrub_item(k, v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(_scrub_value(v) for v in value)
    if isinstance(value, str):
        redacted = _BEARER_RE.sub("Bearer " + _REDACTED, value)
        redacted = _JWT_RE.sub(_REDACTED, redacted)
        redacted = _FMK_RE.sub(_REDACTED, redacted)
        return redacted
    return value


def _scrub_item(key: Any, value: Any) -> Any:
    """Scrub one (key, value) pair: redact when the key name matches a
    sensitive pattern, otherwise recurse."""
    if isinstance(key, str) and _SENSITIVE_KEY_RE.search(key):
        return _REDACTED
    return _scrub_value(value)


def _scrub_secrets(logger, method_name, event_dict):
    """Structlog processor that removes secrets from every log event.

    Applies the key-based filter to every field of the event dict,
    plus a string-level scrub of the free-form ``event`` message so
    an embedded "Bearer eyJ..." in a raised exception doesn't make
    it into the JSON output.
    """
    scrubbed = {}
    for k, v in event_dict.items():
        scrubbed[k] = _scrub_item(k, v)
    # Catch the case where a dev forgot to use a field and inlined
    # the secret into the message string.
    msg = scrubbed.get("event")
    if isinstance(msg, str):
        scrubbed["event"] = _scrub_value(msg)
    return scrubbed


def configure_logging() -> None:
    """Install JSON structlog rendering and route stdlib logging through it.

    Called once at application startup from ``app.main``.
    """
    timestamper = structlog.processors.TimeStamper(fmt="iso")

    shared_processors = [
        structlog.contextvars.merge_contextvars,
        _add_request_id,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        timestamper,
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        # Secret scrubbing runs last so it operates on the final
        # event dict (after format_exc_info has expanded tracebacks
        # into strings) and can catch keys / tokens inside those
        # stringified stack frames.
        _scrub_secrets,
    ]

    # structlog produces native BoundLoggers that render JSON on stdout.
    structlog.configure(
        processors=[
            *shared_processors,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    # Pipe stdlib logging through structlog so anything that uses plain
    # ``logging.getLogger(...).info(...)`` (pm4py, uvicorn, celery, etc.)
    # ends up in the same JSON stream.
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared_processors,
        processor=structlog.processors.JSONRenderer(),
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    # Clear any handlers that uvicorn may have installed so we get clean JSON.
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)

    # Quiet down a couple of chatty third-party loggers.
    for noisy in ("uvicorn.access", "watchfiles", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def init_sentry() -> None:
    """Initialize Sentry if SENTRY_DSN is configured. Cheap no-op otherwise."""
    if not settings.SENTRY_DSN:
        return
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration

        sentry_sdk.init(
            dsn=settings.SENTRY_DSN,
            traces_sample_rate=0.1,
            profiles_sample_rate=0.1,
            environment=settings.ENV,
            release=settings.APP_VERSION,
            integrations=[FastApiIntegration(), StarletteIntegration()],
        )
        structlog.get_logger().info("sentry.initialized", environment=settings.ENV)
    except Exception as e:
        structlog.get_logger().warning("sentry.init_failed", error=str(e))


def get_logger(name: str | None = None) -> Any:
    """Shorthand for ``structlog.get_logger`` with a consistent interface."""
    return structlog.get_logger(name) if name else structlog.get_logger()
