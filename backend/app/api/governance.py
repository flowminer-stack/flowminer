"""Governance + EA capability + log-version API.

CRUD routers for the three small models in ``app.models.governance``.
All endpoints require an authenticated user; governance promotion
records an audit trail row for every state change.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_active_user
from app.database import get_db
from app.models import (
    Capability,
    GovernanceEntry,
    GovernanceStatus,
    GovernanceTransition,
    LogVersion,
    User,
)

router = APIRouter()


# ─── Governance entries ──────────────────────────────────────────────────


class GovernanceEntryCreate(BaseModel):
    name: str
    event_log_id: UUID | None = None
    version: str = "1.0"
    notes: str | None = None


class GovernanceEntryUpdate(BaseModel):
    name: str | None = None
    version: str | None = None
    notes: str | None = None
    owner_id: UUID | None = None


class GovernancePromote(BaseModel):
    to_status: GovernanceStatus
    comment: str | None = None


class GovernanceEntryResponse(BaseModel):
    id: UUID
    name: str
    owner_id: UUID | None
    event_log_id: UUID | None
    version: str
    status: GovernanceStatus
    notes: str | None
    created_by: UUID
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


@router.get("/entries", response_model=list[GovernanceEntryResponse])
async def list_entries(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_active_user),
):
    rows = (
        await db.execute(
            select(GovernanceEntry).order_by(GovernanceEntry.updated_at.desc())
        )
    ).scalars().all()
    return rows


@router.post("/entries", response_model=GovernanceEntryResponse)
async def create_entry(
    body: GovernanceEntryCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_active_user),
):
    entry = GovernanceEntry(
        name=body.name,
        event_log_id=body.event_log_id,
        version=body.version,
        notes=body.notes,
        owner_id=user.id,
        created_by=user.id,
    )
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    return entry


@router.put("/entries/{entry_id}", response_model=GovernanceEntryResponse)
async def update_entry(
    entry_id: UUID,
    body: GovernanceEntryUpdate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_active_user),
):
    entry = await db.get(GovernanceEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    for field in ("name", "version", "notes", "owner_id"):
        value = getattr(body, field)
        if value is not None:
            setattr(entry, field, value)
    await db.commit()
    await db.refresh(entry)
    return entry


@router.post("/entries/{entry_id}/promote", response_model=GovernanceEntryResponse)
async def promote_entry(
    entry_id: UUID,
    body: GovernancePromote,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_active_user),
):
    """Move an entry to a new status and record the transition.

    The caller can promote to any state (not just the next one) —
    useful for skipping review on a trivial fix or rolling back from
    published to draft. Every promotion is recorded in the immutable
    transition table for audit.
    """
    entry = await db.get(GovernanceEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    prev = entry.status
    entry.status = body.to_status
    db.add(
        GovernanceTransition(
            entry_id=entry.id,
            from_status=prev,
            to_status=body.to_status,
            actor_id=user.id,
            comment=body.comment,
        )
    )
    await db.commit()
    await db.refresh(entry)
    return entry


@router.get("/entries/{entry_id}/history")
async def entry_history(
    entry_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_active_user),
):
    rows = (
        await db.execute(
            select(GovernanceTransition)
            .where(GovernanceTransition.entry_id == entry_id)
            .order_by(GovernanceTransition.created_at.desc())
        )
    ).scalars().all()
    return [
        {
            "id": str(r.id),
            "from_status": r.from_status.value if r.from_status else None,
            "to_status": r.to_status.value,
            "actor_id": str(r.actor_id),
            "comment": r.comment,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.delete("/entries/{entry_id}")
async def delete_entry(
    entry_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_active_user),
):
    entry = await db.get(GovernanceEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    await db.delete(entry)
    await db.commit()
    return {"detail": "Deleted"}


# ─── EA capability tree ──────────────────────────────────────────────────


class CapabilityCreate(BaseModel):
    name: str
    description: str | None = None
    parent_id: UUID | None = None
    linked_event_log_ids: list[UUID] = []


class CapabilityUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    parent_id: UUID | None = None
    linked_event_log_ids: list[UUID] | None = None


class CapabilityResponse(BaseModel):
    id: UUID
    name: str
    description: str | None
    parent_id: UUID | None
    linked_event_log_ids: list[UUID] = []
    owner_id: UUID | None
    created_at: datetime

    class Config:
        from_attributes = True


def _cap_row_to_response(row: Capability) -> CapabilityResponse:
    """Normalize the JSON column to typed UUIDs for the API."""
    raw = row.linked_event_log_ids or []
    parsed: list[UUID] = []
    for item in raw:
        try:
            parsed.append(UUID(str(item)))
        except ValueError:
            continue
    return CapabilityResponse(
        id=row.id,
        name=row.name,
        description=row.description,
        parent_id=row.parent_id,
        linked_event_log_ids=parsed,
        owner_id=row.owner_id,
        created_at=row.created_at,
    )


@router.get("/capabilities", response_model=list[CapabilityResponse])
async def list_capabilities(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_active_user),
):
    rows = (
        await db.execute(select(Capability).order_by(Capability.created_at.asc()))
    ).scalars().all()
    return [_cap_row_to_response(r) for r in rows]


@router.post("/capabilities", response_model=CapabilityResponse)
async def create_capability(
    body: CapabilityCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_active_user),
):
    cap = Capability(
        name=body.name,
        description=body.description,
        parent_id=body.parent_id,
        linked_event_log_ids=[str(x) for x in body.linked_event_log_ids],
        owner_id=user.id,
    )
    db.add(cap)
    await db.commit()
    await db.refresh(cap)
    return _cap_row_to_response(cap)


@router.put("/capabilities/{cap_id}", response_model=CapabilityResponse)
async def update_capability(
    cap_id: UUID,
    body: CapabilityUpdate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_active_user),
):
    cap = await db.get(Capability, cap_id)
    if cap is None:
        raise HTTPException(status_code=404, detail="Capability not found")
    if body.name is not None:
        cap.name = body.name
    if body.description is not None:
        cap.description = body.description
    if body.parent_id is not None:
        cap.parent_id = body.parent_id
    if body.linked_event_log_ids is not None:
        cap.linked_event_log_ids = [str(x) for x in body.linked_event_log_ids]
    await db.commit()
    await db.refresh(cap)
    return _cap_row_to_response(cap)


@router.delete("/capabilities/{cap_id}")
async def delete_capability(
    cap_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_active_user),
):
    cap = await db.get(Capability, cap_id)
    if cap is None:
        raise HTTPException(status_code=404, detail="Capability not found")
    await db.delete(cap)
    await db.commit()
    return {"detail": "Deleted"}


# ─── Log versions ────────────────────────────────────────────────────────


class LogVersionCreate(BaseModel):
    event_log_id: UUID
    name: str
    description: str | None = None
    parent_id: UUID | None = None
    filter_payload: dict[str, Any] | None = None


class LogVersionResponse(BaseModel):
    id: UUID
    event_log_id: UUID
    parent_id: UUID | None
    name: str
    description: str | None
    filter_payload: dict[str, Any] | None
    created_by: UUID
    created_at: datetime

    class Config:
        from_attributes = True


@router.get("/log-versions", response_model=list[LogVersionResponse])
async def list_log_versions(
    event_log_id: UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_active_user),
):
    rows = (
        await db.execute(
            select(LogVersion)
            .where(LogVersion.event_log_id == event_log_id)
            .order_by(LogVersion.created_at.asc())
        )
    ).scalars().all()
    return rows


@router.post("/log-versions", response_model=LogVersionResponse)
async def create_log_version(
    body: LogVersionCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_active_user),
):
    version = LogVersion(
        event_log_id=body.event_log_id,
        parent_id=body.parent_id,
        name=body.name,
        description=body.description,
        filter_payload=body.filter_payload,
        created_by=user.id,
    )
    db.add(version)
    await db.commit()
    await db.refresh(version)
    return version


@router.delete("/log-versions/{version_id}")
async def delete_log_version(
    version_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_active_user),
):
    row = await db.get(LogVersion, version_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Version not found")
    await db.delete(row)
    await db.commit()
    return {"detail": "Deleted"}
