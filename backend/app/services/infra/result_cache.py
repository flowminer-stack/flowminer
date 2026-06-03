"""Shared Redis-backed result cache for mining endpoints.

Falls back to a local BoundedCache if Redis is unreachable at startup
(development convenience) — that way the tests can run without a
live Redis instance. In production ``REDIS_URL`` is always set.

The cache stores JSON-serialized values with a TTL so stale data ages
out automatically. Keys use a ``flowminer:cache:<event_log_id>:<kind>:<hash>``
shape so ``clear_prefix(event_log_id)`` can efficiently purge every entry
tied to an event log (e.g. after a column-mapping change).
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)

# Default TTL for cached mining results. Long enough that repeat views
# of the same page are fast, short enough that stale results age out
# without manual invalidation.
_DEFAULT_TTL_SECONDS = 60 * 60 * 12  # 12 hours


class LocalBoundedCache:
    """In-process fallback cache used when Redis is unavailable."""

    def __init__(self, maxsize: int = 500) -> None:
        self._data: dict[str, Any] = {}
        self._maxsize = maxsize

    def get(self, key: str) -> Any:
        return self._data.get(key)

    def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        # TTL is ignored for the local fallback — it exists for API parity
        # with the Redis version.
        if len(self._data) >= self._maxsize:
            # Evict oldest 20% of entries.
            victims = list(self._data.keys())[: self._maxsize // 5]
            for k in victims:
                self._data.pop(k, None)
        self._data[key] = value

    def clear_prefix(self, prefix: str) -> None:
        victims = [k for k in self._data if k.startswith(prefix)]
        for k in victims:
            self._data.pop(k, None)


class RedisResultCache:
    """Redis-backed cache with the same ``get``/``set``/``clear_prefix`` shape."""

    def __init__(self, client) -> None:
        self._client = client

    def get(self, key: str) -> Any:
        try:
            raw = self._client.get(key)
        except Exception as e:
            logger.warning("redis.get failed (%s) — falling through", e)
            return None
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None

    def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        try:
            payload = json.dumps(value, default=str)
        except (TypeError, ValueError) as e:
            logger.debug("redis.set skipped — value not JSON-serializable: %s", e)
            return
        try:
            self._client.set(key, payload, ex=ttl or _DEFAULT_TTL_SECONDS)
        except Exception as e:
            logger.warning("redis.set failed (%s)", e)

    def clear_prefix(self, prefix: str) -> None:
        try:
            # SCAN is non-blocking. For our cache sizes (a few hundred keys
            # per event log) this is cheap.
            cursor = 0
            while True:
                cursor, keys = self._client.scan(cursor=cursor, match=f"{prefix}*", count=200)
                if keys:
                    self._client.delete(*keys)
                if cursor == 0:
                    break
        except Exception as e:
            logger.warning("redis.clear_prefix failed (%s)", e)


def _build_cache():
    """Try Redis first, fall back to in-process bounded cache."""
    if not settings.REDIS_URL:
        return LocalBoundedCache()
    try:
        import redis  # lazy import so tests without redis-py still work

        client = redis.from_url(settings.REDIS_URL, decode_responses=True)
        client.ping()
        return RedisResultCache(client)
    except Exception as e:
        logger.warning("Falling back to in-process result cache: %s", e)
        return LocalBoundedCache()


# Module-level singleton
_cache = _build_cache()


def make_key(event_log_id: str, kind: str, params_hash: str = "none") -> str:
    return f"flowminer:cache:{event_log_id}:{kind}:{params_hash}"


def cache_get(event_log_id: str, kind: str, params_hash: str = "none") -> Any:
    return _cache.get(make_key(event_log_id, kind, params_hash))


def cache_set(event_log_id: str, kind: str, value: Any, params_hash: str = "none", ttl: int | None = None) -> None:
    _cache.set(make_key(event_log_id, kind, params_hash), value, ttl=ttl)


def cache_clear_event_log(event_log_id: str) -> None:
    """Remove every cached entry tied to an event log. Used when column
    mappings change or the underlying file is replaced."""
    _cache.clear_prefix(f"flowminer:cache:{event_log_id}:")
