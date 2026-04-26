"""Scheduled reports: CRUD + manual trigger."""

import uuid
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import ScheduledReport, ReportFrequency, ReportFormat, User
from app.api.deps import get_current_active_user, assert_project_access

router = APIRouter()


class ScheduledReportCreate(BaseModel):
    project_id: UUID
    event_log_id: UUID
    name: str
    frequency: str = "weekly"
    report_format: str = "html"
    email_recipients: list[str] = []
    include_sections: list[str] = ["summary", "bottlenecks", "variants", "insights"]


class ScheduledReportUpdate(BaseModel):
    name: str | None = None
    frequency: str | None = None
    email_recipients: list[str] | None = None
    include_sections: list[str] | None = None
    is_active: bool | None = None


class ScheduledReportResponse(BaseModel):
    id: str
    project_id: str
    event_log_id: str
    name: str
    frequency: str
    report_format: str
    email_recipients: list[str]
    include_sections: list[str]
    is_active: bool
    last_sent_at: str | None
    send_count: int
    created_at: str

    class Config:
        from_attributes = True


def _to_response(r: ScheduledReport) -> dict:
    return {
        "id": str(r.id),
        "project_id": str(r.project_id),
        "event_log_id": str(r.event_log_id),
        "name": r.name,
        "frequency": r.frequency.value if hasattr(r.frequency, 'value') else str(r.frequency),
        "report_format": r.report_format.value if hasattr(r.report_format, 'value') else str(r.report_format),
        "email_recipients": r.email_recipients or [],
        "include_sections": r.include_sections or [],
        "is_active": r.is_active,
        "last_sent_at": str(r.last_sent_at) if r.last_sent_at else None,
        "send_count": r.send_count or 0,
        "created_at": str(r.created_at) if r.created_at else "",
    }


@router.get("")
async def list_reports(
    project_id: UUID | None = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    if project_id is not None:
        await assert_project_access(project_id, db, current_user)
    q = select(ScheduledReport)
    if project_id:
        q = q.where(ScheduledReport.project_id == project_id)
    else:
        from app.models import Project, UserRole
        if current_user.role != UserRole.admin:
            accessible = select(Project.id).where(
                (Project.created_by == current_user.id)
                | (
                    (Project.team_id.is_not(None))
                    & (Project.team_id == current_user.team_id)
                )
            )
            q = q.where(ScheduledReport.project_id.in_(accessible))
    result = await db.execute(q.order_by(ScheduledReport.created_at.desc()).limit(limit).offset(offset))
    return [_to_response(r) for r in result.scalars().all()]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_report(
    body: ScheduledReportCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    await assert_project_access(body.project_id, db, current_user)
    report = ScheduledReport(
        project_id=body.project_id,
        event_log_id=body.event_log_id,
        name=body.name,
        frequency=ReportFrequency(body.frequency),
        report_format=ReportFormat(body.report_format),
        email_recipients=body.email_recipients,
        include_sections=body.include_sections,
        created_by=current_user.id,
    )
    db.add(report)
    await db.commit()
    await db.refresh(report)
    return _to_response(report)


@router.get("/{report_id}")
async def get_report(
    report_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    result = await db.execute(select(ScheduledReport).where(ScheduledReport.id == report_id))
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    await assert_project_access(report.project_id, db, current_user)
    return _to_response(report)


@router.put("/{report_id}")
async def update_report(
    report_id: UUID,
    body: ScheduledReportUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    result = await db.execute(select(ScheduledReport).where(ScheduledReport.id == report_id))
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    await assert_project_access(report.project_id, db, current_user)

    if body.name is not None:
        report.name = body.name
    if body.frequency is not None:
        report.frequency = ReportFrequency(body.frequency)
    if body.email_recipients is not None:
        report.email_recipients = body.email_recipients
    if body.include_sections is not None:
        report.include_sections = body.include_sections
    if body.is_active is not None:
        report.is_active = body.is_active

    await db.commit()
    await db.refresh(report)
    return _to_response(report)


@router.delete("/{report_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_report(
    report_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    result = await db.execute(select(ScheduledReport).where(ScheduledReport.id == report_id))
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    await assert_project_access(report.project_id, db, current_user)
    await db.delete(report)
    await db.commit()


@router.post("/{report_id}/send")
async def trigger_send(
    report_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Manually trigger a scheduled report to be sent now."""
    result = await db.execute(select(ScheduledReport).where(ScheduledReport.id == report_id))
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    await assert_project_access(report.project_id, db, current_user)

    from app.workers.tasks import send_scheduled_report
    send_scheduled_report.delay(str(report.id))
    return {"status": "queued", "report_id": str(report.id)}
