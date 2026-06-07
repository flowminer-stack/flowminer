"""
Executive Overview endpoint.

Aggregates cross-project KPIs for the current user into a single payload
used by the /overview frontend page. The goal is a one-glance view of
cases, alerts, initiatives, throughput density, and value impact without the
user needing to open individual projects.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_active_user
from app.database import get_db
from app.models.alert import Alert
from app.models.event_log import EventLog, EventLogStatus
from app.models.initiative import Initiative
from app.models.project import Project
from app.models.user import User, UserRole


router = APIRouter()


def _visible_project_filter(user: User):
    """Row-level filter: admins see everything, others see their own or
    their team's projects."""
    if user.role == UserRole.admin:
        return None
    conditions = [Project.created_by == user.id]
    if user.team_id is not None:
        conditions.append(Project.team_id == user.team_id)
    return or_(*conditions)


@router.get("/overview")
async def get_overview(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Return an executive overview payload aggregated across every project the
    current user can see:

    - totals: projects, event logs, cases, events, activities, and
      avg_events_per_case (a throughput-density proxy — see note below)
    - alerts: total, active, triggered in the last 24h
    - initiatives: total, active, achieved, realized savings
    - working_capital: which logs have a `cost_column` mapped (a pointer to
      cost-tracked projects — per-case dollar rollups are computed lazily by
      the Initiatives cost calculator, not here)
    - recent_event_logs: the 5 most recently created logs with their project

    NOTE: this endpoint intentionally never loads an event-log dataframe, so it
    reports `avg_events_per_case` (events ÷ cases) as a cheap density metric.
    That is NOT case cycle time (first-to-last event duration) — real cycle
    time lives on the per-log Bottlenecks / Performance views.
    """

    proj_filter = _visible_project_filter(current_user)

    # --- Projects ---
    proj_q = select(Project)
    if proj_filter is not None:
        proj_q = proj_q.where(proj_filter)
    projects = (await db.execute(proj_q)).scalars().all()
    project_ids = [p.id for p in projects]

    if not project_ids:
        return _empty_overview(project_count=0)

    proj_by_id = {p.id: p for p in projects}

    # --- Event logs ---
    logs_q = select(EventLog).where(EventLog.project_id.in_(project_ids))
    logs = (await db.execute(logs_q)).scalars().all()
    ready_logs = [
        l for l in logs
        if l.status == EventLogStatus.ready
        and not l.hidden
        and (l.log_type or "standard") == "standard"
    ]

    total_cases = sum(int(l.total_cases or 0) for l in ready_logs)
    total_events = sum(int(l.total_events or 0) for l in ready_logs)
    activity_union: set[str] = set()
    for l in ready_logs:
        for a in (l.activities_list or []):
            activity_union.add(str(a))

    # --- Throughput density (NOT cycle time) ---
    # Real case cycle time needs per-case durations, which would mean loading
    # every CSV. To keep this endpoint dataframe-free we report events ÷ cases —
    # a cheap density proxy the UI labels honestly as "Throughput density".
    # Cycle time proper is on the per-log Bottlenecks view.
    avg_events_per_case = (
        total_events / total_cases if total_cases > 0 else 0.0
    )

    # --- Alerts ---
    alerts_q = select(Alert).where(
        Alert.project_id.in_(project_ids)
    )
    alerts = (await db.execute(alerts_q)).scalars().all()
    active_alerts = [a for a in alerts if a.is_active]
    now = datetime.now(timezone.utc)
    last_24h = now - timedelta(hours=24)
    triggered_24h = [
        a for a in alerts
        if a.last_triggered is not None and a.last_triggered >= last_24h
    ]

    # --- Initiatives ---
    init_q = select(Initiative).where(Initiative.project_id.in_(project_ids))
    initiatives = (await db.execute(init_q)).scalars().all()
    active_initiatives = [i for i in initiatives if i.status == "active"]
    achieved_initiatives = [i for i in initiatives if i.status == "achieved"]
    realized_savings = sum(
        float(i.estimated_annual_savings or 0.0) for i in initiatives
    )

    # --- Working capital (opt-in: any log with cost_column set) ---
    cost_logs = [l for l in ready_logs if l.cost_column]
    working_capital: Optional[dict] = None
    if cost_logs:
        # Pointer only: we never load dataframes here, so rather than promise a
        # dollar figure we can't compute (the old payload returned total_cost /
        # cost_per_case = null on every call) we report *which* logs have a cost
        # column mapped. The per-case dollar rollup is computed on demand by the
        # Initiatives cost-per-case calculator.
        working_capital = {
            "logs_with_cost": len(cost_logs),
            "logs": [
                {
                    "id": str(l.id),
                    "name": l.name,
                    "project_id": str(l.project_id),
                    "project_name": proj_by_id.get(l.project_id).name
                    if proj_by_id.get(l.project_id)
                    else None,
                    "total_cases": int(l.total_cases or 0),
                }
                for l in cost_logs
            ],
        }

    # --- Recent event logs (for the activity feed) ---
    recent_logs = sorted(
        ready_logs,
        key=lambda l: l.created_at or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )[:5]
    recent_event_logs = [
        {
            "id": str(l.id),
            "name": l.name,
            "project_id": str(l.project_id),
            "project_name": proj_by_id.get(l.project_id).name if proj_by_id.get(l.project_id) else None,
            "total_cases": int(l.total_cases or 0),
            "total_events": int(l.total_events or 0),
            "created_at": l.created_at.isoformat() if l.created_at else None,
        }
        for l in recent_logs
    ]

    return {
        "totals": {
            "projects": len(projects),
            "event_logs": len(ready_logs),
            "total_cases": total_cases,
            "total_events": total_events,
            "total_activities": len(activity_union),
            "avg_events_per_case": round(avg_events_per_case, 2),
        },
        "alerts": {
            "total": len(alerts),
            "active": len(active_alerts),
            "triggered_last_24h": len(triggered_24h),
        },
        "initiatives": {
            "total": len(initiatives),
            "active": len(active_initiatives),
            "achieved": len(achieved_initiatives),
            "realized_savings": round(realized_savings, 2),
        },
        "working_capital": working_capital,
        "recent_event_logs": recent_event_logs,
    }


def _empty_overview(project_count: int) -> dict:
    return {
        "totals": {
            "projects": project_count,
            "event_logs": 0,
            "total_cases": 0,
            "total_events": 0,
            "total_activities": 0,
            "avg_events_per_case": 0.0,
        },
        "alerts": {"total": 0, "active": 0, "triggered_last_24h": 0},
        "initiatives": {
            "total": 0,
            "active": 0,
            "achieved": 0,
            "realized_savings": 0.0,
        },
        "working_capital": None,
        "recent_event_logs": [],
    }
