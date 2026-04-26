"""
Alert management router: CRUD operations and manual alert testing.
"""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Alert, AlertCondition, EventLog, NotificationChannel, User
from app.schemas.alert import AlertCreate, AlertResponse, AlertUpdate
from app.api.deps import get_current_active_user, assert_project_access, assert_event_log_access
from app.services.alert_evaluator import AlertEvaluator
from app.services.mining_engine import mining_engine

logger = logging.getLogger(__name__)

router = APIRouter()

alert_evaluator = AlertEvaluator()


@router.get("", response_model=list[AlertResponse])
async def list_alerts(
    project_id: UUID | None = Query(default=None, description="Filter by project ID"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """List alerts, optionally filtered by project ID."""
    if project_id is not None:
        await assert_project_access(project_id, db, current_user)
    query = select(Alert)
    if project_id is not None:
        query = query.where(Alert.project_id == project_id)
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
            query = query.where(Alert.project_id.in_(accessible))
    query = query.order_by(Alert.created_at.desc()).limit(limit).offset(offset)

    result = await db.execute(query)
    alerts = result.scalars().all()
    return alerts


@router.post("", response_model=AlertResponse, status_code=status.HTTP_201_CREATED)
async def create_alert(
    body: AlertCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Create a new alert."""
    await assert_project_access(body.project_id, db, current_user)
    # Validate event log exists
    el_result = await db.execute(
        select(EventLog).where(EventLog.id == body.event_log_id)
    )
    event_log = el_result.scalar_one_or_none()
    if event_log is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Event log not found"
        )

    # Validate condition enum
    try:
        condition_enum = AlertCondition(body.condition)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid condition: {body.condition}. "
            f"Must be one of: gt, lt, eq, gte, lte",
        )

    # Validate notification channel enum
    try:
        channel_enum = NotificationChannel(body.notification_channel)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid notification_channel: {body.notification_channel}. "
            f"Must be one of: email, webhook, slack",
        )

    alert = Alert(
        project_id=body.project_id,
        event_log_id=body.event_log_id,
        name=body.name,
        metric=body.metric,
        condition=condition_enum,
        threshold=body.threshold,
        notification_channel=channel_enum,
        webhook_url=body.webhook_url,
        email_recipients=body.email_recipients or [],
        created_by=current_user.id,
    )
    db.add(alert)
    await db.commit()
    await db.refresh(alert)
    return alert


@router.get("/{alert_id}", response_model=AlertResponse)
async def get_alert(
    alert_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Get an alert by ID."""
    result = await db.execute(select(Alert).where(Alert.id == alert_id))
    alert = result.scalar_one_or_none()
    if alert is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Alert not found"
        )
    await assert_project_access(alert.project_id, db, current_user)
    return alert


@router.put("/{alert_id}", response_model=AlertResponse)
async def update_alert(
    alert_id: UUID,
    body: AlertUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Update an alert's configuration."""
    result = await db.execute(select(Alert).where(Alert.id == alert_id))
    alert = result.scalar_one_or_none()
    if alert is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Alert not found"
        )
    await assert_project_access(alert.project_id, db, current_user)

    if body.name is not None:
        alert.name = body.name
    if body.metric is not None:
        alert.metric = body.metric
    if body.condition is not None:
        try:
            alert.condition = AlertCondition(body.condition)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid condition: {body.condition}",
            )
    if body.threshold is not None:
        alert.threshold = body.threshold
    if body.is_active is not None:
        alert.is_active = body.is_active
    if body.notification_channel is not None:
        try:
            alert.notification_channel = NotificationChannel(body.notification_channel)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid notification_channel: {body.notification_channel}",
            )
    if body.webhook_url is not None:
        alert.webhook_url = body.webhook_url
    if body.email_recipients is not None:
        alert.email_recipients = body.email_recipients

    await db.commit()
    await db.refresh(alert)
    return alert


@router.delete("/{alert_id}", status_code=status.HTTP_200_OK)
async def delete_alert(
    alert_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Delete an alert."""
    result = await db.execute(select(Alert).where(Alert.id == alert_id))
    alert = result.scalar_one_or_none()
    if alert is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Alert not found"
        )
    await assert_project_access(alert.project_id, db, current_user)

    await db.delete(alert)
    await db.commit()

    return {"detail": "Alert deleted", "alert_id": str(alert_id)}


@router.post("/{alert_id}/test")
async def test_alert(
    alert_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Manually trigger alert evaluation. Loads the associated event log,
    runs the alert engine, and returns the evaluation result without
    persisting any state changes.
    """
    result = await db.execute(select(Alert).where(Alert.id == alert_id))
    alert = result.scalar_one_or_none()
    if alert is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Alert not found"
        )
    await assert_project_access(alert.project_id, db, current_user)

    # Load the associated event log
    el_result = await db.execute(
        select(EventLog).where(EventLog.id == alert.event_log_id)
    )
    event_log = el_result.scalar_one_or_none()
    if event_log is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Associated event log not found",
        )

    if not event_log.case_id_column:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Event log column mapping not set",
        )

    if not event_log.file_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Event log file not found",
        )

    try:
        df = mining_engine.load_event_log(
            file_path=event_log.file_path,
            case_id_col=event_log.case_id_column,
            activity_col=event_log.activity_column,
            timestamp_col=event_log.timestamp_column,
            resource_col=event_log.resource_column,
            cost_col=event_log.cost_column,
        )
        evaluation = alert_evaluator.evaluate(alert, df)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        )
    except Exception as e:
        logger.error(f"Alert test failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Alert evaluation failed: {str(e)}",
        )

    # Return evaluation result — notifications are NOT sent for manual tests
    return {
        "alert_id": str(alert_id),
        "alert_name": alert.name,
        "metric": alert.metric,
        "threshold": alert.threshold,
        **evaluation,
    }
