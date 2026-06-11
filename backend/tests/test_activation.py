"""Tests for the §9 managed-cloud additions: bootstrap-admin-from-env,
POST /auth/activate (single-use, expiring), and GET /system/version."""

import hashlib
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import settings
from app.models import User, UserRole

RAW = "activation-raw-token-abc123"
RAW_HASH = hashlib.sha256(RAW.encode()).hexdigest()
STRONG = "purple-tractor-mango-9471"


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


async def _pending_user(test_engine, *, email, raw, expires_in_hours=168, role=UserRole.admin):
    # Each caller passes a UNIQUE raw token — the OSS test engine is shared and
    # not wiped between tests, so reusing a hash would make /activate's
    # by-hash lookup match multiple leaked rows.
    Session = async_sessionmaker(test_engine, expire_on_commit=False)
    async with Session() as s:
        u = User(
            id=uuid.uuid4(),
            email=email,
            password_hash="!pending-activation!",
            full_name="Pending",
            role=role,
            is_active=False,
            email_verified=False,
            activation_token_hash=_hash(raw),
            activation_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=expires_in_hours),
        )
        s.add(u)
        await s.commit()
        return u.id


# ── bootstrap-admin-from-env ──────────────────────────────────────────

async def test_bootstrap_creates_pending_admin(db_session, monkeypatch):
    from app.services.bootstrap_admin import bootstrap_admin_from_env

    monkeypatch.setattr(settings, "BOOTSTRAP_ADMIN_EMAIL", "owner@flowminer.io")
    monkeypatch.setattr(settings, "BOOTSTRAP_TOKEN_HASH", RAW_HASH)
    await bootstrap_admin_from_env(db_session)

    row = (await db_session.execute(select(User).where(User.email == "owner@flowminer.io"))).scalar_one()
    assert row.role == UserRole.admin
    assert row.is_active is False and row.email_verified is False
    assert row.activation_token_hash == RAW_HASH

    # Idempotent: an existing admin means a second call is a no-op.
    await bootstrap_admin_from_env(db_session)
    count = len((await db_session.execute(select(User).where(User.email == "owner@flowminer.io"))).scalars().all())
    assert count == 1


async def test_bootstrap_noop_without_env(db_session, monkeypatch):
    from sqlalchemy import func

    from app.services.bootstrap_admin import bootstrap_admin_from_env

    monkeypatch.setattr(settings, "BOOTSTRAP_ADMIN_EMAIL", "")
    monkeypatch.setattr(settings, "BOOTSTRAP_TOKEN_HASH", "")
    before = (await db_session.execute(select(func.count()).select_from(User))).scalar()
    await bootstrap_admin_from_env(db_session)
    after = (await db_session.execute(select(func.count()).select_from(User))).scalar()
    assert before == after


# ── POST /auth/activate ───────────────────────────────────────────────

async def test_activate_sets_password_and_returns_jwt(client, test_engine):
    raw = "raw-sets-token"
    await _pending_user(test_engine, email="a@flowminer.io", raw=raw)
    r = await client.post("/api/v1/auth/activate", json={"token": raw, "password": STRONG})
    assert r.status_code == 200, r.text
    assert r.json()["access_token"]

    # Single-use: the token is burned.
    r2 = await client.post("/api/v1/auth/activate", json={"token": raw, "password": STRONG})
    assert r2.status_code == 400

    # The user can now log in with the new password.
    login = await client.post(
        "/api/v1/auth/login",
        data={"username": "a@flowminer.io", "password": STRONG},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert login.status_code == 200


async def test_activate_rejects_unknown_token(client):
    r = await client.post("/api/v1/auth/activate", json={"token": "nope", "password": STRONG})
    assert r.status_code == 400


async def test_activate_rejects_expired_token(client, test_engine):
    raw = "raw-exp-token"
    await _pending_user(test_engine, email="exp@flowminer.io", raw=raw, expires_in_hours=-1)
    r = await client.post("/api/v1/auth/activate", json={"token": raw, "password": STRONG})
    assert r.status_code == 400


async def test_activate_rejects_weak_password(client, test_engine):
    raw = "raw-weak-token"
    await _pending_user(test_engine, email="weak@flowminer.io", raw=raw)
    r = await client.post("/api/v1/auth/activate", json={"token": raw, "password": "password1"})
    assert r.status_code >= 400 and r.status_code < 500


# ── GET /system/version ───────────────────────────────────────────────

async def test_system_version_public(client):
    r = await client.get("/api/v1/system/version")
    assert r.status_code == 200
    body = r.json()
    assert "version" in body and "image_tag" in body
