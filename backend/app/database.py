from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session, declarative_base, sessionmaker

from app.config import settings

# When DATABASE_URL is unset (its insecure empty default), fall back to a
# parseable placeholder so the engine objects can be constructed at import
# time. SQLAlchemy connects lazily, so no connection is attempted here; the
# loud failure on a missing URL still happens in
# ``settings.validate_production_secrets`` (called from app.config at import)
# and on the first real query. This keeps ``import app.main`` working in
# tooling/CI that never sets a DB URL while preserving the security intent.
_PLACEHOLDER_ASYNC_URL = "postgresql+asyncpg://localhost/flowminer_unset"

_async_url = settings.DATABASE_URL or _PLACEHOLDER_ASYNC_URL

# SQLite (used by the test suite) is backed by StaticPool, which rejects the
# QueuePool tuning args below. Only apply the pool sizing for real (Postgres)
# deployments so ``import app.database`` works under a sqlite test URL too.
_is_sqlite = _async_url.startswith("sqlite")
_async_engine_kwargs: dict = {"echo": False}
if not _is_sqlite:
    # Pool sized for ~100 concurrent requests before connections start
    # queueing. Raise further if workers report pool exhaustion.
    _async_engine_kwargs.update(
        pool_size=50,
        max_overflow=20,
        pool_pre_ping=True,
        pool_recycle=3600,
    )

engine = create_async_engine(_async_url, **_async_engine_kwargs)

async_session = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

Base = declarative_base()

# ---------------------------------------------------------------------------
# Synchronous engine + session factory for Celery workers
# ---------------------------------------------------------------------------
_sync_url = settings.SYNC_DATABASE_URL
if not _sync_url or "asyncpg" in _sync_url or "aiopg" in _sync_url:
    _sync_url = (
        _async_url
        .replace("postgresql+asyncpg://", "postgresql://")
        .replace("postgresql+aiopg://", "postgresql://")
    )

sync_engine = create_engine(_sync_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=sync_engine, expire_on_commit=False)


async def get_db() -> AsyncSession:
    """Async generator that yields a database session and ensures cleanup."""
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()


async def init_db() -> None:
    """Bring the schema up to date.

    Fresh database path: ``Base.metadata.create_all`` + ``alembic stamp head``
    — cheaper than walking the migration chain and sidesteps the issue that
    our baseline revision uses ``create_all`` itself, which collides with
    later migrations that add columns/tables already materialised by the
    ORM metadata.

    Existing database path: ``alembic upgrade head`` to apply any new
    revisions.
    """
    import asyncio
    import logging
    from pathlib import Path

    import sqlalchemy as sa
    from alembic import command
    from alembic.config import Config

    logger = logging.getLogger(__name__)

    def _ini_path() -> Path:
        return Path(__file__).resolve().parents[1] / "alembic.ini"

    def _alembic_cfg() -> Config:
        cfg = Config(str(_ini_path()))
        cfg.set_main_option("sqlalchemy.url", _sync_url)
        return cfg

    def _run() -> None:
        # Import models so Base.metadata is fully populated before create_all.
        import app.models  # noqa: F401

        inspector = sa.inspect(sync_engine)
        is_fresh = not inspector.has_table("users")

        if is_fresh:
            logger.info("init_db: fresh database — create_all + stamp head")
            Base.metadata.create_all(bind=sync_engine)
            command.stamp(_alembic_cfg(), "head")
            return

        logger.info("init_db: existing database — alembic upgrade head")
        command.upgrade(_alembic_cfg(), "head")

    try:
        await asyncio.to_thread(_run)
    except Exception as e:
        logger.error("init_db failed at startup: %s", e, exc_info=True)
        raise
