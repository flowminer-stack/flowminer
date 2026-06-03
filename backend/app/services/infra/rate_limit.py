"""Rate limiting using slowapi with Redis as the shared backend.

Rationale:
  - Login needs brute-force protection (dictionary attacks, credential stuffing)
  - Mining endpoints are CPU-expensive — a single abusive user can pin a worker
  - Audit log queries can scan a lot of rows — rate-limit to keep them cheap

The limiter's key function is the authenticated user ID when a valid JWT is
present, falling back to the client IP. This gives logged-in users per-user
quotas and lets unauthenticated flows (login) share an IP bucket.
"""

from __future__ import annotations

import logging

from fastapi import Request
from jose import jwt
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.responses import JSONResponse

from app.config import settings

logger = logging.getLogger(__name__)


def _key(request: Request) -> str:
    """Prefer the JWT subject; fall back to client IP for anonymous callers."""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        token = auth.split(" ", 1)[1]
        try:
            payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
            sub = payload.get("sub")
            if sub:
                return f"user:{sub}"
        except Exception:
            pass
    return f"ip:{get_remote_address(request)}"


limiter = Limiter(
    key_func=_key,
    storage_uri=settings.REDIS_URL or "memory://",
    default_limits=[],  # Opt-in per-route, not a blanket limit
)


# ─── Tiered rate limits ──────────────────────────────────────────────────
# The values below are the per-user per-minute budget for heavy endpoints,
# resolved by the caller's team plan. The per-route @limiter.limit()
# decorator still applies for unauthenticated endpoints (like /login);
# these tiers layer on top for authenticated heavy calls.

TIER_LIMITS = {
    "free": {
        "mining_per_hour": 60,
        "llm_per_hour": 20,
        "connector_syncs_per_hour": 10,
        "task_events_per_minute": 5000,
    },
    "standard": {
        "mining_per_hour": 300,
        "llm_per_hour": 200,
        "connector_syncs_per_hour": 60,
        "task_events_per_minute": 20000,
    },
    "enterprise": {
        "mining_per_hour": 3000,
        "llm_per_hour": 2000,
        "connector_syncs_per_hour": 600,
        "task_events_per_minute": 200000,
    },
}


def limits_for_plan(plan: str) -> dict:
    """Look up the numeric limits for a team's plan. Unknown plans fall
    back to `free`."""
    return TIER_LIMITS.get((plan or "free").lower(), TIER_LIMITS["free"])


def mining_limit_for(user) -> str:
    """Return a slowapi-style limit string for mining endpoints, based on
    the user's team plan. Used as a per-route decorator argument."""
    plan = getattr(getattr(user, "team", None), "plan", None) if user else None
    n = limits_for_plan(plan)["mining_per_hour"]
    return f"{n}/hour"


def llm_limit_for(user) -> str:
    plan = getattr(getattr(user, "team", None), "plan", None) if user else None
    n = limits_for_plan(plan)["llm_per_hour"]
    return f"{n}/hour"


async def rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    """Return a JSON 429 instead of slowapi's default plaintext response."""
    return JSONResponse(
        status_code=429,
        content={
            "detail": "Rate limit exceeded — slow down and retry after a moment.",
            "limit": str(exc.detail),
        },
    )
