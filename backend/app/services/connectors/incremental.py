"""Incremental-sync state + cursor computation.

A connector that declares ``meta.supports_incremental`` is handed a ``since``
datetime computed from its persisted sync state, optionally rewound by an
overlap window (``incremental_overlap_minutes`` in the connector config) so that
rows committed late under a long-running upstream transaction — the SAP LUW race
Celonis warns about — are re-fetched rather than missed. After a successful sync
the orchestrator records a fresh state via :func:`next_sync_state`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from pydantic import BaseModel


class SyncState(BaseModel):
    """Persisted in ``Connector.sync_state`` (a JSON column)."""

    cursor_field: str = "synced_at"
    cursor_value: Optional[str] = None  # ISO timestamp / opaque high-watermark
    synced_at: Optional[str] = None  # ISO timestamp of the last successful sync


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except (ValueError, TypeError):
        return None


def effective_since(
    sync_state: Optional[dict],
    last_sync: Optional[datetime],
    overlap_minutes: int = 0,
) -> Optional[datetime]:
    """Compute the ``since`` to hand a connector.

    Prefers the persisted cursor, falls back to ``last_sync``, and rewinds by
    ``overlap_minutes``. Returns None for a first-ever sync (full fetch).
    """
    base = _parse_iso((sync_state or {}).get("cursor_value")) or last_sync
    if base is None:
        return None
    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    if overlap_minutes > 0:
        base = base - timedelta(minutes=overlap_minutes)
    return base


def compute_since(
    *,
    supports_incremental: bool,
    sync_state: Optional[dict],
    last_sync: Optional[datetime],
    config: Optional[dict],
) -> Optional[datetime]:
    """The ``since`` for this run, or None when the connector isn't incremental."""
    if not supports_incremental:
        return None
    overlap = 0
    try:
        overlap = int((config or {}).get("incremental_overlap_minutes", 0) or 0)
    except (TypeError, ValueError):
        overlap = 0
    return effective_since(sync_state, last_sync, overlap)


def next_sync_state(now: datetime) -> dict:
    """State to persist after a successful sync (high-watermark = sync time)."""
    iso = now.astimezone(timezone.utc).isoformat()
    return SyncState(cursor_field="synced_at", cursor_value=iso, synced_at=iso).model_dump()
