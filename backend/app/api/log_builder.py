"""Event Log Builder API: preview raw tables, build long event logs."""

import asyncio
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


class BuilderJoin(BaseModel):
    """Spec for joining one additional source onto the primary staging table.

    ``right_source`` is either a 0-based index into ``additional_sources`` (the
    common case from the wizard, which uploads each table and references it by
    position) or an explicit staging path. Keys must exist on both sides.
    """

    right_source: int | str
    left_on: list[str]
    right_on: list[str] | None = None
    how: str = "left"
    suffixes: list[str] | None = None


class BuildRequest(BaseModel):
    project_id: UUID
    name: str
    staging_path: str
    case_id_column: str
    events: list[BuilderEvent]
    resource_column: str | None = None
    passthrough_columns: list[str] | None = None
    # Optional multi-table support. Single-source requests omit both and behave
    # exactly as before. Each additional source is a staging path uploaded via
    # /upload-raw; joins reference them by index (or explicit path).
    additional_sources: list[str] = []
    joins: list[BuilderJoin] = []


def _staging_dir() -> str:
    path = os.path.join(settings.UPLOAD_DIR, "_builder_staging")
    os.makedirs(path, exist_ok=True)
    return path


def _validate_staging_path(raw_path: str) -> str:
    """Ensure ``raw_path`` exists and resolves inside the staging dir.

    Uses ``os.path.commonpath`` on realpaths (not a text ``startswith``) so
    ``/data/uploads2`` is not accepted as "inside" ``/data/uploads`` and
    symlinks are resolved. Raises HTTPException on any violation.
    """
    if not os.path.exists(raw_path):
        raise HTTPException(status_code=404, detail="Staging file not found (please re-upload)")
    staging = os.path.realpath(_staging_dir())
    resolved = os.path.realpath(raw_path)
    try:
        if os.path.commonpath([resolved, staging]) != staging:
            raise ValueError("outside staging dir")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid staging path")
    return resolved


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
    """Run the builder spec and create a new EventLog from the result.

    Supports single-source builds and multi-table assembly: when
    ``additional_sources`` + ``joins`` are supplied the primary staging table
    is merged with the additional staging tables (header+line+status ERP
    shape) into one wide table before the wide->long pivot. Every staging path
    — primary and additional — is validated to live inside the staging dir.
    """
    # Verify the caller can write to the target project before doing disk I/O
    await assert_project_access(body.project_id, db, current_user)

    # Validate the primary staging path is inside the staging directory.
    _validate_staging_path(body.staging_path)

    # Validate every additional source path the same way before any I/O.
    for src in body.additional_sources:
        _validate_staging_path(src)

    # Validate every join's right_source that is given as an explicit path.
    # A numeric right_source references an already-validated additional source
    # by index, so it needs no separate check; only string paths can escape the
    # staging dir and must pass the same guard as the primary/additional paths.
    for join in body.joins:
        right = join.right_source
        if isinstance(right, str) and not right.isdigit():
            _validate_staging_path(right)

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
            additional_sources=body.additional_sources,
            joins=[j.model_dump() for j in body.joins],
            # Defense-in-depth: re-validate every explicit string join
            # right_source inside the build so a path can never escape the
            # staging dir even if the loop above is bypassed.
            path_validator=_validate_staging_path,
        )
    except HTTPException:
        # Raised by the staging-path guard; preserve its 400/404 status.
        raise
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

    # Clean up staging files — not needed after build (primary + additional).
    for path in [body.staging_path, *body.additional_sources]:
        try:
            os.remove(path)
        except OSError:
            pass

    return {
        "event_log_id": str(event_log.id),
        "total_events": result["total_events"],
        "total_cases": result["total_cases"],
        "activities": result["activities"],
    }


class SuggestMappingRequest(BaseModel):
    """Ask the AI to suggest a column mapping for a source table.

    Provide either ``staging_path`` (a file already uploaded via /upload-raw,
    profiled server-side) or a ``columns`` profile + ``sample_rows`` directly
    (e.g. from a connector preview the frontend already holds). ``connector_type``
    is an optional hint (e.g. "sap", "servicenow").
    """

    staging_path: str | None = None
    columns: list[dict] | None = None
    sample_rows: list[dict] | None = None
    connector_type: str | None = None


@router.post("/suggest-mapping")
async def suggest_mapping_endpoint(
    body: SuggestMappingRequest,
    _current_user: User = Depends(get_current_active_user),
):
    """Suggest case_id/activity/timestamp/resource columns for a source table.

    Uses a cheap LLM (gpt-4.1-nano) to disambiguate the semantic mapping, with a
    deterministic heuristic fallback when no LLM is configured — so the connector
    onboarding step can pre-fill the mapping (accept/edit) instead of making the
    user pick columns by hand.
    """
    from app.services.ai import llm
    from app.services.ai.mapping_suggester import suggest_mapping

    if body.staging_path:
        path = _validate_staging_path(body.staging_path)
        try:
            preview = preview_table(path)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to preview file: {e}")
        columns = preview["columns"]
        sample_rows = preview["sample_rows"]
    elif body.columns:
        columns = body.columns
        sample_rows = body.sample_rows or []
    else:
        raise HTTPException(
            status_code=400,
            detail="Provide either 'staging_path' or 'columns' to suggest a mapping",
        )

    # suggest_mapping is sync (uses a sync LLM client); run off the event loop.
    result = await asyncio.to_thread(
        suggest_mapping, columns, sample_rows, body.connector_type
    )
    return {**result, "llm_configured": llm.is_llm_configured()}


@router.get("/templates")
async def list_templates(
    connector_type: str | None = None,
    category: str | None = None,
    _current_user: User = Depends(get_current_active_user),
):
    """Prebuilt process content packs (recipes) — system-specific templates that
    pre-fill the builder's tables/joins/events so a known process (SAP P2P,
    ServiceNow incident, Salesforce opportunity) goes from "upload your tables"
    to a mineable log without writing the extraction by hand."""
    from app.services.log_builder_recipes import list_recipes

    return [r.model_dump() for r in list_recipes(connector_type, category)]


@router.get("/templates/{recipe_id}")
async def get_template(
    recipe_id: str,
    _current_user: User = Depends(get_current_active_user),
):
    """A single recipe, including its builder events/joins and the
    additional_columns override layer."""
    from app.services.log_builder_recipes import get_recipe

    recipe = get_recipe(recipe_id)
    if recipe is None:
        raise HTTPException(status_code=404, detail="Template not found")
    return recipe.model_dump()
