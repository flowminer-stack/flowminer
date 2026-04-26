"""ETL pipeline: define, preview, and execute data transformation pipelines."""

import os
from uuid import UUID
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import User, EventLog
from app.models.etl_pipeline import ETLPipeline
from app.api.deps import get_current_active_user, assert_project_access, assert_event_log_access
from app.services.mining_engine import mining_engine
from app.services.etl_executor import execute_pipeline

router = APIRouter()


class PipelineCreate(BaseModel):
    project_id: UUID
    name: str
    description: str | None = None
    steps: list[dict] = []
    source_event_log_id: UUID | None = None


class PipelineUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    steps: list[dict] | None = None


def _to_response(p: ETLPipeline) -> dict:
    return {
        "id": str(p.id),
        "project_id": str(p.project_id),
        "name": p.name,
        "description": p.description,
        "steps": p.steps or [],
        "source_event_log_id": str(p.source_event_log_id) if p.source_event_log_id else None,
        "last_run_at": str(p.last_run_at) if p.last_run_at else None,
        "last_run_rows": p.last_run_rows,
        "last_run_status": p.last_run_status,
        "last_run_error": p.last_run_error,
        "created_at": str(p.created_at) if p.created_at else "",
    }


@router.get("")
async def list_pipelines(
    project_id: UUID,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    await assert_project_access(project_id, db, current_user)
    result = await db.execute(
        select(ETLPipeline).where(ETLPipeline.project_id == project_id).order_by(ETLPipeline.created_at).limit(limit).offset(offset)
    )
    return [_to_response(p) for p in result.scalars().all()]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_pipeline(
    body: PipelineCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    await assert_project_access(body.project_id, db, current_user)
    pipeline = ETLPipeline(
        project_id=body.project_id,
        name=body.name,
        description=body.description,
        steps=body.steps,
        source_event_log_id=body.source_event_log_id,
        created_by=current_user.id,
    )
    db.add(pipeline)
    await db.commit()
    await db.refresh(pipeline)
    return _to_response(pipeline)


@router.put("/{pipeline_id}")
async def update_pipeline(
    pipeline_id: UUID,
    body: PipelineUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    result = await db.execute(select(ETLPipeline).where(ETLPipeline.id == pipeline_id))
    pipeline = result.scalar_one_or_none()
    if not pipeline:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    await assert_project_access(pipeline.project_id, db, current_user)
    for field, val in body.model_dump(exclude_none=True).items():
        setattr(pipeline, field, val)
    await db.commit()
    await db.refresh(pipeline)
    return _to_response(pipeline)


@router.delete("/{pipeline_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_pipeline(
    pipeline_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    result = await db.execute(select(ETLPipeline).where(ETLPipeline.id == pipeline_id))
    pipeline = result.scalar_one_or_none()
    if not pipeline:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    await assert_project_access(pipeline.project_id, db, current_user)
    await db.delete(pipeline)
    await db.commit()


@router.post("/{pipeline_id}/preview")
async def preview_pipeline(
    pipeline_id: UUID,
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Apply pipeline to an event log and return a preview (first 100 rows)."""
    result = await db.execute(select(ETLPipeline).where(ETLPipeline.id == pipeline_id))
    pipeline = result.scalar_one_or_none()
    if not pipeline:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    await assert_project_access(pipeline.project_id, db, current_user)
    await assert_event_log_access(event_log_id, db, current_user)

    el_result = await db.execute(select(EventLog).where(EventLog.id == event_log_id))
    event_log = el_result.scalar_one_or_none()
    if not event_log or not event_log.file_path:
        raise HTTPException(status_code=404, detail="Event log not found")

    df = mining_engine.load_event_log(
        file_path=event_log.file_path,
        case_id_col=event_log.case_id_column,
        activity_col=event_log.activity_column,
        timestamp_col=event_log.timestamp_column,
        resource_col=event_log.resource_column,
        cost_col=event_log.cost_column,
    )

    try:
        transformed = execute_pipeline(df, pipeline.steps or [])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "original_rows": len(df),
        "transformed_rows": len(transformed),
        "columns": list(transformed.columns),
        "sample_rows": transformed.head(100).to_dict(orient="records"),
    }


@router.post("/{pipeline_id}/execute")
async def execute_pipeline_endpoint(
    pipeline_id: UUID,
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Execute pipeline and save result as a new event log file."""
    result = await db.execute(select(ETLPipeline).where(ETLPipeline.id == pipeline_id))
    pipeline = result.scalar_one_or_none()
    if not pipeline:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    await assert_project_access(pipeline.project_id, db, current_user)
    await assert_event_log_access(event_log_id, db, current_user)

    el_result = await db.execute(select(EventLog).where(EventLog.id == event_log_id))
    event_log = el_result.scalar_one_or_none()
    if not event_log or not event_log.file_path:
        raise HTTPException(status_code=404, detail="Event log not found")

    df = mining_engine.load_event_log(
        file_path=event_log.file_path,
        case_id_col=event_log.case_id_column,
        activity_col=event_log.activity_column,
        timestamp_col=event_log.timestamp_column,
        resource_col=event_log.resource_column,
        cost_col=event_log.cost_column,
    )

    try:
        transformed = execute_pipeline(df, pipeline.steps or [])
    except ValueError as e:
        pipeline.last_run_status = "error"
        pipeline.last_run_error = str(e)
        pipeline.last_run_at = datetime.now(timezone.utc)
        await db.commit()
        raise HTTPException(status_code=400, detail=str(e))

    # Save transformed data
    import uuid as uuid_lib
    upload_dir = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")
    os.makedirs(upload_dir, exist_ok=True)
    output_path = os.path.join(upload_dir, f"etl_{uuid_lib.uuid4().hex[:8]}.parquet")
    transformed.to_parquet(output_path, index=False)

    # Create a new EventLog record for the transformed data
    from app.models import EventLogStatus, SourceType
    new_log = EventLog(
        project_id=event_log.project_id,
        name=f"{event_log.name} (transformed: {pipeline.name})",
        file_path=output_path,
        source_type=SourceType.upload,
        status=EventLogStatus.ready,
        case_id_column=event_log.case_id_column,
        activity_column=event_log.activity_column,
        timestamp_column=event_log.timestamp_column,
        resource_column=event_log.resource_column,
        cost_column=event_log.cost_column,
        total_cases=int(transformed[event_log.case_id_column].nunique()) if event_log.case_id_column and event_log.case_id_column in transformed.columns else 0,
        total_events=len(transformed),
        total_activities=int(transformed[event_log.activity_column].nunique()) if event_log.activity_column and event_log.activity_column in transformed.columns else 0,
    )
    db.add(new_log)

    pipeline.last_run_at = datetime.now(timezone.utc)
    pipeline.last_run_rows = len(transformed)
    pipeline.last_run_status = "success"
    pipeline.last_run_error = None
    await db.commit()
    await db.refresh(new_log)

    return {
        "status": "success",
        "new_event_log_id": str(new_log.id),
        "rows": len(transformed),
        "columns": list(transformed.columns),
    }
