"""Version history: track and restore entity changes."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import VersionHistory, User, Dashboard
from app.api.deps import get_current_active_user, assert_project_access

router = APIRouter()


def _to_response(v: VersionHistory) -> dict:
    return {
        "id": str(v.id),
        "entity_type": v.entity_type,
        "entity_id": str(v.entity_id),
        "version_number": v.version_number,
        "snapshot": v.snapshot,
        "change_summary": v.change_summary,
        "created_by": str(v.created_by),
        "created_at": str(v.created_at) if v.created_at else "",
    }


async def _assert_entity_access(entity_type: str, entity_id: UUID, db, user) -> None:
    """Verify the caller can access the entity that a version record belongs to."""
    if entity_type == "dashboard":
        dash_result = await db.execute(select(Dashboard).where(Dashboard.id == entity_id))
        dashboard = dash_result.scalar_one_or_none()
        if dashboard is None:
            from fastapi import HTTPException as _HTTPException
            raise _HTTPException(status_code=404, detail="Entity not found")
        await assert_project_access(dashboard.project_id, db, user)
    # Other entity types (event_log, etc.) can be added here as needed


@router.get("/{entity_type}/{entity_id}")
async def list_versions(
    entity_type: str,
    entity_id: UUID,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """List all versions for an entity."""
    await _assert_entity_access(entity_type, entity_id, db, current_user)
    result = await db.execute(
        select(VersionHistory)
        .where(VersionHistory.entity_type == entity_type, VersionHistory.entity_id == entity_id)
        .order_by(VersionHistory.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return [_to_response(v) for v in result.scalars().all()]


@router.get("/detail/{version_id}")
async def get_version(
    version_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    result = await db.execute(select(VersionHistory).where(VersionHistory.id == version_id))
    v = result.scalar_one_or_none()
    if not v:
        raise HTTPException(status_code=404, detail="Version not found")
    await _assert_entity_access(v.entity_type, v.entity_id, db, current_user)
    return _to_response(v)


@router.post("/snapshot")
async def create_snapshot(
    entity_type: str,
    entity_id: UUID,
    snapshot: dict,
    change_summary: str | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Create a new version snapshot for an entity."""
    await _assert_entity_access(entity_type, entity_id, db, current_user)
    # Count existing versions to determine version number
    count_result = await db.execute(
        select(sa_func.count()).where(
            VersionHistory.entity_type == entity_type,
            VersionHistory.entity_id == entity_id,
        )
    )
    count = count_result.scalar() or 0

    version = VersionHistory(
        entity_type=entity_type,
        entity_id=entity_id,
        version_number=f"v{count + 1}",
        snapshot=snapshot,
        change_summary=change_summary,
        created_by=current_user.id,
    )
    db.add(version)
    await db.commit()
    await db.refresh(version)
    return _to_response(version)


@router.post("/restore/{version_id}")
async def restore_version(
    version_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Restore an entity to a previous version snapshot. Currently supports dashboards."""
    result = await db.execute(select(VersionHistory).where(VersionHistory.id == version_id))
    version = result.scalar_one_or_none()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    await _assert_entity_access(version.entity_type, version.entity_id, db, current_user)

    if version.entity_type == "dashboard":
        dash_result = await db.execute(select(Dashboard).where(Dashboard.id == version.entity_id))
        dashboard = dash_result.scalar_one_or_none()
        if not dashboard:
            raise HTTPException(status_code=404, detail="Dashboard not found")

        snap = version.snapshot
        if "name" in snap:
            dashboard.name = snap["name"]
        if "description" in snap:
            dashboard.description = snap["description"]
        if "layout" in snap:
            dashboard.layout = snap["layout"]
        if "widgets" in snap:
            dashboard.widgets = snap["widgets"]

        await db.commit()
        return {"status": "restored", "entity_type": "dashboard", "entity_id": str(version.entity_id), "version": version.version_number}

    raise HTTPException(status_code=400, detail=f"Restore not supported for entity type: {version.entity_type}")
