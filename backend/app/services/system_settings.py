"""System-wide encrypted settings, with a short in-process cache.

The LLM provider configuration is the main use case. Before this
module existed, the only way to change provider or API key was to
edit ``.env`` and restart the backend — not viable for an open-source
install where the operator expects a Settings page in the UI. Values
are Fernet-encrypted at rest using the same key (``secret_box``) the
connector credentials use.

Read path
---------
``get_setting("llm.provider")`` returns the decrypted value or ``None``.
Results are memoized for 30 seconds in a process-local cache so the
hot ``llm.complete`` / ``llm.stream`` calls don't hit Postgres on
every invocation. The cache is invalidated whenever ``set_setting``
is called from the same process; cross-process invalidation is not
implemented because we expect provider changes to be rare and the
30-second ceiling is acceptable.

Write path
----------
``set_setting("llm.api_key", "sk-...", user_id=...)`` encrypts the
value and upserts into the table. Only admin-level callers should
invoke this (enforced by the router, not here).

Known keys
----------
``llm.provider``   — one of anthropic / openai / openrouter / ollama / null
``llm.api_key``    — the raw API key for the currently-selected provider
``llm.model``      — provider-specific model name (e.g. ``anthropic/claude-haiku-4-5``)
``llm.base_url``   — optional, used for OpenRouter / Azure / custom openai-compatible endpoints

Keys that do not start with ``llm.`` are accepted but reserved for
future use (feature flags, branding, etc.).
"""

from __future__ import annotations

import logging
import time
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session as SyncSession

from app.database import sync_engine
from app.models import SystemSetting
from app.services.infra.secret_box import decrypt_value, encrypt_value

logger = logging.getLogger(__name__)


_CACHE_TTL_SECONDS = 30.0
_cache: dict[str, tuple[float, Any]] = {}


def _now() -> float:
    return time.monotonic()


def _cached(key: str) -> Any | None:
    entry = _cache.get(key)
    if entry is None:
        return None
    stored_at, value = entry
    if _now() - stored_at > _CACHE_TTL_SECONDS:
        _cache.pop(key, None)
        return None
    return value


def _store(key: str, value: Any) -> None:
    _cache[key] = (_now(), value)


def invalidate_cache(key: str | None = None) -> None:
    """Drop cached settings. Pass a key to invalidate just one entry,
    or ``None`` to clear the whole cache."""
    if key is None:
        _cache.clear()
    else:
        _cache.pop(key, None)


def get_setting(key: str) -> Any | None:
    """Return the decrypted value for ``key``, or ``None`` if unset.

    Cheap — the result is memoized for 30 seconds per key. Safe to
    call from hot paths like ``llm.stream`` where every extra DB
    round-trip shows up in end-to-end latency.
    """
    cached = _cached(key)
    if cached is not None:
        return cached

    try:
        with SyncSession(sync_engine) as session:
            row = session.execute(
                select(SystemSetting).where(SystemSetting.key == key)
            ).scalar_one_or_none()
    except Exception as e:
        logger.warning("system_settings.get_setting(%s) failed: %s", key, e)
        return None

    if row is None or row.value_encrypted is None:
        _store(key, None)
        return None

    value = decrypt_value(row.value_encrypted)
    _store(key, value)
    return value


def get_llm_config() -> dict[str, Any]:
    """Convenience wrapper used by ``llm.py`` to resolve the LLM
    provider + credentials + model in one shot.

    Returns a dict with the resolved values. Any key not set in the
    system_settings table returns ``None`` — the caller then falls
    through to the matching environment variable.
    """
    return {
        "provider": get_setting("llm.provider"),
        "api_key": get_setting("llm.api_key"),
        "model": get_setting("llm.model"),
        "base_url": get_setting("llm.base_url"),
    }


def set_setting(key: str, value: Any, *, user_id=None) -> None:
    """Upsert a setting. ``value`` is JSON-serialized then Fernet-
    encrypted before hitting Postgres. Pass ``value=None`` to
    effectively delete the value (the row is kept but its encrypted
    payload is nulled, so audit history is preserved).
    """
    encrypted = encrypt_value(value) if value is not None else None
    with SyncSession(sync_engine) as session:
        row = session.execute(
            select(SystemSetting).where(SystemSetting.key == key)
        ).scalar_one_or_none()
        if row is None:
            row = SystemSetting(
                key=key,
                value_encrypted=encrypted,
                updated_by=user_id,
            )
            session.add(row)
        else:
            row.value_encrypted = encrypted
            row.updated_by = user_id
        session.commit()

    invalidate_cache(key)
    logger.info("system_settings: updated %s (cleared: %s)", key, value is None)


def set_llm_config(
    *,
    provider: str | None,
    api_key: str | None,
    model: str | None,
    base_url: str | None = None,
    user_id=None,
) -> None:
    """Batch update for the LLM config. Each field is independently
    nullable — pass ``None`` to clear a specific value while leaving
    the rest intact. Clearing the API key is how the operator
    switches back to a different provider's env-var credentials.
    """
    if provider is not None:
        set_setting("llm.provider", provider, user_id=user_id)
    if api_key is not None:
        set_setting("llm.api_key", api_key, user_id=user_id)
    if model is not None:
        set_setting("llm.model", model, user_id=user_id)
    if base_url is not None:
        set_setting("llm.base_url", base_url, user_id=user_id)


__all__ = [
    "get_setting",
    "set_setting",
    "get_llm_config",
    "set_llm_config",
    "invalidate_cache",
]
