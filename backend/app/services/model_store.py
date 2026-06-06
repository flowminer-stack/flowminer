"""
On-disk model cache for the predictive process-monitoring service.

Predictive endpoints (remaining-time, outcome, next-activity) used to retrain
a fresh sklearn model on *every* request — fine for a one-off chart, wasteful
for the close-the-loop alarm layer that re-scores open cases repeatedly. This
module persists a trained model (plus its training metrics) under the existing
``/data/uploads`` volume so subsequent requests reuse it instead of refitting.

Layout::

    {UPLOAD_DIR}/_model_cache/{event_log_id}/{kind}.pkl

Each pickle is a small envelope::

    {
        "version": 1,
        "kind": "remaining_time",
        "content_hash": "<sha256 of the log fingerprint>",
        "trained_at": "2026-06-06T12:34:56.789Z",  # UTC ISO-8601
        "n_cases": 1234,
        "metrics": {...},          # MAE / AUC / accuracy etc.
        "payload": <the model object plus whatever the caller stashed>,
    }

The ``payload`` for the outcome / remaining-time models also carries an
out-of-fold (cross-fitted) prediction map — ``oof_breach_probability`` /
``oof_remaining_seconds``, keyed ``f"{case_id}::{prefix_length}"`` — so the
per-case scores shown to users are out-of-sample and match the reported metric.
These are plain dicts and survive the pickle round-trip unchanged.

Serialisation prefers ``joblib`` (better for numpy-heavy sklearn estimators)
and falls back to stdlib ``pickle`` if joblib isn't installed. A *content hash*
derived from the log's shape/fingerprint is stored alongside the model: when a
log changes (re-ingested, remapped, filtered differently) the hash no longer
matches and ``load_model`` treats the cache as stale, forcing a retrain.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any

import pandas as pd

from app.config import settings
from app.services.ingestion import ACTIVITY_COL, CASE_COL, TIMESTAMP_COL

logger = logging.getLogger(__name__)

# Bump when the envelope shape OR the feature engineering changes in a way that
# would make an old pickle unsafe to reuse.
#
# v3: payloads now carry out-of-fold (cross-fitted) prediction maps
# (``oof_breach_probability`` / ``oof_remaining_seconds``) so displayed per-case
# scores are out-of-sample and consistent with the reported AUC/MAE. These are
# plain ``{f"{case_id}::{prefix_length}": float}`` dicts that round-trip in the
# pickled payload like any other field; old (v2) caches are invalidated.
CACHE_VERSION = 3

# Prefer joblib (numpy-aware, smaller/faster for sklearn) but never hard-fail
# the import if it isn't present — fall back to stdlib pickle.
try:  # pragma: no cover - exercised implicitly by save/load
    import joblib as _serializer  # type: ignore

    _SERIALIZER_NAME = "joblib"
except Exception:  # noqa: BLE001
    import pickle as _serializer  # type: ignore

    _SERIALIZER_NAME = "pickle"


# ─── Paths ────────────────────────────────────────────────────────────────────


def _cache_root() -> str:
    """Root dir for all cached models (created lazily)."""
    path = os.path.join(settings.UPLOAD_DIR, "_model_cache")
    os.makedirs(path, exist_ok=True)
    return path


def _safe_kind(kind: str) -> str:
    """Sanitise ``kind`` so it can't escape the cache dir or collide oddly."""
    cleaned = re.sub(r"[^A-Za-z0-9_.-]", "_", str(kind))
    return cleaned or "model"


def _model_dir(event_log_id: Any) -> str:
    # ``event_log_id`` is a UUID in practice; str() it and strip anything weird
    # so a hostile/garbage id can't traverse out of the cache root.
    log_id = re.sub(r"[^A-Za-z0-9_.-]", "_", str(event_log_id)) or "_unknown"
    path = os.path.join(_cache_root(), log_id)
    os.makedirs(path, exist_ok=True)
    return path


def _model_path(event_log_id: Any, kind: str) -> str:
    return os.path.join(_model_dir(event_log_id), f"{_safe_kind(kind)}.pkl")


# ─── Content hashing ──────────────────────────────────────────────────────────


def content_hash(df: pd.DataFrame) -> str:
    """Cheap, deterministic fingerprint of an event-log DataFrame.

    We deliberately avoid hashing every cell (expensive on multi-million-row
    logs). Instead we fingerprint the things that, if they change, should
    invalidate a trained model: row count, distinct case count, the sorted set
    of activities, and the min/max timestamps. Two materially-different logs
    will (with overwhelming probability) produce different hashes; re-loading
    the same log produces the same hash, so the cache survives restarts.
    """
    try:
        parts: list[str] = [f"v{CACHE_VERSION}", f"rows={len(df)}"]

        if CASE_COL in df.columns:
            parts.append(f"cases={int(df[CASE_COL].nunique())}")
        if ACTIVITY_COL in df.columns:
            acts = sorted(str(a) for a in df[ACTIVITY_COL].dropna().unique())
            parts.append("acts=" + "|".join(acts))
        if TIMESTAMP_COL in df.columns and len(df):
            try:
                tmin = df[TIMESTAMP_COL].min()
                tmax = df[TIMESTAMP_COL].max()
                parts.append(f"tmin={tmin}")
                parts.append(f"tmax={tmax}")
            except Exception:  # noqa: BLE001
                pass

        fingerprint = "\n".join(parts)
        return hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
    except Exception as e:  # noqa: BLE001 - hashing must never break callers
        logger.warning("content_hash failed (%s); returning empty hash", e)
        return ""


# ─── Save / load / meta ───────────────────────────────────────────────────────


def save_model(
    event_log_id: Any,
    kind: str,
    obj: Any,
    *,
    content_hash: str | None = None,
    n_cases: int | None = None,
    metrics: dict | None = None,
) -> str | None:
    """Persist ``obj`` for ``(event_log_id, kind)`` and return the path.

    ``obj`` is the caller's payload — typically a dict bundling the fitted
    estimator with the feature metadata needed to score new prefixes
    (activity vocabulary, threshold, classes, ...). The envelope (version,
    hash, trained_at, n_cases, metrics) is added around it.

    Returns the on-disk path on success, or ``None`` if serialisation failed
    (the caller should degrade to in-request training, never crash).
    """
    envelope = {
        "version": CACHE_VERSION,
        "kind": _safe_kind(kind),
        "content_hash": content_hash or "",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "n_cases": int(n_cases) if n_cases is not None else None,
        "metrics": metrics or {},
        "payload": obj,
    }
    path = _model_path(event_log_id, kind)
    tmp_path = f"{path}.tmp"
    try:
        if _SERIALIZER_NAME == "joblib":
            _serializer.dump(envelope, tmp_path)
        else:
            with open(tmp_path, "wb") as fh:
                _serializer.dump(envelope, fh)
        # Atomic-ish replace so a half-written file can't be read as valid.
        os.replace(tmp_path, path)
        return path
    except Exception as e:  # noqa: BLE001 - persistence is best-effort
        logger.warning("save_model(%s, %s) failed: %s", event_log_id, kind, e)
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:  # noqa: BLE001
            pass
        return None


def _load_envelope(event_log_id: Any, kind: str) -> dict | None:
    path = _model_path(event_log_id, kind)
    if not os.path.exists(path):
        return None
    try:
        if _SERIALIZER_NAME == "joblib":
            envelope = _serializer.load(path)
        else:
            with open(path, "rb") as fh:
                envelope = _serializer.load(fh)
    except Exception as e:  # noqa: BLE001 - a corrupt/old pickle should not crash
        logger.warning("load_model(%s, %s) deserialise failed: %s", event_log_id, kind, e)
        return None

    if not isinstance(envelope, dict) or envelope.get("version") != CACHE_VERSION:
        # Different version = different feature contract; treat as a miss.
        return None
    return envelope


def load_model(
    event_log_id: Any,
    kind: str,
    *,
    content_hash: str | None = None,
) -> Any | None:
    """Return the cached payload for ``(event_log_id, kind)`` or ``None``.

    If ``content_hash`` is provided and does NOT match the hash stored when the
    model was trained, the cache entry is considered stale (the log changed) and
    ``None`` is returned so the caller retrains.
    """
    envelope = _load_envelope(event_log_id, kind)
    if envelope is None:
        return None
    if content_hash is not None and envelope.get("content_hash") != content_hash:
        return None
    return envelope.get("payload")


def model_meta(event_log_id: Any, kind: str) -> dict | None:
    """Return ``{trained_at, n_cases, metrics, content_hash, kind}`` or ``None``.

    Does NOT deserialise the (potentially large) model payload's estimator into
    a usable state for scoring — it just reads the same envelope and returns the
    metadata fields. Used by the model-health endpoint.
    """
    envelope = _load_envelope(event_log_id, kind)
    if envelope is None:
        return None
    return {
        "kind": envelope.get("kind", _safe_kind(kind)),
        "trained_at": envelope.get("trained_at"),
        "n_cases": envelope.get("n_cases"),
        "metrics": envelope.get("metrics") or {},
        "content_hash": envelope.get("content_hash") or "",
        "serializer": _SERIALIZER_NAME,
    }


def clear_models(event_log_id: Any) -> int:
    """Delete all cached models for an event log. Returns the count removed.

    Intended for callers that invalidate analysis when a log's mapping changes
    (mirrors ``_clear_cache_for_event_log``).
    """
    directory = os.path.join(_cache_root(), re.sub(r"[^A-Za-z0-9_.-]", "_", str(event_log_id)) or "_unknown")
    if not os.path.isdir(directory):
        return 0
    removed = 0
    try:
        for name in os.listdir(directory):
            if name.endswith(".pkl"):
                try:
                    os.remove(os.path.join(directory, name))
                    removed += 1
                except Exception:  # noqa: BLE001
                    pass
    except Exception as e:  # noqa: BLE001
        logger.warning("clear_models(%s) failed: %s", event_log_id, e)
    return removed
