"""
Demo mode seeder.

Populates the database with a locked-down demo user, a handful of sample
projects, and pre-ingested event logs so a visitor to ``demo.flowminer.io``
can immediately click through every analytics view without uploading
anything. Idempotent — safe to call on every boot.

The seeder bypasses the HTTP upload path and writes straight to the
models + UPLOAD_DIR so we don't need a running Celery worker at boot
time. The write-guard middleware later makes sure anything the demo
user tries to POST is rejected.
"""

from __future__ import annotations

import logging
import os
import shutil
import uuid as uuid_mod
from dataclasses import dataclass
from pathlib import Path

from passlib.context import CryptContext
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import (
    EventLog,
    EventLogStatus,
    LogType,
    Project,
    SourceType,
    User,
    UserRole,
)
from app.services.ingestion import (
    ACTIVITY_COL,
    CASE_COL,
    IngestionService,
    TIMESTAMP_COL,
)

logger = logging.getLogger(__name__)

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Where the source example logs live on disk, relative to the repo root
# which inside the backend container is mounted at /app. The Dockerfile
# copies docs/examples into /app/docs/examples so the container has
# access without a live bind mount.
_EXAMPLES_DIR = Path("/app/docs/examples")


@dataclass(frozen=True)
class DemoLogSpec:
    """One preloaded event log inside a demo project. The file at
    ``source_filename`` is looked up under ``_EXAMPLES_DIR`` and
    copied into the upload directory at seed time."""

    source_filename: str
    display_name: str
    log_type: LogType
    # Optional column mapping hint for standard CSV — the frontend
    # auto-detects but pre-seeding speeds first render.
    case_id_column: str | None = None
    activity_column: str | None = None
    timestamp_column: str | None = None


@dataclass(frozen=True)
class DemoProjectSpec:
    """A preloaded demo project. One project can own multiple logs,
    which is how we ship paired event logs (e.g. HR Onboarding 1 + 2)
    so visitors can run comparison views without any setup."""

    name: str
    description: str
    logs: tuple[DemoLogSpec, ...]


# Preloaded projects. Ordered smallest → largest so the fastest-loading
# log is what the visitor sees first in the sidebar.
DEMO_PROJECTS: tuple[DemoProjectSpec, ...] = (
    DemoProjectSpec(
        name="Demo · Running example",
        description=(
            "A six-case, clean pm4py example log. Great starting point "
            "for clicking through discovery, variants, and conformance."
        ),
        logs=(
            DemoLogSpec(
                source_filename="running-example.csv",
                display_name="running-example.csv",
                log_type=LogType.standard,
                # pm4py standard headers (see docs/examples/running-example.csv)
                case_id_column="case:concept:name",
                activity_column="concept:name",
                timestamp_column="time:timestamp",
            ),
        ),
    ),
    DemoProjectSpec(
        name="Demo · Sepsis Cases",
        description=(
            "Real-life hospital log tracking 1,050 sepsis patient pathways. "
            "846 unique variants, loops (Return ER), parallel lab tests "
            "(CRP, Leucocytes, LacticAcid), and five discharge outcomes. "
            "Great for discovery, variant analysis, and conformance."
        ),
        logs=(
            DemoLogSpec(
                source_filename="sepsis.csv",
                display_name="sepsis.csv",
                log_type=LogType.standard,
                case_id_column="case_id",
                activity_column="activity",
                timestamp_column="timestamp",
            ),
        ),
    ),
    DemoProjectSpec(
        name="Demo · Container logistics (OCEL)",
        description=(
            "An object-centric log covering forklifts, trucks, containers, "
            "and transport documents. Flatten it to any object type to see "
            "the bottleneck analysis run on multi-object processes, or open "
            "it in OCPM directly."
        ),
        logs=(
            DemoLogSpec(
                source_filename="container_logistics.json",
                display_name="container_logistics.json",
                log_type=LogType.ocel,
            ),
        ),
    ),
)


# ─── helpers ─────────────────────────────────────────────────────────────


async def ensure_demo_user(db: AsyncSession) -> User:
    """Look up or create the demo user. Idempotent — returns the existing
    user if it already exists; creates a fresh one otherwise. The user is
    created with the ``viewer`` role and a random password hash that
    nobody ever uses (login happens via ``POST /api/v1/auth/demo``)."""
    result = await db.execute(select(User).where(User.email == settings.DEMO_USER_EMAIL))
    user = result.scalar_one_or_none()
    if user is not None:
        return user

    # The password hash covers an unguessable random string so even if
    # someone discovers the email they can't use the /login endpoint.
    random_password = uuid_mod.uuid4().hex + uuid_mod.uuid4().hex
    user = User(
        email=settings.DEMO_USER_EMAIL,
        password_hash=_pwd_context.hash(random_password),
        full_name=settings.DEMO_USER_NAME,
        role=UserRole.viewer,
        is_active=True,
        email_verified=True,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    logger.info("demo seeder: created demo user id=%s", user.id)
    return user


def _copy_example_to_upload_dir(source: Path, project_id: uuid_mod.UUID) -> str | None:
    """Copy an example log into the upload directory under a fresh
    UUID-prefixed filename, matching the real upload path. Returns the
    on-disk path, or None if the source doesn't exist."""
    if not source.exists():
        logger.warning("demo seeder: example file not found: %s", source)
        return None

    project_dir = os.path.join(settings.UPLOAD_DIR, str(project_id))
    os.makedirs(project_dir, exist_ok=True)
    unique_filename = f"{uuid_mod.uuid4().hex}_{source.name}"
    dest = os.path.join(project_dir, unique_filename)
    shutil.copy2(source, dest)
    return dest


def _ingest_standard_csv_stats(file_path: str, spec: DemoLogSpec) -> dict:
    """Load the CSV and compute total_cases/events/activities inline so
    the log is ``ready`` the moment it hits the DB — no Celery needed."""
    ingestion = IngestionService()
    df = ingestion._load_raw_dataframe(file_path)

    # Fall back to a best-guess column mapping if the spec didn't supply
    # one. The running-example log uses ``case_id`` / ``activity`` /
    # ``timestamp`` so the defaults cover the only standard CSV we ship.
    case_col = spec.case_id_column or "case_id"
    act_col = spec.activity_column or "activity"
    ts_col = spec.timestamp_column or "timestamp"

    # If the expected columns don't exist, we still create the record so
    # the user sees the file in the sidebar — but flag it as "error" so
    # conformance queries don't explode.
    missing = [c for c in (case_col, act_col, ts_col) if c not in df.columns]
    if missing:
        return {
            "status": EventLogStatus.error,
            "error_message": f"missing columns {missing}",
            "total_cases": 0,
            "total_events": len(df),
            "total_activities": 0,
            "activities_list": [],
            "case_id_column": case_col,
            "activity_column": act_col,
            "timestamp_column": ts_col,
        }

    activities = sorted(df[act_col].dropna().astype(str).unique().tolist())
    return {
        "status": EventLogStatus.ready,
        "error_message": None,
        "total_cases": int(df[case_col].nunique()),
        "total_events": int(len(df)),
        "total_activities": int(len(activities)),
        "activities_list": activities,
        "case_id_column": case_col,
        "activity_column": act_col,
        "timestamp_column": ts_col,
    }


def _ingest_ocel_stats(file_path: str) -> dict:
    """Parse an OCEL file with pm4py and compute headline counts so the
    record can land as ``ready``."""
    try:
        import pm4py
        from app.services.ocel_store import _read_ocel, _ocel_store
    except ImportError as e:
        logger.error("demo seeder: OCEL parsing unavailable — %s", e)
        return {
            "status": EventLogStatus.error,
            "error_message": f"OCEL parser unavailable: {e}",
            "object_types": [],
            "total_cases": 0,
            "total_events": 0,
            "total_activities": 0,
        }

    try:
        ocel_obj = _read_ocel(file_path)
    except Exception as e:
        logger.exception("demo seeder: failed to parse OCEL %s", file_path)
        return {
            "status": EventLogStatus.error,
            "error_message": str(e)[:500],
            "object_types": [],
            "total_cases": 0,
            "total_events": 0,
            "total_activities": 0,
        }

    obj_types = list(pm4py.ocel_get_object_types(ocel_obj))
    try:
        evt_table = ocel_obj.get_extended_table()
        evt_count = len(evt_table)
        act_count = int(evt_table["ocel:activity"].nunique()) if evt_count else 0
    except Exception:
        evt_count = len(getattr(ocel_obj, "events", []))
        act_count = 0
    try:
        obj_count = len(pm4py.ocel_objects_summary(ocel_obj))
    except Exception:
        obj_count = 0

    # Cache the parsed OCEL so the /ocel/* endpoints work immediately.
    # The key is the event_log.id but we don't know it yet — the caller
    # has to register under the correct id after the DB insert.
    return {
        "status": EventLogStatus.ready,
        "error_message": None,
        "object_types": obj_types,
        "total_cases": obj_count,
        "total_events": evt_count,
        "total_activities": act_count,
        "_ocel_obj": ocel_obj,
    }


# ─── public entry points ─────────────────────────────────────────────────


async def seed_demo_data(db: AsyncSession) -> None:
    """Idempotently seed the demo user + projects + logs. Skips any
    project whose name already exists for the demo user — so re-running
    the seeder never duplicates anything. Called on every boot when
    ``settings.DEMO_MODE`` is True."""
    user = await ensure_demo_user(db)

    # Pull in existing demo projects once so we can short-circuit for
    # each spec without an extra round-trip per log.
    existing_projects_q = await db.execute(
        select(Project).where(Project.created_by == user.id)
    )
    existing_by_name = {p.name: p for p in existing_projects_q.scalars().all()}

    # Lazy import so the call chain stays cheap when demo mode is off.
    try:
        from app.services.ocel_store import _ocel_store
    except ImportError:
        _ocel_store = {}  # type: ignore

    for project_spec in DEMO_PROJECTS:
        if project_spec.name in existing_by_name:
            logger.info(
                "demo seeder: project '%s' already exists, skipping",
                project_spec.name,
            )
            continue

        # Verify every log file is present before creating the project —
        # avoids ending up with an empty project shell if one file is
        # missing from the image.
        missing = [
            log.source_filename
            for log in project_spec.logs
            if not (_EXAMPLES_DIR / log.source_filename).exists()
        ]
        if missing:
            logger.warning(
                "demo seeder: %s not found under %s, skipping project '%s'",
                ", ".join(missing),
                _EXAMPLES_DIR,
                project_spec.name,
            )
            continue

        project = Project(
            name=project_spec.name,
            description=project_spec.description,
            created_by=user.id,
        )
        db.add(project)
        await db.flush()  # we need project.id before the copy

        seeded_logs = 0
        for log_spec in project_spec.logs:
            source_path = _EXAMPLES_DIR / log_spec.source_filename
            file_path = _copy_example_to_upload_dir(source_path, project.id)
            if file_path is None:
                # Shouldn't happen — we checked .exists() above — but stay
                # defensive so a missing file skips the log, not the project.
                continue

            event_log = EventLog(
                project_id=project.id,
                name=log_spec.display_name,
                file_path=file_path,
                source_type=SourceType.upload,
                log_type=log_spec.log_type.value,
                status=EventLogStatus.processing,
            )
            db.add(event_log)
            await db.flush()

            if log_spec.log_type is LogType.standard:
                stats = _ingest_standard_csv_stats(file_path, log_spec)
                event_log.status = stats["status"]
                event_log.error_message = stats["error_message"]
                event_log.total_cases = stats["total_cases"]
                event_log.total_events = stats["total_events"]
                event_log.total_activities = stats["total_activities"]
                event_log.activities_list = stats["activities_list"]
                event_log.case_id_column = stats["case_id_column"]
                event_log.activity_column = stats["activity_column"]
                event_log.timestamp_column = stats["timestamp_column"]
            else:
                stats = _ingest_ocel_stats(file_path)
                event_log.status = stats["status"]
                event_log.error_message = stats["error_message"]
                event_log.total_cases = stats["total_cases"]
                event_log.total_events = stats["total_events"]
                event_log.total_activities = stats["total_activities"]
                event_log.object_types = stats.get("object_types", [])
                if "_ocel_obj" in stats:
                    _ocel_store[str(event_log.id)] = stats["_ocel_obj"]

            await db.flush()
            logger.info(
                "demo seeder: loaded %s (%d events, %d cases, status=%s)",
                log_spec.display_name,
                event_log.total_events,
                event_log.total_cases,
                event_log.status,
            )
            seeded_logs += 1

        if seeded_logs == 0:
            # Every log failed to materialise — roll back the project so
            # the sidebar doesn't show an empty row.
            await db.delete(project)

        await db.commit()


async def purge_demo_data(db: AsyncSession) -> None:
    """Delete every project (and its event logs) owned by the demo
    user. Leaves the demo user row itself intact so the next
    ``seed_demo_data`` can re-populate without recreating the account.
    Called by the hourly reset task.

    Uses a two-step delete — first event logs, then projects — rather
    than relying on the ORM's ``cascade="all, delete-orphan"``. The
    bulk ``delete(Project)`` statement bypasses ORM-level cascades
    because it's raw DML, so we clean the child table explicitly
    instead of switching every ForeignKey to ``ondelete="CASCADE"``
    (which would require an Alembic migration).
    """
    user_q = await db.execute(select(User).where(User.email == settings.DEMO_USER_EMAIL))
    user = user_q.scalar_one_or_none()
    if user is None:
        return

    # Grab the list first so we can clean up upload dirs on disk too —
    # the cascade delete only handles the DB rows.
    projects_q = await db.execute(select(Project).where(Project.created_by == user.id))
    projects = projects_q.scalars().all()
    project_ids = [p.id for p in projects]
    project_dirs = [
        os.path.join(settings.UPLOAD_DIR, str(p.id)) for p in projects
    ]

    if project_ids:
        await db.execute(
            delete(EventLog).where(EventLog.project_id.in_(project_ids))
        )
    await db.execute(delete(Project).where(Project.created_by == user.id))
    await db.commit()

    for d in project_dirs:
        try:
            shutil.rmtree(d, ignore_errors=True)
        except Exception:
            pass

    # Best-effort: clear any cached OCEL objects the previous cycle put
    # into the in-memory store. Failing silently is fine — the store is
    # rebuilt by the next seed pass.
    try:
        from app.services.ocel_store import _ocel_store
        _ocel_store.clear()
    except Exception:
        pass

    logger.info("demo seeder: purged %d demo projects", len(projects))


async def reset_demo_data(db: AsyncSession) -> None:
    """Purge + seed. Call from the Celery beat hourly job."""
    await purge_demo_data(db)
    await seed_demo_data(db)
