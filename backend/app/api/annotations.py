"""
Annotation router: create, list, and delete annotations on event logs.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Annotation, User
from app.api.deps import get_current_active_user, assert_event_log_access

router = APIRouter()


# -- Inline schemas for annotations --

class AnnotationCreate(BaseModel):
    project_id: UUID = Field(..., description="Associated project ID")
    event_log_id: UUID = Field(..., description="Associated event log ID")
    activity_name: str | None = Field(default=None, description="Activity name this annotation refers to")
    edge_source: str | None = Field(default=None, description="Edge source activity (for edge annotations)")
    edge_target: str | None = Field(default=None, description="Edge target activity (for edge annotations)")
    content: str = Field(..., min_length=1, description="Annotation text content")


class AnnotationResponse(BaseModel):
    id: UUID
    project_id: UUID
    event_log_id: UUID
    activity_name: str | None = None
    edge_source: str | None = None
    edge_target: str | None = None
    content: str
    created_by: UUID
    created_at: object = None

    class Config:
        from_attributes = True


@router.get("", response_model=list[AnnotationResponse])
async def list_annotations(
    event_log_id: UUID = Query(..., description="Event log ID (required)"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """List annotations for a specific event log."""
    await assert_event_log_access(event_log_id, db, current_user)
    query = (
        select(Annotation)
        .where(Annotation.event_log_id == event_log_id)
        .order_by(Annotation.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    result = await db.execute(query)
    annotations = result.scalars().all()
    return annotations


@router.post("", response_model=AnnotationResponse, status_code=status.HTTP_201_CREATED)
async def create_annotation(
    body: AnnotationCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Create a new annotation on an event log."""
    # Verify event log access (also verifies existence)
    await assert_event_log_access(body.event_log_id, db, current_user)

    annotation = Annotation(
        project_id=body.project_id,
        event_log_id=body.event_log_id,
        activity_name=body.activity_name,
        edge_source=body.edge_source,
        edge_target=body.edge_target,
        content=body.content,
        created_by=current_user.id,
    )
    db.add(annotation)
    await db.commit()
    await db.refresh(annotation)
    return annotation


@router.delete("/{annotation_id}", status_code=status.HTTP_200_OK)
async def delete_annotation(
    annotation_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Delete an annotation."""
    result = await db.execute(
        select(Annotation).where(Annotation.id == annotation_id)
    )
    annotation = result.scalar_one_or_none()
    if annotation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Annotation not found"
        )
    await assert_event_log_access(annotation.event_log_id, db, current_user)

    await db.delete(annotation)
    await db.commit()

    return {"detail": "Annotation deleted", "annotation_id": str(annotation_id)}
