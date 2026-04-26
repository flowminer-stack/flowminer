"""Process Governance: ChangeRequest CRUD + approve/reject flow.

The review queue: drafts are created by analysts, submitted for review,
approvers accept or reject, and approved requests can auto-apply their
after_payload to the target entity. This closes the governance gap
vs. SAP Signavio Process Governance.
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import assert_project_access, get_current_active_user, get_owned_project
from app.database import get_db
from app.models import ChangeRequest, Project, User

router = APIRouter()


class ChangeRequestCreate(BaseModel):
    project_id: UUID
    entity_type: str
    entity_id: str
    title: str
    description: str | None = None
    before_payload: dict | None = None
    after_payload: dict | None = None
    reviewers: list[str] = []
    apply_on_approve: bool = True


class ChangeRequestUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    after_payload: dict | None = None
    status: str | None = None
    rejection_reason: str | None = None


def _to_dict(cr: ChangeRequest) -> dict:
    return {
        "id": str(cr.id),
        "project_id": str(cr.project_id),
        "entity_type": cr.entity_type,
        "entity_id": cr.entity_id,
        "title": cr.title,
        "description": cr.description,
        "before_payload": cr.before_payload,
        "after_payload": cr.after_payload,
        "status": cr.status,
        "reviewers": cr.reviewers or [],
        "apply_on_approve": cr.apply_on_approve,
        "created_by": str(cr.created_by) if cr.created_by else None,
        "approver_id": str(cr.approver_id) if cr.approver_id else None,
        "rejection_reason": cr.rejection_reason,
        "created_at": str(cr.created_at) if cr.created_at else None,
        "updated_at": str(cr.updated_at) if cr.updated_at else None,
    }


@router.get("")
async def list_change_requests(
    project: Project = Depends(get_owned_project),
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(ChangeRequest).where(ChangeRequest.project_id == project.id)
    if status_filter:
        stmt = stmt.where(ChangeRequest.status == status_filter)
    stmt = stmt.order_by(ChangeRequest.created_at.desc()).limit(limit).offset(offset)
    result = await db.execute(stmt)
    return [_to_dict(cr) for cr in result.scalars().all()]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_change_request(
    body: ChangeRequestCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    await assert_project_access(body.project_id, db, current_user)
    cr = ChangeRequest(
        project_id=body.project_id,
        entity_type=body.entity_type,
        entity_id=body.entity_id,
        title=body.title,
        description=body.description,
        before_payload=body.before_payload,
        after_payload=body.after_payload,
        reviewers=body.reviewers,
        apply_on_approve=body.apply_on_approve,
        status="draft",
        created_by=current_user.id,
    )
    db.add(cr)
    await db.commit()
    await db.refresh(cr)
    return _to_dict(cr)


@router.post("/{cr_id}/submit")
async def submit_change_request(
    cr_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    cr = await db.get(ChangeRequest, cr_id)
    if not cr:
        raise HTTPException(status_code=404, detail="Change request not found")
    await assert_project_access(cr.project_id, db, current_user)
    if cr.status != "draft":
        raise HTTPException(status_code=400, detail=f"Cannot submit from status '{cr.status}'")
    cr.status = "submitted"
    await db.commit()
    await db.refresh(cr)
    return _to_dict(cr)


@router.post("/{cr_id}/approve")
async def approve_change_request(
    cr_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    cr = await db.get(ChangeRequest, cr_id)
    if not cr:
        raise HTTPException(status_code=404, detail="Change request not found")
    await assert_project_access(cr.project_id, db, current_user)
    if cr.status not in ("submitted", "in_review"):
        raise HTTPException(status_code=400, detail=f"Cannot approve from status '{cr.status}'")
    # Reviewer check: only listed reviewers (or admin) can approve
    from app.models import UserRole
    if cr.reviewers and str(current_user.id) not in (cr.reviewers or []) and current_user.role != UserRole.admin:
        raise HTTPException(status_code=403, detail="Not in the reviewers list for this change request")
    cr.status = "approved"
    cr.approver_id = current_user.id
    await db.commit()
    await db.refresh(cr)
    return _to_dict(cr)


@router.post("/{cr_id}/reject")
async def reject_change_request(
    cr_id: UUID,
    reason: str = Query("", description="Reason for rejection"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    cr = await db.get(ChangeRequest, cr_id)
    if not cr:
        raise HTTPException(status_code=404, detail="Change request not found")
    await assert_project_access(cr.project_id, db, current_user)
    cr.status = "rejected"
    cr.rejection_reason = reason
    cr.approver_id = current_user.id
    await db.commit()
    await db.refresh(cr)
    return _to_dict(cr)
