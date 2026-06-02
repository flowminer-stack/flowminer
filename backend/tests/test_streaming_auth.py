"""Regression test for the streaming auth fix (audit SECURITY finding).

The live-KPI and ingest endpoints were unauthenticated — any caller could read
a tenant's KPIs or push events into any event-log id. They now require a valid
bearer token. If auth is dropped again, these fail.
"""

import uuid

import pytest

from tests.conftest import auth_header


@pytest.mark.asyncio
async def test_live_kpis_requires_auth(client):
    r = await client.get(f"/api/v1/streaming/live-kpis/{uuid.uuid4()}")
    assert r.status_code in (401, 403), r.text


@pytest.mark.asyncio
async def test_ingest_requires_auth(client):
    r = await client.post(
        f"/api/v1/streaming/ingest/{uuid.uuid4()}",
        json={"case_id": "c1", "activity": "A", "timestamp": "2026-01-01T00:00:00Z"},
    )
    assert r.status_code in (401, 403), r.text


@pytest.mark.asyncio
async def test_authenticated_user_cannot_read_unknown_log(client, make_user):
    """An authenticated user hitting a log they can't access must be rejected
    (404/403), never served anonymous data."""
    _user, token = await make_user()
    r = await client.get(
        f"/api/v1/streaming/live-kpis/{uuid.uuid4()}", headers=auth_header(token)
    )
    assert r.status_code in (403, 404), r.text
