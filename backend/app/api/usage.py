"""Usage metering API — aggregate consumption per team/user.

Admin-only dashboards + CSV export. Writes come from the LLM endpoints,
mining endpoints, connector tasks, and the API key path (via the
``record_usage`` helper in the service).
"""

from datetime import datetime, timedelta, timezone
from io import StringIO
from uuid import UUID

import csv

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_active_user, require_admin
from app.database import get_db
from app.models import UsageEvent, User

router = APIRouter()


@router.get("")
async def usage_summary(
    team_id: UUID | None = Query(None),
    since_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """Aggregate usage counts per kind over the last N days, optionally
    scoped to a single team."""
    since = datetime.now(timezone.utc) - timedelta(days=since_days)
    stmt = (
        select(UsageEvent.kind, func.sum(UsageEvent.quantity))
        .where(UsageEvent.created_at >= since)
        .group_by(UsageEvent.kind)
    )
    if team_id:
        stmt = stmt.where(UsageEvent.team_id == team_id)
    rows = (await db.execute(stmt)).all()
    return {
        "since": since.isoformat(),
        "team_id": str(team_id) if team_id else None,
        "by_kind": [{"kind": k, "total": float(v or 0)} for k, v in rows],
    }


@router.get("/export")
async def export_usage_csv(
    since_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    since = datetime.now(timezone.utc) - timedelta(days=since_days)
    stmt = (
        select(UsageEvent)
        .where(UsageEvent.created_at >= since)
        .order_by(UsageEvent.created_at.desc())
        .limit(50000)
    )
    rows = (await db.execute(stmt)).scalars().all()

    buf = StringIO()
    writer = csv.writer(buf)
    writer.writerow(["created_at", "team_id", "user_id", "kind", "quantity", "resource_type", "resource_id"])
    for r in rows:
        writer.writerow([
            r.created_at.isoformat() if r.created_at else "",
            str(r.team_id) if r.team_id else "",
            str(r.user_id) if r.user_id else "",
            r.kind,
            r.quantity,
            r.resource_type or "",
            r.resource_id or "",
        ])
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=flowminer-usage-{since_days}d.csv"},
    )
