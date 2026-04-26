"""Audit log API — admin-only read access."""

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_admin
from app.database import get_db
from app.models import AuditLog, User

router = APIRouter()


def _to_response(entry: AuditLog) -> dict:
    return {
        "id": str(entry.id),
        "user_id": str(entry.user_id) if entry.user_id else None,
        "user_email": entry.user_email,
        "ip_address": entry.ip_address,
        "user_agent": entry.user_agent,
        "method": entry.method,
        "path": entry.path,
        "status_code": entry.status_code,
        "resource_type": entry.resource_type,
        "resource_id": entry.resource_id,
        "action": entry.action,
        "payload_snapshot": entry.payload_snapshot,
        "created_at": str(entry.created_at) if entry.created_at else None,
    }


@router.get("")
async def list_audit_logs(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user_id: UUID | None = None,
    resource_type: str | None = None,
    resource_id: str | None = None,
    action: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """List audit log entries with filters. Admin-only."""
    conditions = []
    if user_id is not None:
        conditions.append(AuditLog.user_id == user_id)
    if resource_type is not None:
        conditions.append(AuditLog.resource_type == resource_type)
    if resource_id is not None:
        conditions.append(AuditLog.resource_id == resource_id)
    if action is not None:
        conditions.append(AuditLog.action == action)
    if since is not None:
        conditions.append(AuditLog.created_at >= since)
    if until is not None:
        conditions.append(AuditLog.created_at <= until)

    stmt = select(AuditLog)
    if conditions:
        stmt = stmt.where(and_(*conditions))
    stmt = stmt.order_by(AuditLog.created_at.desc()).limit(limit).offset(offset)

    result = await db.execute(stmt)
    rows = result.scalars().all()
    return [_to_response(r) for r in rows]


@router.get("/summary")
async def audit_summary(
    since: datetime | None = None,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """Lightweight aggregate counts for the admin dashboard."""
    from sqlalchemy import func

    where = []
    if since is not None:
        where.append(AuditLog.created_at >= since)

    # Total
    total_stmt = select(func.count()).select_from(AuditLog)
    if where:
        total_stmt = total_stmt.where(and_(*where))
    total = (await db.execute(total_stmt)).scalar_one()

    # By action
    by_action_stmt = select(AuditLog.action, func.count()).group_by(AuditLog.action)
    if where:
        by_action_stmt = by_action_stmt.where(and_(*where))
    by_action = (await db.execute(by_action_stmt)).all()

    # By resource type
    by_resource_stmt = select(AuditLog.resource_type, func.count()).group_by(AuditLog.resource_type)
    if where:
        by_resource_stmt = by_resource_stmt.where(and_(*where))
    by_resource = (await db.execute(by_resource_stmt)).all()

    # Top users
    top_users_stmt = (
        select(AuditLog.user_email, func.count())
        .where(AuditLog.user_email.is_not(None))
        .group_by(AuditLog.user_email)
        .order_by(func.count().desc())
        .limit(10)
    )
    if where:
        top_users_stmt = top_users_stmt.where(and_(*where))
    top_users = (await db.execute(top_users_stmt)).all()

    return {
        "total": total,
        "by_action": [{"action": a or "unknown", "count": c} for a, c in by_action],
        "by_resource": [{"resource_type": r or "unknown", "count": c} for r, c in by_resource],
        "top_users": [{"user_email": u, "count": c} for u, c in top_users],
    }
