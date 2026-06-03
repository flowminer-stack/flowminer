"""Regression test for the dashboard-collab WebSocket cross-tenant IDOR.

The ``/streaming/dashboards/{dashboard_id}`` collaboration socket authenticated
the JWT but performed NO project-level authorization — any authenticated user
on a shared instance who knew (or guessed) a dashboard UUID could join another
tenant's edit stream, see presence, and inject messages. On the Basic (shared)
managed tier that is a cross-tenant data leak.

The fix gates the socket on ``_ws_can_access_dashboard`` (same project check as
the REST dashboard routes) BEFORE ``accept()``. These tests pin both the helper
decision and the endpoint's reject-before-accept behavior. If the authz check is
dropped again, they fail.

The WS handlers open their own ``async_session`` (not the request-scoped
``get_db``), so we seed an isolated StaticPool SQLite DB and point the module's
``async_session`` at it.
"""

import uuid

import pytest
import pytest_asyncio
from fastapi import WebSocketDisconnect, status
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.api import streaming
from app.api.deps import create_access_token
from app.database import Base
from app.models import Dashboard, Project, User, UserRole


async def _seed():
    """Build an isolated in-memory DB with an owner, an unrelated attacker, a
    project the owner created, and a dashboard under it."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,  # one shared connection so every session sees the data
    )
    async with engine.begin() as conn:
        import app.models  # noqa: F401  (populate Base.metadata)
        await conn.run_sync(Base.metadata.create_all)

    Session = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    owner = User(
        id=uuid.uuid4(), email=f"owner-{uuid.uuid4().hex[:6]}@a.com",
        password_hash="x", full_name="Owner", role=UserRole.analyst, is_active=True,
    )
    # Different user, no shared team — fails every branch of _user_can_access_project.
    attacker = User(
        id=uuid.uuid4(), email=f"attacker-{uuid.uuid4().hex[:6]}@b.com",
        password_hash="x", full_name="Attacker", role=UserRole.analyst, is_active=True,
    )
    project = Project(id=uuid.uuid4(), name="Owner project", created_by=owner.id)
    dashboard = Dashboard(
        id=uuid.uuid4(), project_id=project.id, name="Owner dashboard", created_by=owner.id,
    )
    async with Session() as s:
        s.add_all([owner, attacker, project, dashboard])
        await s.commit()
    return engine, Session, owner, attacker, dashboard


@pytest_asyncio.fixture
async def seeded(monkeypatch):
    engine, Session, owner, attacker, dashboard = await _seed()
    # The helper/endpoint call async_session() directly — repoint it at our DB.
    monkeypatch.setattr(streaming, "async_session", Session)
    yield owner, attacker, dashboard
    await engine.dispose()


# ─── Helper-level authz decision ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_owner_allowed(seeded):
    owner, _attacker, dashboard = seeded
    assert await streaming._ws_can_access_dashboard(owner, str(dashboard.id)) is True


@pytest.mark.asyncio
async def test_cross_tenant_denied(seeded):
    """The core IDOR: an unrelated user must NOT access another tenant's dashboard."""
    _owner, attacker, dashboard = seeded
    assert await streaming._ws_can_access_dashboard(attacker, str(dashboard.id)) is False


@pytest.mark.asyncio
async def test_unknown_dashboard_denied(seeded):
    owner, *_ = seeded
    assert await streaming._ws_can_access_dashboard(owner, str(uuid.uuid4())) is False


@pytest.mark.asyncio
async def test_malformed_dashboard_id_denied(seeded):
    owner, *_ = seeded
    assert await streaming._ws_can_access_dashboard(owner, "not-a-uuid") is False


# ─── Endpoint reject-before-accept behavior ───────────────────────────────────


class _FakeWS:
    """Minimal WebSocket stand-in: records whether accept()/close() were called."""

    def __init__(self):
        self.accepted = False
        self.closed_code = None
        self.sent = []

    async def accept(self):
        self.accepted = True

    async def close(self, code=None):
        self.closed_code = code

    async def send_json(self, data):
        self.sent.append(data)

    async def receive_json(self):
        # Immediately end the (authorized) session's receive loop.
        raise WebSocketDisconnect()


@pytest.mark.asyncio
async def test_endpoint_rejects_cross_tenant_before_accept(seeded):
    _owner, attacker, dashboard = seeded
    ws = _FakeWS()
    token = create_access_token({"sub": str(attacker.id)})
    await streaming.dashboard_collab_ws(ws, str(dashboard.id), token=token)
    assert ws.accepted is False, "cross-tenant socket must be rejected before accept()"
    assert ws.closed_code == status.WS_1008_POLICY_VIOLATION


@pytest.mark.asyncio
async def test_endpoint_rejects_missing_token(seeded):
    _owner, _attacker, dashboard = seeded
    ws = _FakeWS()
    await streaming.dashboard_collab_ws(ws, str(dashboard.id), token=None)
    assert ws.accepted is False
    assert ws.closed_code == status.WS_1008_POLICY_VIOLATION


@pytest.mark.asyncio
async def test_endpoint_accepts_authorized_owner(seeded):
    owner, _attacker, dashboard = seeded
    ws = _FakeWS()
    token = create_access_token({"sub": str(owner.id)})
    await streaming.dashboard_collab_ws(ws, str(dashboard.id), token=token)
    assert ws.accepted is True
    assert ws.closed_code is None
