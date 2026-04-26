"""Event Log Builder API: preview raw tables, build long event logs."""

import logging
import os
import uuid as uuid_mod
from uuid import UUID

import aiofiles
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import assert_project_access, get_current_active_user
from app.config import settings
from app.database import get_db
from app.models import EventLog, EventLogStatus, LogType, SourceType, User
from app.services.log_builder import build_event_log, preview_table

logger = logging.getLogger(__name__)

router = APIRouter()


class BuilderEvent(BaseModel):
    activity_name: str
    timestamp_column: str
    resource_column: str | None = None
    cost_column: str | None = None


class BuildRequest(BaseModel):
    project_id: UUID
    name: str
    staging_path: str
    case_id_column: str
    events: list[BuilderEvent]
    resource_column: str | None = None
    passthrough_columns: list[str] | None = None


def _staging_dir() -> str:
    path = os.path.join(settings.UPLOAD_DIR, "_builder_staging")
    os.makedirs(path, exist_ok=True)
    return path


@router.post("/upload-raw")
async def upload_raw(
    file: UploadFile = File(...),
    _current_user: User = Depends(get_current_active_user),
):
    """Upload a raw table for the builder. Returns a staging path and preview."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename required")
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in {".csv", ".parquet", ".xlsx", ".xls"}:
        raise HTTPException(
            status_code=400,
            detail="Builder supports .csv, .parquet, .xlsx, .xls",
        )

    unique = f"{uuid_mod.uuid4().hex}_{file.filename}"
    path = os.path.join(_staging_dir(), unique)
    async with aiofiles.open(path, "wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            await out.write(chunk)

    try:
        preview = preview_table(path)
    except Exception as e:
        if os.path.exists(path):
            os.remove(path)
        raise HTTPException(status_code=400, detail=f"Failed to preview file: {e}")

    return {
        "staging_path": path,
        "file_name": file.filename,
        **preview,
    }


@router.post("/build", status_code=status.HTTP_201_CREATED)
async def build(
    body: BuildRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Run the builder spec and create a new EventLog from the result."""
    # Verify the caller can write to the target project before doing disk I/O
    await assert_project_access(body.project_id, db, current_user)

    if not os.path.exists(body.staging_path):
        raise HTTPException(status_code=404, detail="Staging file not found (please re-upload)")

    # Verify path is inside the staging directory. ``startswith`` on
    # raw paths would accept ``/data/uploads2`` as "inside"
    # ``/data/uploads`` — use ``os.path.commonpath`` which compares
    # full path components instead of text prefixes and also handles
    # symlink resolution via ``os.path.realpath``.
    staging = os.path.realpath(_staging_dir())
    staging_path = os.path.realpath(body.staging_path)
    try:
        if os.path.commonpath([staging_path, staging]) != staging:
            raise ValueError("outside staging dir")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid staging path")

    # Write output into the regular project upload dir
    project_dir = os.path.join(settings.UPLOAD_DIR, str(body.project_id))
    os.makedirs(project_dir, exist_ok=True)
    output_name = f"{uuid_mod.uuid4().hex}_builder_{body.name}.csv"
    output_path = os.path.join(project_dir, output_name)

    try:
        result = build_event_log(
            file_path=body.staging_path,
            case_id_column=body.case_id_column,
            events=[e.model_dump() for e in body.events],
            resource_column=body.resource_column,
            passthrough_columns=body.passthrough_columns,
            output_path=output_path,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Builder failed")
        raise HTTPException(status_code=500, detail=f"Builder failed: {e}")

    # Register as a new EventLog with column mapping pre-populated
    event_log = EventLog(
        project_id=body.project_id,
        name=body.name,
        file_path=output_path,
        source_type=SourceType.upload,
        log_type=LogType.standard,
        status=EventLogStatus.ready,
        case_id_column="case_id",
        activity_column="activity",
        timestamp_column="timestamp",
        resource_column="resource" if "resource" in result["columns"] else None,
        cost_column="cost" if "cost" in result["columns"] else None,
        total_events=result["total_events"],
        total_cases=result["total_cases"],
        total_activities=len(result["activities"]),
    )
    db.add(event_log)
    await db.commit()
    await db.refresh(event_log)

    # Clean up staging file — not needed after build
    try:
        os.remove(body.staging_path)
    except OSError:
        pass

    return {
        "event_log_id": str(event_log.id),
        "total_events": result["total_events"],
        "total_cases": result["total_cases"],
        "activities": result["activities"],
    }
