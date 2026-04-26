"""Data lineage — for any event log, answer "what depends on this?"

Useful for impact analysis (deleting this log breaks which dashboards?)
and for compliance questions (what derived data exists for this log?).
"""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_accessible_event_log
from app.database import get_db
from app.models import (
    ActionRule,
    Alert,
    Annotation,
    CustomKPI,
    Dashboard,
    ETLPipeline,
    EventLog,
    Initiative,
    ScheduledReport,
    VersionHistory,
)

router = APIRouter()


@router.get("/{event_log_id}")
async def event_log_lineage(
    event_log: EventLog = Depends(get_accessible_event_log),
    db: AsyncSession = Depends(get_db),
):
    """Return every downstream resource that references the given event log."""
    project_id = event_log.project_id
    el_id = event_log.id

    dash_rows = (await db.execute(
        select(Dashboard).where(Dashboard.project_id == project_id)
    )).scalars().all()

    alerts = (await db.execute(
        select(Alert).where(Alert.project_id == project_id)
    )).scalars().all()

    etl_pipelines = (await db.execute(
        select(ETLPipeline).where(ETLPipeline.project_id == project_id)
    )).scalars().all()

    initiatives = (await db.execute(
        select(Initiative).where(Initiative.event_log_id == el_id)
    )).scalars().all()

    action_rules = (await db.execute(
        select(ActionRule).where(ActionRule.event_log_id == el_id)
    )).scalars().all()

    kpis = (await db.execute(
        select(CustomKPI).where(CustomKPI.project_id == project_id)
    )).scalars().all()

    scheduled_reports = (await db.execute(
        select(ScheduledReport).where(ScheduledReport.project_id == project_id)
    )).scalars().all()

    annotations = (await db.execute(
        select(Annotation).where(Annotation.event_log_id == el_id)
    )).scalars().all()

    versions = (await db.execute(
        select(VersionHistory)
        .where(VersionHistory.entity_type == "event_log")
        .where(VersionHistory.entity_id == str(el_id))
    )).scalars().all()

    # Hidden derived logs (OCEL flattens, builder outputs) in the same project
    derived = (await db.execute(
        select(EventLog).where(
            EventLog.project_id == project_id,
            EventLog.hidden == True,  # noqa: E712
            EventLog.id != el_id,
        )
    )).scalars().all()

    return {
        "event_log": {
            "id": str(el_id),
            "name": event_log.name,
            "source_type": event_log.source_type.value if hasattr(event_log.source_type, "value") else str(event_log.source_type),
            "log_type": event_log.log_type if isinstance(event_log.log_type, str) else event_log.log_type.value,
            "created_at": str(event_log.created_at) if event_log.created_at else None,
            "total_events": event_log.total_events,
            "total_cases": event_log.total_cases,
        },
        "dashboards": [
            {"id": str(d.id), "name": d.name}
            for d in dash_rows
        ],
        "alerts": [
            {"id": str(a.id), "name": a.name, "is_active": a.is_active}
            for a in alerts
        ],
        "etl_pipelines": [
            {"id": str(e.id), "name": e.name}
            for e in etl_pipelines
        ],
        "initiatives": [
            {"id": str(i.id), "name": i.name, "status": i.status, "metric": i.metric}
            for i in initiatives
        ],
        "action_rules": [
            {"id": str(r.id), "name": r.name, "enabled": r.enabled, "trigger_count": r.trigger_count}
            for r in action_rules
        ],
        "custom_kpis": [
            {"id": str(k.id), "name": k.name, "metric": k.metric}
            for k in kpis
        ],
        "scheduled_reports": [
            {"id": str(s.id), "name": s.name, "frequency": s.frequency.value if hasattr(s.frequency, "value") else str(s.frequency)}
            for s in scheduled_reports
        ],
        "annotations_count": len(annotations),
        "derived_logs": [
            {"id": str(d.id), "name": d.name, "created_at": str(d.created_at) if d.created_at else None}
            for d in derived
        ],
        "version_history_count": len(versions),
    }
