"""Case-level tagging and attribution."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import CaseTag, User
from app.api.deps import get_current_active_user, assert_event_log_access

router = APIRouter()


class CaseTagCreate(BaseModel):
    event_log_id: UUID
    case_id: str
    tag: str
    color: str = "#06b6d4"
    note: str | None = None


class CaseTagResponse(BaseModel):
    id: str
    event_log_id: str
    case_id: str
    tag: str
    color: str
    note: str | None
    created_by: str
    created_at: str


def _to_response(t: CaseTag) -> dict:
    return {
        "id": str(t.id),
        "event_log_id": str(t.event_log_id),
        "case_id": t.case_id,
        "tag": t.tag,
        "color": t.color or "#06b6d4",
        "note": t.note,
        "created_by": str(t.created_by),
        "created_at": str(t.created_at) if t.created_at else "",
    }


@router.get("")
async def list_tags(
    event_log_id: UUID,
    case_id: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """List tags for an event log, optionally filtered by case_id."""
    await assert_event_log_access(event_log_id, db, current_user)
    q = select(CaseTag).where(CaseTag.event_log_id == event_log_id)
    if case_id:
        q = q.where(CaseTag.case_id == case_id)
    result = await db.execute(q.order_by(CaseTag.created_at.desc()).limit(limit).offset(offset))
    return [_to_response(t) for t in result.scalars().all()]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_tag(
    body: CaseTagCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    await assert_event_log_access(body.event_log_id, db, current_user)
    tag = CaseTag(
        event_log_id=body.event_log_id,
        case_id=body.case_id,
        tag=body.tag,
        color=body.color,
        note=body.note,
        created_by=current_user.id,
    )
    db.add(tag)
    await db.commit()
    await db.refresh(tag)
    return _to_response(tag)


@router.delete("/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tag(
    tag_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    result = await db.execute(select(CaseTag).where(CaseTag.id == tag_id))
    tag = result.scalar_one_or_none()
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    await assert_event_log_access(tag.event_log_id, db, current_user)
    await db.delete(tag)
    await db.commit()


@router.delete("")
async def delete_tags_bulk(
    event_log_id: UUID,
    case_id: str,
    tag: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Remove all instances of a specific tag from a case."""
    await assert_event_log_access(event_log_id, db, current_user)
    await db.execute(
        delete(CaseTag).where(
            CaseTag.event_log_id == event_log_id,
            CaseTag.case_id == case_id,
            CaseTag.tag == tag,
        )
    )
    await db.commit()
    return {"status": "deleted"}
