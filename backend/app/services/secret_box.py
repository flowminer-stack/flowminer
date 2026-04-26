"""Symmetric encryption for sensitive JSON fields (connector credentials,
SMTP passwords, etc).

We use Fernet (AES-128-CBC + HMAC-SHA256, derived from a 32-byte key).
Key derivation order:

  1. ``FLOWMINER_ENCRYPTION_KEY`` env var — either a raw urlsafe-base64
     Fernet key or an arbitrary passphrase (SHA-256-hashed up to 32 B).
  2. Fall back to ``settings.SECRET_KEY`` — the JWT signing key. This
     is always present (``validate_production_secrets`` rejects empty
     / too-short values), so connector credentials are encrypted by
     default on every install. Operators who want a separate key can
     still set ``FLOWMINER_ENCRYPTION_KEY`` explicitly.

Rotating one key does not affect the other, but rotating
``SECRET_KEY`` without an explicit encryption key will make existing
encrypted connector configs unreadable — set ``FLOWMINER_ENCRYPTION_KEY``
before rotating ``SECRET_KEY`` in that case.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)

_PREFIX = "fne::"  # marker so we know a value was encrypted by us


def _hash_to_fernet_key(passphrase: str) -> bytes:
    digest = hashlib.sha256(passphrase.encode()).digest()
    return base64.urlsafe_b64encode(digest)


def _derive_key() -> bytes | None:
    raw = os.getenv("FLOWMINER_ENCRYPTION_KEY", "")
    if raw:
        try:
            Fernet(raw.encode())  # already a valid Fernet key?
            return raw.encode()
        except Exception:
            return _hash_to_fernet_key(raw)

    # Fall back to the app's SECRET_KEY so encryption is on by default.
    try:
        from app.config import settings  # local import to avoid cycles
        secret = getattr(settings, "SECRET_KEY", "") or ""
    except Exception:
        secret = ""
    if not secret:
        return None
    return _hash_to_fernet_key(f"flowminer-connector-box::{secret}")


_KEY = _derive_key()
_FERNET = Fernet(_KEY) if _KEY else None

if _FERNET is None:
    logger.warning(
        "No encryption key available — connector credentials will be "
        "stored in plaintext. Set FLOWMINER_ENCRYPTION_KEY or SECRET_KEY."
    )


def encrypt_value(value: Any) -> Any:
    """Encrypt a JSON-serializable value. Non-strings are first serialized
    to JSON, the whole thing is Fernet-encrypted, and a sentinel prefix is
    attached so ``decrypt_value`` can tell the difference between an
    encrypted and a plaintext value."""
    if _FERNET is None or value is None:
        return value
    if isinstance(value, str) and value.startswith(_PREFIX):
        return value  # already encrypted
    try:
        serialized = json.dumps(value).encode()
    except (TypeError, ValueError):
        return value
    token = _FERNET.encrypt(serialized).decode()
    return f"{_PREFIX}{token}"


def decrypt_value(value: Any) -> Any:
    if _FERNET is None or value is None:
        return value
    if not isinstance(value, str) or not value.startswith(_PREFIX):
        return value
    try:
        plaintext = _FERNET.decrypt(value[len(_PREFIX):].encode()).decode()
        return json.loads(plaintext)
    except (InvalidToken, json.JSONDecodeError, ValueError):
        logger.warning("Failed to decrypt secret value — returning as-is")
        return value


# ─── Connector-specific helpers ──────────────────────────────────────────

# Keys we should encrypt when storing a connector.config. Everything else
# (host, port, database, query, table name, etc.) stays in cleartext.
_SENSITIVE_CONFIG_KEYS = {
    "password",
    "api_key",
    "token",
    "access_token",
    "refresh_token",
    "private_key",
    "client_secret",
    "secret",
    "sas_token",
    "service_account_json",
}


def encrypt_connector_config(config: dict | None) -> dict | None:
    """Return a new config dict with sensitive keys encrypted in place."""
    if not config:
        return config
    out = {}
    for k, v in config.items():
        if k.lower() in _SENSITIVE_CONFIG_KEYS and v is not None:
            out[k] = encrypt_value(v)
        else:
            out[k] = v
    return out


def decrypt_connector_config(config: dict | None) -> dict | None:
    if not config:
        return config
    out = {}
    for k, v in config.items():
        if k.lower() in _SENSITIVE_CONFIG_KEYS:
            out[k] = decrypt_value(v)
        else:
            out[k] = v
    return out
