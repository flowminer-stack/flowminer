"""Phase 5: incremental cursor + sync-state persistence."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

from app.models import Connector, ConnectorStatus, ConnectorType
from app.services.connectors.incremental import (
    SyncState,
    compute_since,
    effective_since,
    next_sync_state,
)

UTC = timezone.utc


def test_effective_since_prefers_cursor_over_last_sync():
    state = {"cursor_value": "2026-03-01T12:00:00+00:00"}
    got = effective_since(state, last_sync=datetime(2026, 1, 1, tzinfo=UTC))
    assert got == datetime(2026, 3, 1, 12, 0, tzinfo=UTC)


def test_effective_since_falls_back_to_last_sync():
    got = effective_since(None, last_sync=datetime(2026, 1, 1, tzinfo=UTC))
    assert got == datetime(2026, 1, 1, tzinfo=UTC)


def test_effective_since_applies_overlap_window():
    state = {"cursor_value": "2026-03-01T12:00:00+00:00"}
    got = effective_since(state, None, overlap_minutes=30)
    assert got == datetime(2026, 3, 1, 11, 30, tzinfo=UTC)


def test_effective_since_none_for_first_ever_sync():
    assert effective_since(None, None) is None


def test_effective_since_makes_naive_last_sync_tz_aware():
    got = effective_since(None, datetime(2026, 1, 1, 0, 0, 0))  # naive
    assert got is not None and got.tzinfo is not None


def test_compute_since_none_when_connector_not_incremental():
    got = compute_since(
        supports_incremental=False,
        sync_state={"cursor_value": "2026-03-01T00:00:00+00:00"},
        last_sync=None,
        config={},
    )
    assert got is None


def test_compute_since_reads_overlap_from_config():
    got = compute_since(
        supports_incremental=True,
        sync_state={"cursor_value": "2026-03-01T12:00:00+00:00"},
        last_sync=None,
        config={"incremental_overlap_minutes": 60},
    )
    assert got == datetime(2026, 3, 1, 11, 0, tzinfo=UTC)


def test_compute_since_tolerates_bad_overlap_value():
    got = compute_since(
        supports_incremental=True,
        sync_state={"cursor_value": "2026-03-01T12:00:00+00:00"},
        last_sync=None,
        config={"incremental_overlap_minutes": "not-a-number"},
    )
    assert got == datetime(2026, 3, 1, 12, 0, tzinfo=UTC)  # overlap ignored


def test_next_sync_state_shape_and_iso():
    s = next_sync_state(datetime(2026, 5, 1, 9, 0, tzinfo=UTC))
    assert s["cursor_field"] == "synced_at"
    assert s["cursor_value"] == s["synced_at"]
    assert datetime.fromisoformat(s["cursor_value"]).year == 2026
    # round-trips through the pydantic model
    assert SyncState(**s).cursor_field == "synced_at"


@pytest.mark.asyncio
async def test_connector_sync_state_column_round_trips(db_session):
    c = Connector(
        id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        name="incremental-test",
        connector_type=ConnectorType.coupa,
        config={},
        column_mapping={},
        status=ConnectorStatus.inactive,
        created_by=uuid.uuid4(),
        sync_state=next_sync_state(datetime(2026, 1, 1, tzinfo=UTC)),
    )
    db_session.add(c)
    await db_session.commit()
    await db_session.refresh(c)
    assert c.sync_state["cursor_field"] == "synced_at"
    assert c.sync_state["cursor_value"].startswith("2026-01-01")
