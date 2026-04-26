"""Value/ROI Tracker: manage process-improvement initiatives, baselines, and savings."""

import os
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_active_user, assert_project_access
from app.database import get_db
from app.models import EventLog, User
from app.models.initiative import Initiative
from app.services.ingestion import CASE_COL, TIMESTAMP_COL
from app.services.mining_engine import mining_engine
from app.services.value_calculators import get_calculators, get_calculator

router = APIRouter()


@router.get("/value-calculators")
async def list_value_calculators(
    category: str | None = None,
    _current_user: User = Depends(get_current_active_user),
):
    """Return the pre-built ROI value calculator library.

    Each calculator is a named formula ("Reduce DSO", "Eliminate
    duplicate payments", etc.) that the frontend uses to populate the
    Initiative create form with sensible defaults and a ready-made
    savings formula.
    """
    calcs = get_calculators()
    if category:
        calcs = [c for c in calcs if c.get("category", "").lower() == category.lower()]
    return {"calculators": calcs, "categories": sorted({c["category"] for c in get_calculators()})}


class InitiativeCreate(BaseModel):
    project_id: UUID
    event_log_id: UUID | None = None
    name: str
    description: str | None = None
    metric: str
    unit: str | None = None
    baseline_value: float
    target_value: float
    value_per_unit_improvement: float | None = None
    scope: dict | None = None
    owner_id: UUID | None = None
    status: str = "active"


class InitiativeUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    target_value: float | None = None
    current_value: float | None = None
    status: str | None = None
    value_per_unit_improvement: float | None = None
    owner_id: UUID | None = None
    scope: dict | None = None


def _progress(init: Initiative) -> float:
    """Return a 0-1 progress ratio. Handles both 'lower is better' and
    'higher is better' metrics by detecting which direction the target is in."""
    if init.current_value is None:
        return 0.0
    total = init.target_value - init.baseline_value
    if total == 0:
        return 1.0
    delta = init.current_value - init.baseline_value
    progress = delta / total
    return max(0.0, min(1.0, progress))


def _savings(init: Initiative) -> float:
    if init.current_value is None or init.value_per_unit_improvement is None:
        return 0.0
    improvement = abs(init.baseline_value - init.current_value)
    return improvement * init.value_per_unit_improvement


def _to_response(init: Initiative) -> dict:
    return {
        "id": str(init.id),
        "project_id": str(init.project_id),
        "event_log_id": str(init.event_log_id) if init.event_log_id else None,
        "name": init.name,
        "description": init.description,
        "metric": init.metric,
        "unit": init.unit,
        "baseline_value": init.baseline_value,
        "baseline_at": str(init.baseline_at) if init.baseline_at else None,
        "target_value": init.target_value,
        "current_value": init.current_value,
        "last_measured_at": str(init.last_measured_at) if init.last_measured_at else None,
        "value_per_unit_improvement": init.value_per_unit_improvement,
        "estimated_annual_savings": init.estimated_annual_savings,
        "realized_savings": _savings(init),
        "progress": _progress(init),
        "status": init.status,
        "scope": init.scope,
        "owner_id": str(init.owner_id) if init.owner_id else None,
        "created_at": str(init.created_at) if init.created_at else "",
        "updated_at": str(init.updated_at) if init.updated_at else "",
    }


@router.get("")
async def list_initiatives(
    project_id: UUID,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    await assert_project_access(project_id, db, current_user)
    result = await db.execute(
        select(Initiative).where(Initiative.project_id == project_id).order_by(Initiative.created_at.desc()).limit(limit).offset(offset)
    )
    return [_to_response(i) for i in result.scalars().all()]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_initiative(
    body: InitiativeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    await assert_project_access(body.project_id, db, current_user)
    init = Initiative(
        project_id=body.project_id,
        event_log_id=body.event_log_id,
        name=body.name,
        description=body.description,
        metric=body.metric,
        unit=body.unit,
        baseline_value=body.baseline_value,
        baseline_at=datetime.now(timezone.utc),
        target_value=body.target_value,
        value_per_unit_improvement=body.value_per_unit_improvement,
        scope=body.scope,
        owner_id=body.owner_id or current_user.id,
        status=body.status,
        created_by=current_user.id,
    )
    db.add(init)
    await db.commit()
    await db.refresh(init)
    return _to_response(init)


@router.put("/{initiative_id}")
async def update_initiative(
    initiative_id: UUID,
    body: InitiativeUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    result = await db.execute(select(Initiative).where(Initiative.id == initiative_id))
    init = result.scalar_one_or_none()
    if not init:
        raise HTTPException(status_code=404, detail="Initiative not found")
    await assert_project_access(init.project_id, db, current_user)

    for field, val in body.model_dump(exclude_none=True).items():
        setattr(init, field, val)

    if body.current_value is not None:
        init.last_measured_at = datetime.now(timezone.utc)
        if init.value_per_unit_improvement is not None:
            init.estimated_annual_savings = _savings(init)

    await db.commit()
    await db.refresh(init)
    return _to_response(init)


@router.delete("/{initiative_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_initiative(
    initiative_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    result = await db.execute(select(Initiative).where(Initiative.id == initiative_id))
    init = result.scalar_one_or_none()
    if not init:
        raise HTTPException(status_code=404, detail="Initiative not found")
    await assert_project_access(init.project_id, db, current_user)
    await db.delete(init)
    await db.commit()


@router.post("/{initiative_id}/measure")
async def measure_initiative(
    initiative_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Recompute the current value for an initiative from its linked event log."""
    result = await db.execute(select(Initiative).where(Initiative.id == initiative_id))
    init = result.scalar_one_or_none()
    if not init:
        raise HTTPException(status_code=404, detail="Initiative not found")
    await assert_project_access(init.project_id, db, current_user)
    if not init.event_log_id:
        raise HTTPException(status_code=400, detail="Initiative has no linked event log")

    el_result = await db.execute(select(EventLog).where(EventLog.id == init.event_log_id))
    event_log = el_result.scalar_one_or_none()
    if not event_log or not event_log.file_path or not os.path.exists(event_log.file_path):
        raise HTTPException(status_code=404, detail="Event log file not found")

    df = mining_engine.load_event_log(
        file_path=event_log.file_path,
        case_id_col=event_log.case_id_column,
        activity_col=event_log.activity_column,
        timestamp_col=event_log.timestamp_column,
        resource_col=event_log.resource_column,
        cost_col=event_log.cost_column,
    )

    value = None
    m = init.metric
    if m == "avg_case_duration":
        d = df.groupby(CASE_COL)[TIMESTAMP_COL].apply(lambda x: (x.max() - x.min()).total_seconds())
        value = float(d.mean()) if len(d) > 0 else 0
    elif m == "rework_rate":
        r = mining_engine.get_rework(df)
        value = float(r.get("overall_rework_rate", 0))
    elif m == "throughput":
        value = float(df[CASE_COL].nunique())
    elif m == "fitness":
        c = mining_engine.run_conformance(df)
        value = float(c.get("fitness", 0))
    elif m == "cost_per_case":
        if event_log.cost_column and event_log.cost_column in df.columns:
            total = float(df[event_log.cost_column].fillna(0).sum())
            cases = df[CASE_COL].nunique()
            value = total / cases if cases else 0
        else:
            raise HTTPException(status_code=400, detail="No cost column mapped")
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported metric: {m}")

    init.current_value = value
    init.last_measured_at = datetime.now(timezone.utc)
    if init.value_per_unit_improvement is not None:
        init.estimated_annual_savings = _savings(init)
    await db.commit()
    await db.refresh(init)
    return _to_response(init)


@router.get("/summary/{project_id}")
async def initiative_summary(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Aggregate ROI across all initiatives in a project."""
    await assert_project_access(project_id, db, current_user)
    result = await db.execute(
        select(Initiative).where(Initiative.project_id == project_id)
    )
    initiatives = result.scalars().all()
    active = [i for i in initiatives if i.status == "active"]
    achieved = [i for i in initiatives if i.status == "achieved"]
    total_savings = sum(_savings(i) for i in initiatives)
    avg_progress = (
        sum(_progress(i) for i in active) / len(active) if active else 0.0
    )
    return {
        "total_initiatives": len(initiatives),
        "active": len(active),
        "achieved": len(achieved),
        "avg_progress": round(avg_progress, 3),
        "total_realized_savings": round(total_savings, 2),
    }
