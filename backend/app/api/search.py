"""
Global search router: search across projects, event logs, and activities.
"""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import EventLog, Project, User
from app.api.deps import get_current_active_user
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()

RESULT_LIMIT = 20


class SearchResult(BaseModel):
    type: str  # "project", "event_log", "activity"
    id: str
    name: str
    description: str | None = None
    parent_id: str | None = None   # project_id for event logs / activities
    parent_name: str | None = None


class SearchResponse(BaseModel):
    query: str
    results: list[SearchResult]
    total: int


@router.get("", response_model=SearchResponse)
async def search(
    q: str = Query(..., min_length=1, max_length=200),
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_active_user),
):
    """
    Search across projects (name, description), event logs (name), and
    activities (from the activities_list JSON column on event logs).
    Returns up to 20 grouped results ordered: projects, event logs, activities.
    """
    pattern = f"%{q}%"
    results: list[SearchResult] = []

    # --- 1. Projects: search name and description ---
    proj_stmt = (
        select(Project)
        .where(
            Project.name.ilike(pattern) | Project.description.ilike(pattern)
        )
        .order_by(Project.created_at.desc())
        .limit(RESULT_LIMIT)
    )
    proj_rows = (await db.execute(proj_stmt)).scalars().all()
    for p in proj_rows:
        results.append(
            SearchResult(
                type="project",
                id=str(p.id),
                name=p.name,
                description=p.description,
            )
        )

    if len(results) >= RESULT_LIMIT:
        results = results[:RESULT_LIMIT]
        return SearchResponse(query=q, results=results, total=len(results))

    remaining = RESULT_LIMIT - len(results)

    # --- 2. Event logs: search name ---
    log_stmt = (
        select(EventLog, Project.name.label("project_name"))
        .join(Project, EventLog.project_id == Project.id, isouter=True)
        .where(EventLog.name.ilike(pattern))
        .order_by(EventLog.created_at.desc())
        .limit(remaining)
    )
    log_rows = (await db.execute(log_stmt)).all()
    for row in log_rows:
        event_log, project_name = row
        results.append(
            SearchResult(
                type="event_log",
                id=str(event_log.id),
                name=event_log.name,
                parent_id=str(event_log.project_id),
                parent_name=project_name,
            )
        )

    if len(results) >= RESULT_LIMIT:
        results = results[:RESULT_LIMIT]
        return SearchResponse(query=q, results=results, total=len(results))

    remaining = RESULT_LIMIT - len(results)

    # --- 3. Activities: scan activities_list JSON column on event logs ---
    # Load event logs that have a non-empty activities_list and a project name
    act_log_stmt = (
        select(EventLog, Project.name.label("project_name"))
        .join(Project, EventLog.project_id == Project.id, isouter=True)
        .where(EventLog.activities_list.isnot(None))
        .order_by(EventLog.created_at.desc())
    )
    act_log_rows = (await db.execute(act_log_stmt)).all()

    q_lower = q.lower()
    activity_hits: list[SearchResult] = []
    seen_activities: set[str] = set()

    for row in act_log_rows:
        event_log, project_name = row
        activities = event_log.activities_list
        if not isinstance(activities, list):
            continue
        for activity in activities:
            activity_str = str(activity)
            if q_lower in activity_str.lower() and activity_str not in seen_activities:
                seen_activities.add(activity_str)
                activity_hits.append(
                    SearchResult(
                        type="activity",
                        id=f"{event_log.id}::{activity_str}",
                        name=activity_str,
                        parent_id=str(event_log.project_id),
                        parent_name=project_name,
                    )
                )
                if len(activity_hits) >= remaining:
                    break
        if len(activity_hits) >= remaining:
            break

    results.extend(activity_hits[:remaining])
    results = results[:RESULT_LIMIT]

    return SearchResponse(query=q, results=results, total=len(results))
