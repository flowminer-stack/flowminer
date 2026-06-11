"""
Event log router: upload, list, preview, column mapping, and deletion.
"""

import logging
import os
import uuid as uuid_mod
from uuid import UUID

import aiofiles
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.database import get_db
from app.models import EventLog, EventLogStatus, LogType, Project, SourceType, User
from app.schemas.event_log import ColumnMappingRequest, EventLogPreview, EventLogResponse
from app.api.deps import (
    assert_project_access,
    get_accessible_event_log,
    get_current_active_user,
    get_owned_project,
)
from app.services.ingestion import IngestionService

logger = logging.getLogger(__name__)

router = APIRouter()


# ─── Upload MIME sniff ────────────────────────────────────────────────────
# We look at the first 4 KB of the upload and confirm the bytes match the
# declared extension. This is cheap (~10 µs) and prevents path-traversal-
# adjacent attacks where an .exe is uploaded as .csv and served back to
# someone who trusts the extension.


def _looks_like_declared_extension(peek: bytes, ext: str) -> bool:
    if not peek:
        return True  # empty file — trust the extension; ingestion will fail loudly later
    head = peek[:8]

    # Textual formats (CSV) — accept if the bytes are printable UTF-8/latin-1
    # with no obvious executable magic. Reject common binary magic numbers.
    binary_magic = (
        b"MZ",            # Windows PE (.exe)
        b"\x7fELF",       # ELF binary
        b"\xca\xfe\xba\xbe",  # Mach-O / Java class
        b"#!/bin",        # shebangs — conservatively reject for CSV etc.
    )
    for magic in binary_magic:
        if head.startswith(magic):
            return False

    if ext == ".csv":
        # Must decode as text; reject null bytes.
        if b"\x00" in peek:
            return False
        try:
            peek.decode("utf-8")
        except UnicodeDecodeError:
            try:
                peek.decode("latin-1")
            except UnicodeDecodeError:
                return False
        return True

    if ext == ".parquet":
        # Parquet files start with PAR1
        return head.startswith(b"PAR1")

    if ext in (".xlsx",):
        # XLSX is a ZIP; starts with PK
        return head.startswith(b"PK")

    if ext == ".xls":
        # Legacy XLS uses OLE compound document
        return head.startswith(b"\xd0\xcf\x11\xe0")

    if ext == ".xes":
        # XES is plain XML
        stripped = peek.lstrip()
        return stripped.startswith(b"<?xml") or stripped.startswith(b"<log")

    if ext in (".jsonocel", ".json"):
        stripped = peek.lstrip()
        return stripped.startswith(b"{") or stripped.startswith(b"[")

    if ext in (".xmlocel", ".xml"):
        stripped = peek.lstrip()
        return stripped.startswith(b"<?xml") or stripped.startswith(b"<")

    if ext == ".sqlite":
        return head.startswith(b"SQLite format 3")

    # Unknown extension — be permissive; the extension check already
    # rejected anything completely out of allowlist.
    return True

ingestion_service = IngestionService()


@router.post("/upload", response_model=EventLogResponse, status_code=status.HTTP_201_CREATED)
async def upload_event_log(
    project_id: UUID = Form(..., description="Project ID to associate this event log with"),
    file: UploadFile = File(..., description="Event log file (CSV, XES, Parquet, Excel)"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Upload an event log file. The file is saved to disk, a database record is
    created with status=processing, and an async Celery task is triggered to
    parse and preview the file.
    """
    # Verify the user can write to this project before doing any file I/O.
    await assert_project_access(project_id, db, current_user)

    # Validate file extension
    if file.filename is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Filename is required",
        )

    standard_extensions = {".csv", ".xes", ".parquet", ".xlsx", ".xls"}
    ocel_extensions = {".jsonocel", ".xmlocel", ".json", ".xml", ".sqlite"}
    allowed_extensions = standard_extensions | ocel_extensions
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in allowed_extensions:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file type: {ext}. Supported: {', '.join(sorted(allowed_extensions))}",
        )
    is_ocel = ext in ocel_extensions

    # MIME sniff the first 4 KB before persisting to disk so a renamed .exe
    # (or any payload that doesn't match its declared extension) is rejected
    # at the boundary. We read, validate, then re-stream to disk.
    peek = await file.read(4096)
    if not _looks_like_declared_extension(peek, ext):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded file bytes do not match the declared file type.",
        )

    # Build storage path: UPLOAD_DIR / project_id / uuid_filename
    project_dir = os.path.join(settings.UPLOAD_DIR, str(project_id))
    os.makedirs(project_dir, exist_ok=True)

    # Drop path separators / null bytes from the declared filename so it
    # can never escape the project directory or truncate the write path.
    safe_filename = os.path.basename(file.filename).replace("\x00", "")
    unique_filename = f"{uuid_mod.uuid4().hex}_{safe_filename}"
    file_path = os.path.join(project_dir, unique_filename)

    # Enforce MAX_UPLOAD_SIZE on the stream. FastAPI's UploadFile doesn't
    # expose Content-Length reliably (SpooledTemporaryFile tells you the
    # buffered bytes, not total), so we count bytes as we go and abort +
    # delete if we pass the cap. Without this the upload handler would
    # accept arbitrarily large payloads and exhaust the worker's disk.
    max_size = int(getattr(settings, "MAX_UPLOAD_SIZE", 500 * 1024 * 1024))
    total_written = 0

    async def _abort_oversize():
        try:
            await out_file.close()
        except Exception:
            pass
        try:
            os.remove(file_path)
        except OSError:
            pass
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Upload exceeds configured MAX_UPLOAD_SIZE ({max_size} bytes).",
        )

    # Write file asynchronously. The first 4 KB were already consumed by
    # the MIME sniff above, so re-emit them before continuing the stream.
    async with aiofiles.open(file_path, "wb") as out_file:
        if peek:
            await out_file.write(peek)
            total_written += len(peek)
            if total_written > max_size:
                await _abort_oversize()
        while True:
            chunk = await file.read(1024 * 1024)  # 1 MB chunks
            if not chunk:
                break
            total_written += len(chunk)
            if total_written > max_size:
                await _abort_oversize()
            await out_file.write(chunk)

    # Create database record. Store the sanitized basename so the name
    # can't carry path separators or control chars into any frontend
    # renderer that doesn't escape on display.
    event_log = EventLog(
        project_id=project_id,
        name=safe_filename,
        file_path=file_path,
        source_type=SourceType.upload,
        log_type=LogType.ocel if is_ocel else LogType.standard,
        status=EventLogStatus.processing,
    )
    db.add(event_log)
    await db.commit()
    await db.refresh(event_log)

    if is_ocel:
        # Process OCEL file inline — parse with pm4py, extract stats
        try:
            import pm4py
            from app.services.ocel_store import _read_ocel, _ocel_store

            ocel_obj = _read_ocel(file_path)
            # Cache in OCEL store so discover/flatten endpoints work
            _ocel_store[str(event_log.id)] = ocel_obj

            obj_types = list(pm4py.ocel_get_object_types(ocel_obj))
            try:
                evt_count = len(ocel_obj.get_extended_table())
            except Exception as e:
                logger.warning("Non-critical error: %s", e)
                evt_count = len(getattr(ocel_obj, 'events', []))
            try:
                obj_count = len(pm4py.ocel_objects_summary(ocel_obj))
            except Exception as e:
                logger.warning("Non-critical error: %s", e)
                obj_count = 0

            event_log.object_types = obj_types
            event_log.total_events = evt_count
            event_log.total_cases = obj_count  # objects as "cases" for OCEL
            event_log.total_activities = len(set(
                ocel_obj.get_extended_table()['ocel:activity'].tolist()
            )) if evt_count > 0 else 0
            event_log.status = EventLogStatus.ready
            await db.commit()
            await db.refresh(event_log)
        except Exception as e:
            event_log.status = EventLogStatus.error
            event_log.error_message = str(e)
            await db.commit()
            await db.refresh(event_log)
    else:
        # Standard log — trigger async processing via Celery
        try:
            from app.workers.tasks import process_uploaded_file
            process_uploaded_file.delay(str(event_log.id), file_path)
        except Exception as e:
            logger.warning("Non-critical error: %s", e)
            # If Celery is unavailable, process inline as fallback
            try:
                preview = await ingestion_service.process_upload(file_path, file.filename)
                event_log.status = EventLogStatus.ready
                event_log.total_events = preview.get("total_rows", 0)
                await db.commit()
                await db.refresh(event_log)
            except Exception as e:
                event_log.status = EventLogStatus.error
                event_log.error_message = str(e)
                await db.commit()
                await db.refresh(event_log)

    return event_log


@router.get("", response_model=list[EventLogResponse])
async def list_event_logs(
    project: Project = Depends(get_owned_project),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """List event logs for a project. Access-checked via get_owned_project."""
    query = (
        select(EventLog)
        .where(EventLog.project_id == project.id, EventLog.hidden == False)  # noqa: E712
        .order_by(EventLog.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    result = await db.execute(query)
    event_logs = result.scalars().all()
    return event_logs


@router.get("/{event_log_id}", response_model=EventLogResponse)
async def get_event_log(
    event_log: EventLog = Depends(get_accessible_event_log),
):
    """Get a single event log by ID."""
    return event_log


@router.delete("/{event_log_id}", status_code=status.HTTP_200_OK)
async def delete_event_log(
    event_log: EventLog = Depends(get_accessible_event_log),
    db: AsyncSession = Depends(get_db),
):
    """Delete an event log record and its associated file on disk."""
    event_log_id = event_log.id

    if event_log.file_path and os.path.exists(event_log.file_path):
        try:
            os.remove(event_log.file_path)
        except OSError as e:
            logger.warning("Non-critical error: %s", e)

    await db.delete(event_log)
    await db.commit()

    return {"detail": "Event log deleted", "event_log_id": str(event_log_id)}


@router.get("/{event_log_id}/preview", response_model=EventLogPreview)
async def preview_event_log(
    event_log: EventLog = Depends(get_accessible_event_log),
):
    """
    Load the event log file and return the first 100 rows along with
    column names and total row count.
    """
    if not event_log.file_path or not os.path.exists(event_log.file_path):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Event log file not found on disk",
        )

    try:
        # Use ingestion service to load raw data
        preview_data = await ingestion_service.process_upload(
            event_log.file_path, event_log.name
        )

        columns = preview_data["columns"]
        # Return up to 100 rows (process_upload returns 20, so we reload if needed)
        import pandas as pd
        df = ingestion_service._load_raw_dataframe(event_log.file_path)
        total_rows = len(df)
        sample_df = df.head(100).copy()

        # Convert timestamps to strings for JSON serialization
        for col in sample_df.columns:
            if pd.api.types.is_datetime64_any_dtype(sample_df[col]):
                sample_df[col] = sample_df[col].astype(str)

        # Replace NaN with None
        sample_df = sample_df.where(pd.notnull(sample_df), None)
        sample_rows = sample_df.to_dict(orient="records")

        return EventLogPreview(
            columns=list(df.columns),
            sample_rows=sample_rows,
            total_rows=total_rows,
        )

    except Exception as e:
        # Log the full exception server-side for debugging but don't
        # leak the message/stacktrace to the client in production
        # (pandas errors often include column values, file paths,
        # and library internals).
        logger.exception("Error loading event log file %s", event_log_id)
        if settings.ENV.lower() == "production":
            detail = "Error loading event log file"
        else:
            detail = f"Error loading event log file: {type(e).__name__}: {str(e)[:200]}"
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=detail,
        )


@router.post("/{event_log_id}/column-mapping", response_model=EventLogResponse)
async def set_column_mapping(
    body: ColumnMappingRequest,
    event_log: EventLog = Depends(get_accessible_event_log),
    db: AsyncSession = Depends(get_db),
):
    """
    Set the column mapping for an event log. This identifies which columns
    represent case ID, activity, timestamp, etc. Triggers async stats
    computation via Celery.
    """
    event_log_id = event_log.id
    if not event_log.file_path or not os.path.exists(event_log.file_path):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Event log file not found on disk",
        )

    # Update column mapping on the record
    event_log.case_id_column = body.case_id_column
    event_log.activity_column = body.activity_column
    event_log.timestamp_column = body.timestamp_column
    event_log.resource_column = body.resource_column
    event_log.cost_column = body.cost_column
    event_log.additional_columns = body.additional_columns

    await db.commit()
    await db.refresh(event_log)

    # Clear any cached mining results for this event log
    try:
        from app.api._mining_deps import _clear_cache_for_event_log
        _clear_cache_for_event_log(event_log_id)
    except ImportError:
        pass

    # Trigger async stats computation via Celery
    try:
        from app.workers.tasks import compute_event_log_stats
        compute_event_log_stats.delay(str(event_log.id))
    except Exception:
        # Fallback: compute stats inline
        try:
            mapping = {
                "case_id_column": body.case_id_column,
                "activity_column": body.activity_column,
                "timestamp_column": body.timestamp_column,
                "resource_column": body.resource_column,
                "cost_column": body.cost_column,
            }
            stats = await ingestion_service.apply_column_mapping(
                event_log.file_path, mapping
            )
            event_log.total_cases = stats["total_cases"]
            event_log.total_events = stats["total_events"]
            event_log.total_activities = stats["total_activities"]
            event_log.activities_list = stats["activities_list"]
            await db.commit()
            await db.refresh(event_log)
        except Exception as e:
            logger.warning("Non-critical error: %s", e)


# ─── Timestamp Repair ─────────────────────────────────────────────────────────


@router.get("/{event_log_id}/repair-timestamps/preview")
async def preview_timestamp_repair(
    event_log: EventLog = Depends(get_accessible_event_log),
):
    """
    Dry-run timestamp repair: detect ties, inversions, and extreme outliers
    without modifying the file. Returns counts so the user can decide whether
    to apply the fix.
    """
    if not event_log.file_path or not os.path.exists(event_log.file_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event log file not found")
    if not event_log.timestamp_column:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Timestamp column not configured")

    try:
        result = ingestion_service.repair_timestamps(
            file_path=event_log.file_path,
            case_id_col=event_log.case_id_column or "case:concept:name",
            timestamp_col=event_log.timestamp_column,
            dry_run=True,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error("Timestamp repair preview failed: %s", e, exc_info=True)
        detail = "Timestamp repair preview failed" if settings.ENV.lower() == "production" else f"{type(e).__name__}: {str(e)[:200]}"
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=detail)

    return result


@router.post("/{event_log_id}/repair-timestamps")
async def apply_timestamp_repair(
    event_log: EventLog = Depends(get_accessible_event_log),
    db: AsyncSession = Depends(get_db),
):
    """
    Apply timestamp repair in-place: fix ties (spread 1 ms apart) and
    inversions (swap). Overwrites the event log file, then clears the
    mining result cache so next discovery uses the repaired data.
    """
    if not event_log.file_path or not os.path.exists(event_log.file_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event log file not found")
    if not event_log.timestamp_column:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Timestamp column not configured")

    try:
        result = ingestion_service.repair_timestamps(
            file_path=event_log.file_path,
            case_id_col=event_log.case_id_column or "case:concept:name",
            timestamp_col=event_log.timestamp_column,
            dry_run=False,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error("Timestamp repair failed: %s", e, exc_info=True)
        detail = "Timestamp repair failed" if settings.ENV.lower() == "production" else f"{type(e).__name__}: {str(e)[:200]}"
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=detail)

    # Clear cached mining results so future requests use repaired data
    try:
        from app.api._mining_deps import _clear_cache_for_event_log
        _clear_cache_for_event_log(event_log.id)
    except Exception:
        pass

    return result


# ─── Data portability: raw download + XES export ───────────────────────────
#
# FlowMiner's anti-lock-in / sovereignty guarantee in practice: a user can
# always get their own data back out, both verbatim (the original upload) and
# in the IEEE-standard interchange format other process-mining tools ingest
# (ProM, Fluxicon Disco, Apromore, Celonis, pm4py).


def _build_xes_file(
    file_path: str,
    case_col: str,
    activity_col: str,
    timestamp_col: str,
    resource_col: str | None,
) -> str:
    """Convert a standard event-log file to IEEE XES (1849-2016) and return the
    path to a freshly-written temp .xes file.

    Blocking (pandas + pm4py) — call via ``run_in_threadpool``. The caller is
    responsible for deleting the returned temp file (we attach a BackgroundTask).
    """
    import tempfile

    import pandas as pd
    import pm4py

    df = ingestion_service._load_raw_dataframe(
        file_path, preserve_str_cols=[case_col, activity_col]
    )
    missing = [c for c in (case_col, activity_col, timestamp_col) if c not in df.columns]
    if missing:
        raise ValueError(f"Mapped columns not present in the file: {missing}")

    # XES requires a real timestamp type for time:timestamp.
    if not pd.api.types.is_datetime64_any_dtype(df[timestamp_col]):
        df = df.copy()
        df[timestamp_col] = pd.to_datetime(df[timestamp_col], errors="coerce")

    # Carry the resource through under the XES standard key so org:resource
    # survives the round-trip into other tools.
    if resource_col and resource_col in df.columns and resource_col != "org:resource":
        df = df.rename(columns={resource_col: "org:resource"})

    formatted = pm4py.format_dataframe(
        df,
        case_id=case_col,
        activity_key=activity_col,
        timestamp_key=timestamp_col,
    )

    fd, tmp_path = tempfile.mkstemp(suffix=".xes")
    os.close(fd)
    pm4py.write_xes(formatted, tmp_path)
    return tmp_path


@router.get("/{event_log_id}/download")
async def download_event_log(
    event_log: EventLog = Depends(get_accessible_event_log),
):
    """Stream the ORIGINAL uploaded event-log file back to the caller, byte for
    byte (the same CSV / XES / Parquet / OCEL the user uploaded).

    This is the primitive behind data portability and GDPR Art. 20 — a user can
    always retrieve their own data, in the exact form they provided it.
    """
    if not event_log.file_path or not os.path.exists(event_log.file_path):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Event log file not found on disk",
        )
    filename = event_log.name or os.path.basename(event_log.file_path)
    return FileResponse(
        event_log.file_path,
        filename=filename,
        media_type="application/octet-stream",
    )


@router.get("/{event_log_id}/export/xes")
async def export_event_log_xes(
    event_log: EventLog = Depends(get_accessible_event_log),
):
    """Export a standard event log as IEEE XES (1849-2016) for import into ProM,
    Fluxicon Disco, Apromore, Celonis, or pm4py.

    Requires the case / activity / timestamp column mapping to be set. OCEL logs
    are object-centric, not flat XES — download the original file via
    ``/download`` (a dedicated OCEL 2.0 export is on the roadmap).
    """
    log_type = (
        event_log.log_type.value
        if hasattr(event_log.log_type, "value")
        else str(event_log.log_type)
    )
    if log_type == "ocel":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="OCEL logs are object-centric, not flat XES. Use the raw download endpoint.",
        )
    if not event_log.file_path or not os.path.exists(event_log.file_path):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Event log file not found on disk",
        )
    if not (
        event_log.case_id_column
        and event_log.activity_column
        and event_log.timestamp_column
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="XES export needs case ID, activity, and timestamp columns mapped first.",
        )

    try:
        tmp_path = await run_in_threadpool(
            _build_xes_file,
            event_log.file_path,
            event_log.case_id_column,
            event_log.activity_column,
            event_log.timestamp_column,
            event_log.resource_column,
        )
    except Exception as e:
        logger.exception("XES export failed for %s", event_log.id)
        detail = (
            "XES export failed"
            if settings.ENV.lower() == "production"
            else f"{type(e).__name__}: {str(e)[:200]}"
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=detail,
        )

    base = os.path.splitext(event_log.name or "event-log")[0]
    return FileResponse(
        tmp_path,
        filename=f"{base}.xes",
        media_type="application/xml",
        background=BackgroundTask(os.remove, tmp_path),
    )
