"""
Project management router: CRUD operations with event log counts.
"""

import csv
import io
import logging
import os
import uuid as uuid_mod
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models import EventLog, EventLogStatus, LogType, Project, SourceType, User, UserRole
from app.schemas.project import ProjectCreate, ProjectResponse, ProjectUpdate
from app.api.deps import get_current_active_user, get_owned_project

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Running-example sample data (pm4py canonical 6-case, 8-activity, 35-event log)
# ---------------------------------------------------------------------------
_SAMPLE_DATA = [
    # Case 1
    {"Case ID": "1", "Activity": "register request",    "Timestamp": "2010-12-30 11:02:00", "Resource": "Pete"},
    {"Case ID": "1", "Activity": "examine thoroughly",  "Timestamp": "2010-12-31 10:06:00", "Resource": "Sue"},
    {"Case ID": "1", "Activity": "check ticket",        "Timestamp": "2011-01-01 14:32:00", "Resource": "Mike"},
    {"Case ID": "1", "Activity": "decide",              "Timestamp": "2011-01-05 11:18:00", "Resource": "Sara"},
    {"Case ID": "1", "Activity": "reject request",      "Timestamp": "2011-01-06 15:02:00", "Resource": "Pete"},
    # Case 2
    {"Case ID": "2", "Activity": "register request",    "Timestamp": "2010-12-30 11:32:00", "Resource": "Mike"},
    {"Case ID": "2", "Activity": "check ticket",        "Timestamp": "2010-12-30 12:12:00", "Resource": "Mike"},
    {"Case ID": "2", "Activity": "examine casually",    "Timestamp": "2010-12-30 14:16:00", "Resource": "Pete"},
    {"Case ID": "2", "Activity": "check ticket",        "Timestamp": "2011-01-06 11:18:00", "Resource": "Mike"},
    {"Case ID": "2", "Activity": "decide",              "Timestamp": "2011-01-07 12:48:00", "Resource": "Sara"},
    {"Case ID": "2", "Activity": "pay compensation",    "Timestamp": "2011-01-08 11:16:00", "Resource": "Ellen"},
    # Case 3
    {"Case ID": "3", "Activity": "register request",    "Timestamp": "2010-12-30 14:32:00", "Resource": "Pete"},
    {"Case ID": "3", "Activity": "examine casually",    "Timestamp": "2010-12-30 15:48:00", "Resource": "Mike"},
    {"Case ID": "3", "Activity": "check ticket",        "Timestamp": "2011-01-02 09:28:00", "Resource": "Sue"},
    {"Case ID": "3", "Activity": "decide",              "Timestamp": "2011-01-02 12:32:00", "Resource": "Sara"},
    {"Case ID": "3", "Activity": "pay compensation",    "Timestamp": "2011-01-04 14:56:00", "Resource": "Ellen"},
    # Case 4
    {"Case ID": "4", "Activity": "register request",    "Timestamp": "2010-12-30 16:32:00", "Resource": "Pete"},
    {"Case ID": "4", "Activity": "examine thoroughly",  "Timestamp": "2011-01-01 08:18:00", "Resource": "Sue"},
    {"Case ID": "4", "Activity": "check ticket",        "Timestamp": "2011-01-01 11:48:00", "Resource": "Mike"},
    {"Case ID": "4", "Activity": "decide",              "Timestamp": "2011-01-02 14:18:00", "Resource": "Sara"},
    {"Case ID": "4", "Activity": "reject request",      "Timestamp": "2011-01-03 11:48:00", "Resource": "Pete"},
    # Case 5
    {"Case ID": "5", "Activity": "register request",    "Timestamp": "2011-01-05 11:02:00", "Resource": "Pete"},
    {"Case ID": "5", "Activity": "examine casually",    "Timestamp": "2011-01-05 13:06:00", "Resource": "Pete"},
    {"Case ID": "5", "Activity": "check ticket",        "Timestamp": "2011-01-06 09:48:00", "Resource": "Mike"},
    {"Case ID": "5", "Activity": "examine casually",    "Timestamp": "2011-01-07 08:58:00", "Resource": "Pete"},
    {"Case ID": "5", "Activity": "check ticket",        "Timestamp": "2011-01-08 11:18:00", "Resource": "Mike"},
    {"Case ID": "5", "Activity": "decide",              "Timestamp": "2011-01-10 13:28:00", "Resource": "Sara"},
    {"Case ID": "5", "Activity": "pay compensation",    "Timestamp": "2011-01-11 16:18:00", "Resource": "Ellen"},
    # Case 6
    {"Case ID": "6", "Activity": "register request",    "Timestamp": "2011-01-06 09:02:00", "Resource": "Mike"},
    {"Case ID": "6", "Activity": "examine casually",    "Timestamp": "2011-01-06 11:18:00", "Resource": "Pete"},
    {"Case ID": "6", "Activity": "check ticket",        "Timestamp": "2011-01-07 12:18:00", "Resource": "Mike"},
    {"Case ID": "6", "Activity": "examine thoroughly",  "Timestamp": "2011-01-08 08:58:00", "Resource": "Sue"},
    {"Case ID": "6", "Activity": "check ticket",        "Timestamp": "2011-01-09 11:18:00", "Resource": "Mike"},
    {"Case ID": "6", "Activity": "decide",              "Timestamp": "2011-01-10 12:28:00", "Resource": "Sara"},
    {"Case ID": "6", "Activity": "reject request",      "Timestamp": "2011-01-11 15:18:00", "Resource": "Pete"},
]

router = APIRouter()


async def _project_response(db: AsyncSession, project: Project) -> dict:
    """Build a ProjectResponse dict with computed log counts.

    Returns:
        - event_log_count: every event log on the project
        - cost_log_count:  ready standard logs with cost_column populated
        - ocel_log_count:  ready OCEL logs
    """
    count_result = await db.execute(
        select(func.count(EventLog.id)).where(EventLog.project_id == project.id)
    )
    event_log_count = count_result.scalar() or 0

    cost_result = await db.execute(
        select(func.count(EventLog.id)).where(
            EventLog.project_id == project.id,
            EventLog.status == EventLogStatus.ready,
            EventLog.cost_column.isnot(None),
            EventLog.cost_column != "",
        )
    )
    cost_log_count = cost_result.scalar() or 0

    ocel_result = await db.execute(
        select(func.count(EventLog.id)).where(
            EventLog.project_id == project.id,
            EventLog.status == EventLogStatus.ready,
            EventLog.log_type == "ocel",
        )
    )
    ocel_log_count = ocel_result.scalar() or 0

    return ProjectResponse(
        id=project.id,
        name=project.name,
        description=project.description,
        team_id=project.team_id,
        created_by=project.created_by,
        created_at=project.created_at,
        updated_at=project.updated_at,
        event_log_count=event_log_count,
        cost_log_count=cost_log_count,
        ocel_log_count=ocel_log_count,
    )


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    team_id: UUID | None = Query(default=None, description="Filter by team ID"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """List projects the current user can see.

    Admins see everything. Non-admins only see projects they created OR
    projects belonging to their team.
    """
    from sqlalchemy import or_

    query = select(Project)

    # Row-level filter (skipped for admins)
    if current_user.role != UserRole.admin:
        visibility = [Project.created_by == current_user.id]
        if current_user.team_id is not None:
            visibility.append(Project.team_id == current_user.team_id)
        query = query.where(or_(*visibility))

    if team_id is not None:
        query = query.where(Project.team_id == team_id)

    query = query.order_by(Project.created_at.desc()).limit(limit).offset(offset)

    result = await db.execute(query)
    projects = result.scalars().all()

    responses = []
    for project in projects:
        resp = await _project_response(db, project)
        responses.append(resp)

    return responses


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Create a new project owned by the current user."""
    project = Project(
        name=body.name,
        description=body.description,
        team_id=body.team_id,
        created_by=current_user.id,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)

    return await _project_response(db, project)


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project: Project = Depends(get_owned_project),
    db: AsyncSession = Depends(get_db),
):
    """Get a single project by ID with event log count."""
    return await _project_response(db, project)


@router.put("/{project_id}", response_model=ProjectResponse)
async def update_project(
    body: ProjectUpdate,
    project: Project = Depends(get_owned_project),
    db: AsyncSession = Depends(get_db),
):
    """Update a project's name and/or description."""
    if body.name is not None:
        project.name = body.name
    if body.description is not None:
        project.description = body.description

    await db.commit()
    await db.refresh(project)

    return await _project_response(db, project)


@router.post("/seed-sample", status_code=status.HTTP_201_CREATED)
async def seed_sample_project(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Create a sample project pre-loaded with the running-example event log
    (6 cases, 8 activities, 35 events from the pm4py canonical example).

    The project and event log are fully configured and ready for analysis.
    """
    # 1. Create the project
    project = Project(
        name="Sample — Order Process",
        description=(
            "A sample order handling process based on the pm4py running-example. "
            "Includes 6 cases covering register, examine, check, decide, and outcome activities."
        ),
        created_by=current_user.id,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)

    # 2. Write CSV to disk
    project_dir = os.path.join(settings.UPLOAD_DIR, str(project.id))
    os.makedirs(project_dir, exist_ok=True)

    filename = f"{uuid_mod.uuid4().hex}_running-example.csv"
    file_path = os.path.join(project_dir, filename)

    fieldnames = ["Case ID", "Activity", "Timestamp", "Resource"]
    try:
        with open(file_path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(_SAMPLE_DATA)
    except OSError as exc:
        await db.delete(project)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Could not write sample CSV to disk: {exc}",
        )

    # 3. Compute stats inline
    activities = [row["Activity"] for row in _SAMPLE_DATA]
    unique_activities = sorted(set(activities))
    case_ids = [row["Case ID"] for row in _SAMPLE_DATA]
    unique_cases = set(case_ids)

    # 4. Create EventLog record
    event_log = EventLog(
        project_id=project.id,
        name="running-example.csv",
        file_path=file_path,
        source_type=SourceType.upload,
        log_type=LogType.standard,
        status=EventLogStatus.ready,
        case_id_column="Case ID",
        activity_column="Activity",
        timestamp_column="Timestamp",
        resource_column="Resource",
        total_cases=len(unique_cases),
        total_events=len(_SAMPLE_DATA),
        total_activities=len(unique_activities),
        activities_list=unique_activities,
    )
    db.add(event_log)
    await db.commit()
    await db.refresh(project)

    return await _project_response(db, project)


@router.delete("/{project_id}", status_code=status.HTTP_200_OK)
async def delete_project(
    project: Project = Depends(get_owned_project),
    db: AsyncSession = Depends(get_db),
):
    """
    Delete a project and all associated data (event logs, dashboards, alerts).
    Cascade delete is handled by the ORM relationship configuration.
    """
    project_id = project.id
    await db.delete(project)
    await db.commit()

    return {"detail": "Project deleted", "project_id": str(project_id)}
