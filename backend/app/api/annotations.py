"""
Annotation router: create, list, delete, reply, resolve/unresolve, and assign
annotations on event logs.
"""

from datetime import datetime, timezone
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


class AnnotationReply(BaseModel):
    content: str = Field(..., min_length=1, description="Reply text content")


class AnnotationAssign(BaseModel):
    assignee_id: UUID | None = Field(
        default=None,
        description="User ID to assign; null to clear assignment",
    )


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
    # Threading
    parent_id: UUID | None = None
    # Resolution
    resolved: bool = False
    resolved_by: UUID | None = None
    resolved_at: object = None
    # Assignment
    assignee_id: UUID | None = None
    # Nested replies (populated only when nest_replies=true)
    replies: list["AnnotationResponse"] = Field(default_factory=list)

    class Config:
        from_attributes = True


# Allow the self-referential type to resolve
AnnotationResponse.model_rebuild()


@router.get("", response_model=list[AnnotationResponse])
async def list_annotations(
    event_log_id: UUID = Query(..., description="Event log ID (required)"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    nest_replies: bool = Query(False, description="Nest replies under their parent annotation"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """List annotations for a specific event log.

    When nest_replies=true, top-level annotations include a populated ``replies``
    list and reply annotations are omitted from the root list.  When
    nest_replies=false (default) every annotation is returned flat regardless of
    parent_id.
    """
    await assert_event_log_access(event_log_id, db, current_user)

    if not nest_replies:
        query = (
            select(Annotation)
            .where(Annotation.event_log_id == event_log_id)
            .order_by(Annotation.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        result = await db.execute(query)
        return list(result.scalars().all())

    # When nesting, pagination must apply to TOP-LEVEL threads (not raw rows),
    # otherwise a reply whose parent falls outside the page is silently dropped.
    # Page the top-level annotations first, then fetch *all* of their replies
    # regardless of page so no reply is lost.
    top_query = (
        select(Annotation)
        .where(
            Annotation.event_log_id == event_log_id,
            Annotation.parent_id.is_(None),
        )
        .order_by(Annotation.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    top_result = await db.execute(top_query)
    top_annotations = list(top_result.scalars().all())

    by_id: dict[UUID, AnnotationResponse] = {}
    top_level: list[AnnotationResponse] = []
    for ann in top_annotations:
        resp = AnnotationResponse.model_validate(ann)
        by_id[resp.id] = resp
        top_level.append(resp)

    if top_level:
        replies_query = select(Annotation).where(
            Annotation.event_log_id == event_log_id,
            Annotation.parent_id.in_(list(by_id.keys())),
        )
        replies_result = await db.execute(replies_query)
        for reply in replies_result.scalars().all():
            reply_resp = AnnotationResponse.model_validate(reply)
            parent = by_id.get(reply_resp.parent_id)
            if parent is not None:
                parent.replies.append(reply_resp)

    # Sort replies chronologically (ascending within each thread)
    for item in top_level:
        item.replies.sort(key=lambda r: r.created_at or datetime.min)

    return top_level


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


@router.post(
    "/{annotation_id}/replies",
    response_model=AnnotationResponse,
    status_code=status.HTTP_201_CREATED,
)
async def reply_to_annotation(
    annotation_id: UUID,
    body: AnnotationReply,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Add a threaded reply to an existing annotation."""
    result = await db.execute(
        select(Annotation).where(Annotation.id == annotation_id)
    )
    parent = result.scalar_one_or_none()
    if parent is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Annotation not found"
        )
    await assert_event_log_access(parent.event_log_id, db, current_user)

    # The threading model is single-level: replies hang directly off a
    # top-level annotation. If a user replies to something that is itself a
    # reply, re-parent the new reply to the thread root so it isn't orphaned
    # (the nesting/sort logic in list_annotations only attaches direct
    # children of a top-level item).
    root_id = parent.parent_id if parent.parent_id is not None else annotation_id

    reply = Annotation(
        project_id=parent.project_id,
        event_log_id=parent.event_log_id,
        activity_name=parent.activity_name,
        edge_source=parent.edge_source,
        edge_target=parent.edge_target,
        content=body.content,
        created_by=current_user.id,
        parent_id=root_id,
    )
    db.add(reply)
    await db.commit()
    await db.refresh(reply)
    return reply


@router.post(
    "/{annotation_id}/resolve",
    response_model=AnnotationResponse,
)
async def resolve_annotation(
    annotation_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Mark an annotation as resolved."""
    result = await db.execute(
        select(Annotation).where(Annotation.id == annotation_id)
    )
    annotation = result.scalar_one_or_none()
    if annotation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Annotation not found"
        )
    await assert_event_log_access(annotation.event_log_id, db, current_user)

    annotation.resolved = True
    annotation.resolved_by = current_user.id
    annotation.resolved_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(annotation)
    return annotation


@router.post(
    "/{annotation_id}/unresolve",
    response_model=AnnotationResponse,
)
async def unresolve_annotation(
    annotation_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Clear the resolved state of an annotation."""
    result = await db.execute(
        select(Annotation).where(Annotation.id == annotation_id)
    )
    annotation = result.scalar_one_or_none()
    if annotation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Annotation not found"
        )
    await assert_event_log_access(annotation.event_log_id, db, current_user)

    annotation.resolved = False
    annotation.resolved_by = None
    annotation.resolved_at = None
    await db.commit()
    await db.refresh(annotation)
    return annotation


@router.patch(
    "/{annotation_id}/assign",
    response_model=AnnotationResponse,
)
async def assign_annotation(
    annotation_id: UUID,
    body: AnnotationAssign,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Assign an annotation to a user, or clear assignment by passing null."""
    result = await db.execute(
        select(Annotation).where(Annotation.id == annotation_id)
    )
    annotation = result.scalar_one_or_none()
    if annotation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Annotation not found"
        )
    await assert_event_log_access(annotation.event_log_id, db, current_user)

    if body.assignee_id is not None:
        # The assignee must be a real, active user AND have access to the
        # annotation's project (mirror _user_can_access_project semantics used
        # by the access dependencies). Otherwise we'd write a dangling /
        # cross-project FK straight from request input.
        from app.api.deps import _user_can_access_project
        from app.models import Project

        assignee_result = await db.execute(
            select(User).where(User.id == body.assignee_id)
        )
        assignee = assignee_result.scalar_one_or_none()
        if assignee is None or not assignee.is_active:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Assignee not found"
            )
        proj_result = await db.execute(
            select(Project).where(Project.id == annotation.project_id)
        )
        project = proj_result.scalar_one_or_none()
        if project is None or not _user_can_access_project(assignee, project):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Assignee is not a member of this project",
            )

    annotation.assignee_id = body.assignee_id
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
