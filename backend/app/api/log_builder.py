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

from sqlalchemy import select

from app.api.deps import assert_project_access, get_current_active_user
from app.config import settings
from app.database import get_db
from app.models import (
    Alert,
    AlertCondition,
    CustomKPI,
    EventLog,
    EventLogStatus,
    LogType,
    NotificationChannel,
    SourceType,
    User,
)
from app.services.log_builder import build_event_log, build_ocel, preview_table

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
    # case_id_column is the case identifier for a STANDARD (traditional) build.
    # In OCEL mode it is unused (objects, not a single case id, drive the log) —
    # so it is optional and only required/validated for the standard path.
    case_id_column: str | None = None
    events: list[BuilderEvent]
    resource_column: str | None = None
    passthrough_columns: list[str] | None = None
    # Optional multi-table support. Single-source requests omit both and behave
    # exactly as before. Each additional source is a staging path uploaded via
    # /upload-raw; joins reference them by index (or explicit path).
    additional_sources: list[str] = []
    joins: list[BuilderJoin] = []
    # Object-centric (OCEL) build. When ``ocel_mode`` is True the same wide
    # table (single- or multi-table) is unpivoted into an OCEL 2.0 log instead
    # of a traditional case-centric log: each column in ``object_type_columns``
    # designates an OCEL object type whose id lives in that column, and every
    # event relates one object of each designated type. The result is persisted
    # as a reloadable EventLog row (log_type='ocel') so the OCPM views can open
    # it by id. Single-source and multi-table assembly work identically here —
    # they share the same join/staging plumbing as the standard build.
    ocel_mode: bool = False
    object_type_columns: list[str] = []
    # When set, the named vertical recipe's enrichment (default alert rules,
    # default KPIs, and reference Petri net) is materialised against the new
    # log after a successful build: real Alert + CustomKPI rows are committed
    # and the reference model is persisted so conformance can replay against it.
    # Standard builds without a recipe_id are unaffected.
    recipe_id: str | None = None


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

    When ``ocel_mode`` is True the same assembled wide table is turned into an
    object-centric (OCEL 2.0) log instead — ``object_type_columns`` designate
    the OCEL object types — and the persisted EventLog row is ``log_type='ocel'``
    so the OCPM views can open it by the returned ``ocel_id`` (see ``_build_ocel``).
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

    # ------------------------------------------------------------------
    # Object-centric (OCEL) build branch. Diverges from the standard build
    # only in WHICH service it calls and HOW it persists the result: a
    # log_type='ocel' EventLog row pointing at a .jsonocel file, so the OCPM
    # views (/ocpm/:id) can reload it by id via _get_ocel_or_404.
    # ------------------------------------------------------------------
    if body.ocel_mode:
        return await _build_ocel(body, db)

    if not body.case_id_column:
        raise HTTPException(
            status_code=400,
            detail="case_id_column is required for a standard (non-OCEL) build",
        )

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

    # Materialise the recipe's enrichment (alerts/KPIs/reference model) against
    # the new log. Wrapped so an enrichment failure never fails the core build:
    # the log is already committed above, so we log + continue on any error.
    recipe_applied = None
    if body.recipe_id:
        try:
            recipe_applied = await _apply_recipe_enrichment(
                body.recipe_id,
                event_log=event_log,
                db=db,
                current_user=current_user,
            )
        except Exception as e:
            logger.exception("Recipe enrichment failed for log %s", event_log.id)
            try:
                await db.rollback()
            except Exception:
                pass
            recipe_applied = {
                "recipe_id": body.recipe_id,
                "alerts_created": 0,
                "kpis_created": 0,
                "reference_model_attached": False,
                "error": str(e),
            }

    response = {
        "event_log_id": str(event_log.id),
        "total_events": result["total_events"],
        "total_cases": result["total_cases"],
        "activities": result["activities"],
    }
    if recipe_applied is not None:
        response["recipe_applied"] = recipe_applied
    return response


async def _apply_recipe_enrichment(
    recipe_id: str,
    *,
    event_log: EventLog,
    db: AsyncSession,
    current_user: User,
) -> dict:
    """Materialise a recipe's enrichment against a freshly-built log.

    Turns the recipe's decorative ``default_alert_rules`` / ``default_kpis`` /
    ``reference_model`` JSON into REAL persisted rows:

      * one ``Alert`` per default rule (project- and log-scoped, in-app channel),
      * one ``CustomKPI`` per default KPI (project-scoped, de-duped by name),
      * the reference Petri net written to a sidecar next to the log file so
        the conformance endpoint can replay traces against it.

    Returns a summary ``{recipe_id, alerts_created, kpis_created,
    reference_model_attached}``. Callers wrap this in try/except so an
    enrichment failure never fails the core build.
    """
    from app.services.log_builder_recipes import (
        get_recipe,
        write_reference_model_sidecar,
    )

    summary = {
        "recipe_id": recipe_id,
        "alerts_created": 0,
        "kpis_created": 0,
        "reference_model_attached": False,
    }

    recipe = get_recipe(recipe_id)
    if recipe is None:
        logger.warning("Recipe %r not found; skipping enrichment", recipe_id)
        return summary

    # ── Alerts ──────────────────────────────────────────────────────────
    for rule in recipe.default_alert_rules:
        try:
            condition = AlertCondition(rule.condition)
        except ValueError:
            logger.warning(
                "Recipe %r alert %r has unknown condition %r; skipping",
                recipe_id,
                rule.name,
                rule.condition,
            )
            continue
        db.add(
            Alert(
                project_id=event_log.project_id,
                event_log_id=event_log.id,
                name=rule.name,
                metric=rule.metric,
                condition=condition,
                threshold=rule.threshold,
                notification_channel=NotificationChannel.in_app,
                created_by=current_user.id,
                is_active=True,
            )
        )
        summary["alerts_created"] += 1

    # ── KPIs (project-scoped; de-dupe by (project_id, name)) ────────────
    if recipe.default_kpis:
        existing = await db.execute(
            select(CustomKPI.name).where(CustomKPI.project_id == event_log.project_id)
        )
        existing_names = {row[0] for row in existing.all()}
        for kpi in recipe.default_kpis:
            if kpi.name in existing_names:
                continue
            db.add(
                CustomKPI(
                    project_id=event_log.project_id,
                    name=kpi.name,
                    metric=kpi.metric,
                    unit=kpi.unit,
                    target_value=kpi.target,
                    created_by=current_user.id,
                )
            )
            existing_names.add(kpi.name)  # guard against dup names within the recipe
            summary["kpis_created"] += 1

    # ── Reference model (sidecar next to the log file) ───────────────────
    if recipe.reference_model and event_log.file_path:
        try:
            summary["reference_model_attached"] = write_reference_model_sidecar(
                event_log.file_path, recipe.reference_model
            )
        except OSError as e:
            logger.warning(
                "Could not persist reference model for log %s: %s", event_log.id, e
            )

    await db.commit()
    return summary


async def _build_ocel(body: "BuildRequest", db: AsyncSession) -> dict:
    """OCEL branch of POST /build.

    Assumes project-access and staging-path validation already ran in the
    ``build`` handler (the join/staging plumbing is identical to the standard
    build). Assembles the wide table, emits an OCEL 2.0 ``.jsonocel`` file, and
    persists a reloadable ``log_type='ocel'`` EventLog row whose UUID is the
    OCEL id the OCPM views open by. Mirrors the persistence shape of the
    /ocel/upload endpoint (object_types, file_path on disk, objects-as-cases)
    so ``_get_ocel_or_404`` can re-parse it after a restart.
    """
    if not body.object_type_columns:
        raise HTTPException(
            status_code=400,
            detail="object_type_columns must contain at least one column for an OCEL build",
        )

    # OCEL 2.0 JSON output so it round-trips through pm4py's readers/writers and
    # the .jsonocel extension is one _read_ocel knows how to reload.
    output_name = f"{uuid_mod.uuid4().hex}_builder_{body.name}.jsonocel"
    output_path = os.path.join(settings.UPLOAD_DIR, str(body.project_id), output_name)

    try:
        result = build_ocel(
            file_path=body.staging_path,
            object_type_columns=body.object_type_columns,
            events=[e.model_dump() for e in body.events],
            output_path=output_path,
            additional_sources=body.additional_sources,
            joins=[j.model_dump() for j in body.joins],
            # Defense-in-depth: re-validate every explicit string join
            # right_source inside the build so a path can never escape the
            # staging dir even if the API-level loop is bypassed.
            path_validator=_validate_staging_path,
        )
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("OCEL builder failed")
        raise HTTPException(status_code=500, detail=f"OCEL builder failed: {e}")

    object_types = list(result["object_types"])
    event_count = int(result["event_count"])
    object_count = int(result["object_count"])

    # Persist as a real EventLog row so the OCEL is reloadable after a restart.
    # Mirrors the OCEL branch of /ocel/upload: the row id IS the ocel_id,
    # log_type='ocel', file_path on disk, objects counted as "cases".
    event_log = EventLog(
        project_id=body.project_id,
        name=body.name,
        file_path=output_path,
        source_type=SourceType.upload,
        log_type=LogType.ocel.value,
        status=EventLogStatus.ready,
        object_types=object_types,
        total_events=event_count,
        total_cases=object_count,  # objects as "cases" for OCEL
        total_activities=len(result["activities"]),
    )
    db.add(event_log)
    await db.commit()
    await db.refresh(event_log)

    # Cache the freshly-built OCEL object so the first OCPM call hits memory
    # instead of re-parsing from disk. Keyed by the EventLog id, exactly as
    # _get_ocel_or_404 expects.
    try:
        from app.services.ocel_store import _ocel_store

        _ocel_store[str(event_log.id)] = result["ocel"]
    except Exception as e:  # caching is best-effort; disk reload still works
        logger.warning("Could not cache built OCEL %s in memory: %s", event_log.id, e)

    # Clean up staging files — not needed after build (primary + additional).
    for path in [body.staging_path, *body.additional_sources]:
        try:
            os.remove(path)
        except OSError:
            pass

    return {
        "ocel_id": str(event_log.id),
        "event_log_id": str(event_log.id),
        "object_types": object_types,
        "event_count": event_count,
        "object_count": object_count,
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
