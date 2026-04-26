"""System settings API — admin-only configuration that outlives
process restarts and survives environment-variable changes.

The main surface today is the LLM provider configuration so an
operator can paste an OpenRouter / Anthropic / OpenAI API key into
the Settings page without editing ``.env`` and restarting the
backend. The stored value is Fernet-encrypted at rest and is never
returned in plaintext — responses that reference the API key carry
only a boolean ``has_api_key`` flag so a curl user can't trivially
exfiltrate the key through ``GET``.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.api.deps import require_admin
from app.models import User
from app.services import llm, system_settings as settings_service

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Request / response schemas ───────────────────────────────────────


class LLMConfigResponse(BaseModel):
    """Current effective LLM config, exposing only booleans for the
    sensitive fields so a curl-to-JSON pipeline can't steal the key.

    ``source`` reports *where* each field's value is coming from —
    either ``"db"`` (set via the Settings UI), ``"env"`` (read from
    the backend's environment variables), or ``"unset"``.
    """

    provider: str
    provider_source: str
    model: str
    model_source: str
    has_api_key: bool
    api_key_source: str
    # Last 4 characters of the API key when set, so the operator
    # can tell at a glance whether they're looking at the right
    # key without actually leaking it.
    api_key_preview: str | None = None
    is_configured: bool


class LLMConfigUpdate(BaseModel):
    """Batch update for the LLM configuration.

    Every field is optional. Pass only what you want to change.
    Pass ``api_key=""`` (empty string) to CLEAR a stored key —
    omit the field entirely to leave it as-is.
    """

    provider: str | None = Field(
        None,
        description="One of anthropic | openai | openrouter | ollama | null",
        pattern=r"^(anthropic|openai|openrouter|ollama|null)$",
    )
    model: str | None = Field(
        None,
        description="Provider-specific model identifier.",
        max_length=256,
    )
    api_key: str | None = Field(
        None,
        description="Raw API key. Empty string clears the stored key.",
        max_length=2048,
    )


# ── Helpers ──────────────────────────────────────────────────────────


def _source_for(setting_key: str, env_key: str) -> str:
    """Return ``"db"`` / ``"env"`` / ``"unset"`` for a given setting."""
    import os as _os

    db_val = settings_service.get_setting(setting_key)
    if db_val:
        return "db"
    if _os.getenv(env_key, "").strip():
        return "env"
    return "unset"


def _current_llm_response() -> LLMConfigResponse:
    """Build the current-config response WITHOUT exposing the key."""
    provider = llm._provider()
    model = llm._model(provider)
    api_key = llm._api_key(provider)

    # Provider-specific env var for source attribution.
    env_key_map = {
        "anthropic": ("ANTHROPIC_MODEL", "ANTHROPIC_API_KEY"),
        "openai": ("OPENAI_MODEL", "OPENAI_API_KEY"),
        "openrouter": ("OPENROUTER_MODEL", "OPENROUTER_API_KEY"),
        "ollama": ("OLLAMA_MODEL", ""),
        "null": ("", ""),
    }
    model_env, api_env = env_key_map.get(provider, ("", ""))

    preview = None
    if api_key:
        # Show last 4 characters prefixed with a gap so the operator
        # can match it against their provider dashboard without
        # exposing enough to be useful to an attacker.
        preview = f"…{api_key[-4:]}" if len(api_key) >= 4 else "…"

    return LLMConfigResponse(
        provider=provider,
        provider_source=_source_for("llm.provider", "FLOWMINER_LLM_PROVIDER"),
        model=model,
        model_source=_source_for("llm.model", model_env) if model_env else "unset",
        has_api_key=bool(api_key),
        api_key_source=_source_for("llm.api_key", api_env) if api_env else "unset",
        api_key_preview=preview,
        is_configured=llm.is_llm_configured(),
    )


# ── Routes ───────────────────────────────────────────────────────────


@router.get("/llm", response_model=LLMConfigResponse)
async def get_llm_config(
    _admin: User = Depends(require_admin),
) -> LLMConfigResponse:
    """Return the current LLM configuration.

    Admin-only — the response only contains booleans and a last-4
    preview for the key, but it still reveals which provider is
    configured which we don't want to broadcast to non-admins.
    """
    return _current_llm_response()


@router.put("/llm", response_model=LLMConfigResponse)
async def update_llm_config(
    body: LLMConfigUpdate,
    admin: User = Depends(require_admin),
) -> LLMConfigResponse:
    """Batch-update the LLM configuration.

    Every field is independently optional. Passing an empty string
    for ``api_key`` CLEARS the stored key; omitting the field
    entirely leaves it alone.

    Changes take effect immediately — the in-process cache in
    ``system_settings`` is invalidated on write.
    """
    # Explicit-None detection (Pydantic coerces missing → None, so we
    # can't distinguish "clear" from "don't touch" without a sentinel).
    # The convention here: None = don't touch, empty string = clear.
    fields_set = body.model_fields_set  # which fields the client actually sent

    if "provider" in fields_set:
        settings_service.set_setting(
            "llm.provider",
            body.provider,  # None clears
            user_id=admin.id,
        )
    if "model" in fields_set:
        settings_service.set_setting(
            "llm.model",
            body.model,  # None clears
            user_id=admin.id,
        )
    if "api_key" in fields_set:
        # Empty string and None both clear; any other string sets.
        cleared = not body.api_key
        settings_service.set_setting(
            "llm.api_key",
            None if cleared else body.api_key,
            user_id=admin.id,
        )
        logger.info(
            "LLM api_key %s by user id=%s",
            "cleared" if cleared else "updated",
            admin.id,
        )

    # Fall through to return the now-updated effective config.
    return _current_llm_response()
