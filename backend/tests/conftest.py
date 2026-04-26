"""Pytest fixtures: isolated SQLite-backed FlowMiner app for authorization tests.

We deliberately run against an in-process SQLite database (not the real
PostgreSQL) so tests are fast, hermetic, and don't need a running container.
This is fine for the logic we care about in Tier 1 — row-level auth, ETL
sandbox, audit log — because none of it depends on PostgreSQL-specific
features.
"""

from __future__ import annotations

import asyncio
import os
import uuid

# Must be set before importing anything that reads env vars via pydantic.
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("SYNC_DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("SECRET_KEY", "test-secret-key-at-least-sixteen-chars")
os.environ.setdefault("ENV", "development")

import pytest
import pytest_asyncio  # noqa: F401
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.deps import create_access_token
from app.database import Base, get_db
from app.main import app
from app.models import User, UserRole


# ─── DB setup ─────────────────────────────────────────────────────────────────
# We replace the app's DB dependency with a fresh SQLite engine per test run.
_test_engine = None
_TestSession = None


@pytest_asyncio.fixture(scope="session")
async def test_engine():
    """Session-scoped SQLite engine with schema created from ORM metadata."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        # Import all models so Base.metadata is populated before create_all.
        import app.models  # noqa: F401
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(test_engine) -> AsyncSession:
    """One fresh AsyncSession per test. We rollback on teardown."""
    Session = async_sessionmaker(test_engine, expire_on_commit=False, class_=AsyncSession)
    async with Session() as session:
        yield session
        await session.rollback()


@pytest_asyncio.fixture
async def client(test_engine) -> AsyncClient:
    """httpx AsyncClient wired to the FastAPI app with the test engine."""
    Session = async_sessionmaker(test_engine, expire_on_commit=False, class_=AsyncSession)

    async def _get_test_db():
        async with Session() as session:
            yield session

    app.dependency_overrides[get_db] = _get_test_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.pop(get_db, None)


# ─── User factories ─────────────────────────────────────────────────────────


def _token_for(user: User) -> str:
    return create_access_token({"sub": str(user.id)})


@pytest_asyncio.fixture
async def make_user(test_engine):
    """Factory that creates a user + returns (user, bearer_token) tuple."""
    Session = async_sessionmaker(test_engine, expire_on_commit=False, class_=AsyncSession)

    async def _make(email: str | None = None, role: UserRole = UserRole.analyst, team_id=None):
        async with Session() as session:
            user = User(
                id=uuid.uuid4(),
                email=email or f"user-{uuid.uuid4().hex[:8]}@example.com",
                password_hash="$2b$12$xxxx",  # unused, we mint tokens directly
                full_name="Test User",
                role=role,
                team_id=team_id,
                is_active=True,
            )
            session.add(user)
            await session.commit()
            await session.refresh(user)
            return user, _token_for(user)

    return _make


def auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}
