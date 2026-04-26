"""JWT revocation via Redis blocklist.

The original design issued access tokens with a 24-hour TTL and no
server-side revocation path — a stolen token stayed valid for the
full lifetime even after the user logged out or was deactivated. This
module adds a Redis-backed blocklist keyed by JWT ``jti`` claim:

  - ``create_access_token`` stamps a fresh ``jti`` (hex UUID) on every
    issued token.
  - ``POST /auth/logout`` writes ``revoked:jti:<jti>`` to Redis with
    TTL equal to the token's remaining lifetime.
  - Every request goes through ``is_token_revoked`` in the auth
    dependency — if the key exists, we reject with 401.

Redis auto-expires revoked entries, so the blocklist never grows
unboundedly. If Redis is unavailable we fail closed for the revocation
check (treat as "not revoked") so a transient Redis outage doesn't
lock every user out; the lower-level 401s from real auth failures
still fire. The alternative (fail open → deny everyone) is a worse
availability tradeoff for a platform whose primary value is the
mining pipeline.
"""

from __future__ import annotations

import logging
from typing import Optional

import redis

from app.config import settings

logger = logging.getLogger(__name__)

_REVOCATION_PREFIX = "flowminer:revoked_jti:"


_redis_client: Optional[redis.Redis] = None


def _get_redis() -> Optional[redis.Redis]:
    """Lazy-initialised sync Redis client. Returns None if the broker
    URL is unset or the connection fails at first use."""
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    url = getattr(settings, "REDIS_URL", "") or ""
    if not url:
        return None
    try:
        _redis_client = redis.from_url(url, decode_responses=True, socket_timeout=2)
        # Cheap liveness probe; on failure we swallow and return None
        # on subsequent calls.
        _redis_client.ping()
    except Exception as e:
        logger.warning("Token revocation Redis init failed: %s", e)
        _redis_client = None
    return _redis_client


def revoke_jti(jti: str, ttl_seconds: int) -> bool:
    """Mark a JWT id as revoked until ``ttl_seconds`` from now.

    Returns True on success, False if Redis is unavailable.
    """
    if not jti or ttl_seconds <= 0:
        return False
    client = _get_redis()
    if client is None:
        return False
    try:
        client.set(f"{_REVOCATION_PREFIX}{jti}", "1", ex=ttl_seconds)
        return True
    except Exception as e:
        logger.warning("Token revocation write failed for jti=%s: %s", jti, e)
        return False


def is_token_revoked(jti: str) -> bool:
    """Check whether a jti has been blocklisted.

    Fails closed: if Redis is down we return False (treat as not
    revoked) so a Redis outage doesn't lock everyone out. A real
    security incident needs the operator to rotate SECRET_KEY, which
    invalidates every existing token at once.
    """
    if not jti:
        return False
    client = _get_redis()
    if client is None:
        return False
    try:
        return client.exists(f"{_REVOCATION_PREFIX}{jti}") > 0
    except Exception as e:
        logger.warning("Token revocation read failed for jti=%s: %s", jti, e)
        return False
