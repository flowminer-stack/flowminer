"""Action Rules API: CRUD + evaluation for process execution management rules."""

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
from app.models.action_rule import ActionRule, ActionRuleExecution
from app.services.action_engine import dispatch_action, evaluate_rule
from app.services.mining_engine import mining_engine
from app.services.notifier import Notifier

_notifier = Notifier()

router = APIRouter()


class ActionRuleCreate(BaseModel):
    project_id: UUID
    event_log_id: UUID | None = None
    name: str
    description: str | None = None
    enabled: bool = True
    condition: dict
    action: dict
    cooldown_seconds: int = 3600


class ActionRuleUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    enabled: bool | None = None
    condition: dict | None = None
    action: dict | None = None
    cooldown_seconds: int | None = None


def _to_response(r: ActionRule) -> dict:
    return {
        "id": str(r.id),
        "project_id": str(r.project_id),
        "event_log_id": str(r.event_log_id) if r.event_log_id else None,
        "name": r.name,
        "description": r.description,
        "enabled": r.enabled,
        "condition": r.condition,
        "action": r.action,
        "cooldown_seconds": r.cooldown_seconds,
        "trigger_count": r.trigger_count,
        "last_triggered_at": str(r.last_triggered_at) if r.last_triggered_at else None,
        "created_at": str(r.created_at) if r.created_at else "",
    }


@router.get("")
async def list_rules(
    project_id: UUID,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    await assert_project_access(project_id, db, current_user)
    result = await db.execute(
        select(ActionRule).where(ActionRule.project_id == project_id).order_by(ActionRule.created_at.desc()).limit(limit).offset(offset)
    )
    return [_to_response(r) for r in result.scalars().all()]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_rule(
    body: ActionRuleCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    await assert_project_access(body.project_id, db, current_user)
    rule = ActionRule(
        project_id=body.project_id,
        event_log_id=body.event_log_id,
        name=body.name,
        description=body.description,
        enabled=body.enabled,
        condition=body.condition,
        action=body.action,
        cooldown_seconds=body.cooldown_seconds,
        created_by=current_user.id,
    )
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return _to_response(rule)


@router.put("/{rule_id}")
async def update_rule(
    rule_id: UUID,
    body: ActionRuleUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    result = await db.execute(select(ActionRule).where(ActionRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    await assert_project_access(rule.project_id, db, current_user)
    for field, val in body.model_dump(exclude_none=True).items():
        setattr(rule, field, val)
    await db.commit()
    await db.refresh(rule)
    return _to_response(rule)


@router.delete("/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule(
    rule_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    result = await db.execute(select(ActionRule).where(ActionRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    await assert_project_access(rule.project_id, db, current_user)
    await db.delete(rule)
    await db.commit()


@router.post("/{rule_id}/evaluate")
async def evaluate_rule_endpoint(
    rule_id: UUID,
    dry_run: bool = True,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Run a rule against its linked event log. If dry_run=False, dispatch actions and record executions."""
    result = await db.execute(select(ActionRule).where(ActionRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    await assert_project_access(rule.project_id, db, current_user)
    if not rule.event_log_id:
        raise HTTPException(status_code=400, detail="Rule has no linked event log")

    el_result = await db.execute(select(EventLog).where(EventLog.id == rule.event_log_id))
    event_log = el_result.scalar_one_or_none()
    if not event_log or not event_log.file_path or not os.path.exists(event_log.file_path):
        raise HTTPException(status_code=404, detail="Event log not found")

    df = mining_engine.load_event_log(
        file_path=event_log.file_path,
        case_id_col=event_log.case_id_column,
        activity_col=event_log.activity_column,
        timestamp_col=event_log.timestamp_column,
        resource_col=event_log.resource_column,
        cost_col=event_log.cost_column,
    )

    matches = evaluate_rule(df, rule.condition)
    dispatched = []

    if not dry_run and matches:
        for case in matches:
            detail = await dispatch_action(
                rule.action,
                case,
                dry_run=False,
                notifier=_notifier,
                db=db,
                event_log_id=rule.event_log_id,
                created_by=current_user.id,
            )
            dispatched.append(detail)
            db.add(
                ActionRuleExecution(
                    rule_id=rule.id,
                    case_id=case["case_id"],
                    success=bool(detail.get("success", False)),
                    details=detail,
                )
            )
        rule.trigger_count = (rule.trigger_count or 0) + len(matches)
        rule.last_triggered_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(rule)

    return {
        "rule_id": str(rule.id),
        "matched": len(matches),
        "dry_run": dry_run,
        "sample_cases": matches[:20],
        "dispatched": dispatched,
    }


@router.get("/{rule_id}/executions")
async def list_executions(
    rule_id: UUID,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    rule_result = await db.execute(select(ActionRule).where(ActionRule.id == rule_id))
    rule = rule_result.scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    await assert_project_access(rule.project_id, db, current_user)
    result = await db.execute(
        select(ActionRuleExecution)
        .where(ActionRuleExecution.rule_id == rule_id)
        .order_by(ActionRuleExecution.triggered_at.desc())
        .limit(limit)
        .offset(offset)
    )
    rows = result.scalars().all()
    return [
        {
            "id": str(e.id),
            "case_id": e.case_id,
            "triggered_at": str(e.triggered_at) if e.triggered_at else None,
            "success": e.success,
            "details": e.details,
        }
        for e in rows
    ]
