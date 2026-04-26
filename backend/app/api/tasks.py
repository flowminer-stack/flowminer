"""Task Inbox API — CRUD over the `tasks` table.

Tasks are operational work items created either manually or by the
action-rules engine when a process condition fires. Users browse their
inbox, transition status, and resolve items.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import assert_project_access, get_current_active_user
from app.database import get_db
from app.models.project import Project
from app.models.task import TASK_PRIORITIES, TASK_STATUSES, Task
from app.models.user import User, UserRole

router = APIRouter()


# ── Schemas ─────────────────────────────────────────────────────────────


class TaskCreate(BaseModel):
    project_id: UUID
    event_log_id: Optional[UUID] = None
    case_id: Optional[str] = None
    title: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    priority: str = Field(default="medium")
    assignee_id: Optional[UUID] = None
    source_rule_id: Optional[UUID] = None
    context: Optional[dict] = None


class TaskUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[str] = None
    status: Optional[str] = None
    assignee_id: Optional[UUID] = None
    snoozed_until: Optional[datetime] = None


class TaskResponse(BaseModel):
    id: UUID
    project_id: UUID
    event_log_id: Optional[UUID]
    case_id: Optional[str]
    title: str
    description: Optional[str]
    priority: str
    status: str
    assignee_id: Optional[UUID]
    source_rule_id: Optional[UUID]
    context: Optional[dict]
    created_by: Optional[UUID]
    created_at: datetime
    updated_at: datetime
    snoozed_until: Optional[datetime]
    resolved_at: Optional[datetime]

    class Config:
        from_attributes = True


# ── Helpers ─────────────────────────────────────────────────────────────


def _validate_status(s: str) -> str:
    if s not in TASK_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid status '{s}'. Must be one of: {', '.join(TASK_STATUSES)}",
        )
    return s


def _validate_priority(p: str) -> str:
    if p not in TASK_PRIORITIES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid priority '{p}'. Must be one of: {', '.join(TASK_PRIORITIES)}",
        )
    return p


async def _assert_task_access(task_id: UUID, db: AsyncSession, user: User) -> Task:
    task = await db.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    await assert_project_access(task.project_id, db, user)
    return task


async def _visible_project_ids(db: AsyncSession, user: User) -> list[UUID]:
    q = select(Project.id)
    if user.role != UserRole.admin:
        conditions = [Project.created_by == user.id]
        if user.team_id is not None:
            conditions.append(Project.team_id == user.team_id)
        q = q.where(or_(*conditions))
    result = await db.execute(q)
    return [row[0] for row in result.all()]


# ── Endpoints ───────────────────────────────────────────────────────────


@router.get("", response_model=list[TaskResponse])
async def list_tasks(
    task_status: Optional[str] = Query(default=None, alias="status"),
    project_id: Optional[UUID] = Query(default=None),
    assignee_id: Optional[UUID] = Query(default=None),
    case_id: Optional[str] = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """List tasks visible to the current user, filtered by status / project /
    assignee / case."""
    visible = await _visible_project_ids(db, current_user)
    if not visible:
        return []

    q = select(Task).where(Task.project_id.in_(visible))
    if task_status is not None:
        _validate_status(task_status)
        q = q.where(Task.status == task_status)
    if project_id is not None:
        if project_id not in visible:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Project not found"
            )
        q = q.where(Task.project_id == project_id)
    if assignee_id is not None:
        q = q.where(Task.assignee_id == assignee_id)
    if case_id is not None:
        q = q.where(Task.case_id == case_id)

    q = q.order_by(Task.created_at.desc()).limit(limit).offset(offset)
    result = await db.execute(q)
    tasks = result.scalars().all()
    return [TaskResponse.model_validate(t) for t in tasks]


@router.get("/summary")
async def tasks_summary(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Return counts of tasks by status for the badge / inbox header."""
    visible = await _visible_project_ids(db, current_user)
    if not visible:
        return {s: 0 for s in TASK_STATUSES} | {"total": 0}

    result = await db.execute(
        select(Task).where(Task.project_id.in_(visible))
    )
    tasks = result.scalars().all()
    counts = {s: 0 for s in TASK_STATUSES}
    for t in tasks:
        if t.status in counts:
            counts[t.status] += 1
    counts["total"] = len(tasks)
    return counts


@router.post("", response_model=TaskResponse, status_code=status.HTTP_201_CREATED)
async def create_task(
    body: TaskCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Create a new task. The caller must have access to the project."""
    await assert_project_access(body.project_id, db, current_user)
    _validate_priority(body.priority)

    task = Task(
        project_id=body.project_id,
        event_log_id=body.event_log_id,
        case_id=body.case_id,
        title=body.title,
        description=body.description,
        priority=body.priority,
        assignee_id=body.assignee_id,
        source_rule_id=body.source_rule_id,
        context=body.context,
        created_by=current_user.id,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return TaskResponse.model_validate(task)


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    task = await _assert_task_access(task_id, db, current_user)
    return TaskResponse.model_validate(task)


@router.patch("/{task_id}", response_model=TaskResponse)
async def update_task(
    task_id: UUID,
    body: TaskUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    task = await _assert_task_access(task_id, db, current_user)

    if body.title is not None:
        task.title = body.title
    if body.description is not None:
        task.description = body.description
    if body.priority is not None:
        _validate_priority(body.priority)
        task.priority = body.priority
    if body.status is not None:
        _validate_status(body.status)
        old_status = task.status
        task.status = body.status
        # Track resolve timestamp
        if body.status in ("resolved", "closed") and old_status not in ("resolved", "closed"):
            task.resolved_at = datetime.now(timezone.utc)
        elif body.status not in ("resolved", "closed"):
            task.resolved_at = None
    if body.assignee_id is not None:
        task.assignee_id = body.assignee_id
    if body.snoozed_until is not None:
        task.snoozed_until = body.snoozed_until

    await db.commit()
    await db.refresh(task)
    return TaskResponse.model_validate(task)


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task(
    task_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    task = await _assert_task_access(task_id, db, current_user)
    await db.delete(task)
    await db.commit()
    return None
