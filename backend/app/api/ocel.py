"""
Object-Centric Process Mining (OCPM) router.

Provides endpoints for uploading OCEL files, converting traditional event
logs to OCEL, retrieving summaries, discovering OC-DFGs, and flattening an
OCEL back to a traditional log for standard DFG discovery.

OCEL objects are kept in a simple in-memory store keyed by a generated UUID.
"""

import json
import logging
import os
import uuid as uuid_mod
from uuid import UUID

import aiofiles
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from pydantic import BaseModel, Field
from app.models import EventLog, EventLogStatus, LogType, SourceType, User
from app.schemas.mining import DiscoveryResponse, ProcessNode, ProcessEdge
from app.schemas.ocel import (
    OCDFGEdge,
    OCDFGNode,
    OCDFGResponse,
    OCELConvertRequest,
    OCELConvertResponse,
    OCELSummary,
    OCELUploadResponse,
)
from app.api.deps import get_current_active_user
from app.services.mining_engine import mining_engine
from app.services.infra.result_cache import cache_get as _raw_cache_get, cache_set as _raw_cache_set

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Redis-backed result cache for the read-only OCEL endpoints. Every entry is
# keyed by ocel_id + endpoint kind + an optional params hash, with the
# default 12 h TTL from result_cache.py. The OCEL data is immutable for the
# lifetime of the upload, so the only thing that can stale these entries
# is a re-upload (which always uses a fresh ocel_id).
# ---------------------------------------------------------------------------


def _ocel_params_hash(params: dict | None) -> str:
    if not params:
        return "none"
    import hashlib
    serialized = json.dumps(params, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()


def _ocel_cache_get(ocel_id: str, kind: str, params: dict | None = None):
    return _raw_cache_get(ocel_id, kind, _ocel_params_hash(params))


def _ocel_cache_set(ocel_id: str, kind: str, value: dict, params: dict | None = None) -> None:
    _raw_cache_set(ocel_id, kind, value, _ocel_params_hash(params))

# ---------------------------------------------------------------------------
# In-memory OCEL store + file readers live in the services layer so they can
# be shared process-wide as a single singleton. Imported here (never
# re-instantiated) and used by the endpoints below.
# ---------------------------------------------------------------------------
from app.services.ocel_store import (
    _OCEL_EXTENSIONS,
    _BoundedOcelStore,  # noqa: F401  (kept importable for backward references)
    _get_ocel_load_lock,
    _ocel_counts,
    _ocel_load_locks,  # noqa: F401
    _ocel_load_locks_guard,  # noqa: F401
    _ocel_owners,
    _ocel_store,
    _read_ocel,
    write_ocel_to_disk,
)


def _sanitize_id(name: str) -> str:
    return str(name).replace(" ", "_").replace("/", "_").replace("\\", "_").lower()


# ---------------------------------------------------------------------------
# Endpoint 1 — POST /ocel/upload
# ---------------------------------------------------------------------------


@router.post("/upload", response_model=OCELUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_ocel(
    file: UploadFile = File(..., description="OCEL file (.jsonocel, .xmlocel, .sqlite, .json, .xml)"),
    project_id: UUID | None = Form(
        None,
        description=(
            "Project to attach the uploaded OCEL to. When supplied the OCEL is "
            "persisted as an EventLog row so it survives a worker restart; when "
            "omitted it is kept in-memory only (legacy behaviour)."
        ),
    ),
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Upload an OCEL file.  The file is saved to the upload directory, read with
    pm4py, and cached in memory.  Returns basic stats about the log.

    When ``project_id`` is supplied an ``EventLog`` row (``log_type='ocel'``)
    is created and its UUID becomes the returned ``id``. This is what makes the
    OCEL reloadable after a worker restart: ``_get_ocel_or_404`` looks the row
    up by id and re-parses ``file_path`` from disk on a cache miss. Without a
    persisted row the in-memory cache is the only copy and a restart 404s every
    subsequent OCPM call — the bug this fix closes.
    """
    if file.filename is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Filename is required",
        )

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in _OCEL_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unsupported OCEL file type: {ext}. "
                f"Supported: {', '.join(sorted(_OCEL_EXTENSIONS))}"
            ),
        )

    # If a project is named, confirm write access before any disk I/O.
    if project_id is not None:
        from app.api.deps import assert_project_access

        await assert_project_access(project_id, db, current_user)

    # Persist alongside other project files when attached to a project so the
    # reload-from-disk path lines up with the rest of the upload pipeline;
    # otherwise fall back to the shared UPLOAD_DIR/ocel staging dir.
    if project_id is not None:
        ocel_dir = os.path.join(settings.UPLOAD_DIR, str(project_id))
    else:
        ocel_dir = os.path.join(settings.UPLOAD_DIR, "ocel")
    os.makedirs(ocel_dir, exist_ok=True)
    safe_filename = os.path.basename(file.filename).replace("\x00", "")
    unique_filename = f"{uuid_mod.uuid4().hex}_{safe_filename}"
    file_path = os.path.join(ocel_dir, unique_filename)

    async with aiofiles.open(file_path, "wb") as out_file:
        while True:
            chunk = await file.read(1024 * 1024)  # 1 MB chunks
            if not chunk:
                break
            await out_file.write(chunk)

    # Parse and cache
    try:
        ocel = _read_ocel(file_path)
    except ValueError as e:
        os.unlink(file_path)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        os.unlink(file_path)
        logger.error("OCEL parse error: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Could not parse OCEL file: {e}",
        )

    import pm4py

    try:
        object_types = pm4py.ocel_get_object_types(ocel)
    except Exception:
        object_types = []

    event_count, object_count = _ocel_counts(ocel)

    if project_id is not None:
        # Persist as a real EventLog row so the OCEL is reloadable after a
        # restart. Mirrors the OCEL branch of api/event_logs.py upload: the
        # row id IS the ocel_id, log_type='ocel', file_path on disk.
        try:
            activities_count = len(set(ocel.get_extended_table()["ocel:activity"].tolist())) if event_count > 0 else 0
        except Exception:
            activities_count = 0

        event_log = EventLog(
            project_id=project_id,
            name=safe_filename,
            file_path=file_path,
            source_type=SourceType.upload,
            log_type=LogType.ocel.value,
            status=EventLogStatus.ready,
            object_types=list(object_types),
            total_events=event_count,
            total_cases=object_count,  # objects as "cases" for OCEL
            total_activities=activities_count,
        )
        db.add(event_log)
        await db.commit()
        await db.refresh(event_log)
        ocel_id = str(event_log.id)
    else:
        ocel_id = str(uuid_mod.uuid4())
        _ocel_owners[ocel_id] = current_user.id

    _ocel_store[ocel_id] = ocel

    return OCELUploadResponse(
        id=ocel_id,
        object_types=object_types,
        event_count=event_count,
        object_count=object_count,
    )


# ---------------------------------------------------------------------------
# Endpoint 2 — POST /ocel/convert/{event_log_id}
# ---------------------------------------------------------------------------


@router.post("/convert/{event_log_id}", response_model=OCELConvertResponse)
async def convert_event_log_to_ocel(
    event_log_id: UUID,
    body: OCELConvertRequest,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Convert a traditional event log to OCEL format.

    The caller specifies which columns in the log represent object types.
    The resulting OCEL is cached in memory.
    """
    result = await db.execute(select(EventLog).where(EventLog.id == event_log_id))
    event_log = result.scalar_one_or_none()
    if event_log is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event log not found")

    if not event_log.case_id_column:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Column mapping not set on this event log. "
                "Please set case_id_column, activity_column, and timestamp_column first."
            ),
        )

    if not event_log.file_path or not os.path.exists(event_log.file_path):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Event log file not found on disk",
        )

    if not body.object_type_columns:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="object_type_columns must contain at least one column name",
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
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error loading event log: {e}",
        )

    # Validate that the requested columns actually exist
    missing = [c for c in body.object_type_columns if c not in df.columns]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Columns not found in event log: {missing}",
        )

    import pm4py

    try:
        ocel = pm4py.convert_log_to_ocel(
            df,
            activity_column="concept:name",
            timestamp_column="time:timestamp",
            object_types=body.object_type_columns,
        )
    except Exception as e:
        logger.error("OCEL conversion failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"OCEL conversion failed: {e}",
        )

    try:
        object_types = pm4py.ocel_get_object_types(ocel)
    except Exception:
        object_types = list(body.object_type_columns)

    event_count, object_count = _ocel_counts(ocel)

    ocel_id = str(uuid_mod.uuid4())
    _ocel_store[ocel_id] = ocel
    _ocel_owners[ocel_id] = current_user.id

    return OCELConvertResponse(
        ocel_id=ocel_id,
        object_types=object_types,
        event_count=event_count,
        object_count=object_count,
    )


# ---------------------------------------------------------------------------
# Helper: look up an OCEL from the store or 404
# ---------------------------------------------------------------------------


def _get_ocel_or_404(ocel_id: str):
    """Get OCEL from in-memory store, or reload from disk if evicted/restart.

    Thread-safe: when concurrent requests all miss the in-memory store
    (the OCPM panel thundering herd) a per-id lock makes only the first
    thread re-parse the file; the rest wait then read the cached object.
    """
    ocel_obj = _ocel_store.get(ocel_id)
    if ocel_obj is not None:
        return ocel_obj

    lock = _get_ocel_load_lock(ocel_id)
    with lock:
        # Re-check inside the lock — another thread may have loaded it
        # while we were waiting.
        ocel_obj = _ocel_store.get(ocel_id)
        if ocel_obj is not None:
            return ocel_obj

        # Try to reload from the EventLog's file on disk
        from sqlalchemy.orm import Session as SyncSession
        from app.database import sync_engine

        try:
            with SyncSession(sync_engine) as db:
                event_log = db.query(EventLog).filter(
                    EventLog.id == UUID(ocel_id),
                    EventLog.log_type == LogType.ocel,
                ).first()

            if event_log and event_log.file_path and os.path.exists(event_log.file_path):
                ocel_obj = _read_ocel(event_log.file_path)
                _ocel_store[ocel_id] = ocel_obj
                logger.info("Reloaded OCEL %s from disk: %s", ocel_id, event_log.file_path)
                return ocel_obj
        except Exception as e:
            logger.warning("Failed to reload OCEL %s from disk: %s", ocel_id, e)

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"OCEL '{ocel_id}' not found. Upload or convert a log first.",
    )


def _assert_ocel_access_sync(ocel_id: str, user) -> None:
    """Synchronous variant for handlers that are plain ``def`` (dispatched
    to FastAPI's threadpool). Uses the sync engine so it doesn't need an
    async session."""
    from sqlalchemy.orm import Session as SyncSession
    from app.api.deps import _user_can_access_project
    from app.database import sync_engine
    from app.models import Project, UserRole

    try:
        uid = UUID(ocel_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OCEL not found")

    try:
        with SyncSession(sync_engine) as session:
            event_log = session.get(EventLog, uid)
            if event_log is not None:
                project = session.get(Project, event_log.project_id)
                if project is None or not _user_can_access_project(user, project):
                    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OCEL not found")
                return
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("OCEL access-check db lookup failed for %s: %s", ocel_id, e)

    # Synthetic conversion id
    owner_id = _ocel_owners.get(ocel_id)
    if owner_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OCEL not found")
    if user.role == UserRole.admin or owner_id == user.id:
        return
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OCEL not found")


async def _assert_ocel_access(ocel_id: str, db, user) -> None:
    """Async variant for handlers that are ``async def``. See
    ``_assert_ocel_access_sync`` for the sync mirror."""
    from sqlalchemy import select

    from app.api.deps import _user_can_access_project
    from app.models import Project, UserRole

    try:
        uid = UUID(ocel_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OCEL not found")

    result = await db.execute(select(EventLog).where(EventLog.id == uid))
    event_log = result.scalar_one_or_none()
    if event_log is not None:
        proj_result = await db.execute(select(Project).where(Project.id == event_log.project_id))
        project = proj_result.scalar_one_or_none()
        if project is None or not _user_can_access_project(user, project):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OCEL not found")
        return

    owner_id = _ocel_owners.get(ocel_id)
    if owner_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OCEL not found")
    if user.role == UserRole.admin or owner_id == user.id:
        return
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OCEL not found")


# ---------------------------------------------------------------------------
# Endpoint 3 — GET /ocel/{ocel_id}/summary
# ---------------------------------------------------------------------------


@router.get("/{ocel_id}/summary", response_model=OCELSummary)
async def get_ocel_summary(
    ocel_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """Return summary information about a cached OCEL object."""
    import pm4py

    await _assert_ocel_access(ocel_id, db, current_user)

    cached = _ocel_cache_get(ocel_id, "ocel_summary")
    if cached is not None:
        return OCELSummary(**cached)

    ocel = _get_ocel_or_404(ocel_id)

    try:
        object_types = pm4py.ocel_get_object_types(ocel)
    except Exception:
        object_types = []

    event_count, object_count = _ocel_counts(ocel)

    # Activity list from the events table
    activities: list[str] = []
    try:
        events_df = ocel.get_extended_table()
        act_col = next(
            (c for c in events_df.columns if "activity" in c.lower() or c == "ocel:activity"),
            None,
        )
        if act_col:
            activities = sorted(events_df[act_col].dropna().unique().tolist(), key=str)
        else:
            # Fall back to ocel.events if get_extended_table has no activity col
            raise AttributeError("no activity column")
    except Exception:
        try:
            act_col = next(
                (c for c in ocel.events.columns if "activity" in c.lower()),
                None,
            )
            if act_col:
                activities = sorted(ocel.events[act_col].dropna().unique().tolist(), key=str)
        except Exception:
            activities = []

    # Objects per type — use ocel.objects DataFrame which has ocel:type column
    objects_per_type: dict[str, int] = {}
    try:
        obj_df = ocel.objects
        type_col = next(
            (c for c in obj_df.columns if c.lower() in ("ocel:type", "ocel_type", "type")),
            None,
        )
        if type_col:
            counts = obj_df[type_col].value_counts().to_dict()
            for ot in object_types:
                objects_per_type[ot] = int(counts.get(ot, 0))
        else:
            for ot in object_types:
                objects_per_type[ot] = 0
    except Exception:
        for ot in object_types:
            objects_per_type[ot] = 0

    response = OCELSummary(
        ocel_id=ocel_id,
        object_types=object_types,
        event_count=event_count,
        object_count=object_count,
        activities=[str(a) for a in activities],
        objects_per_type=objects_per_type,
    )
    _ocel_cache_set(ocel_id, "ocel_summary", response.model_dump())
    return response


# ---------------------------------------------------------------------------
# Endpoint 4 — GET /ocel/{ocel_id}/discover
# ---------------------------------------------------------------------------


@router.get("/{ocel_id}/discover", response_model=OCDFGResponse)
async def discover_ocdfg(
    ocel_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Discover an Object-Centric Directly-Follows Graph (OC-DFG) from the OCEL.

    Nodes are activities; edges include an object_type field so the frontend
    can color-code flows by object type.
    """
    import pm4py

    await _assert_ocel_access(ocel_id, db, current_user)

    cached = _ocel_cache_get(ocel_id, "oc_dfg")
    if cached is not None:
        return OCDFGResponse(**cached)

    ocel = _get_ocel_or_404(ocel_id)

    try:
        object_types = pm4py.ocel_get_object_types(ocel)
    except Exception:
        object_types = []

    try:
        ocdfg = pm4py.discover_ocdfg(ocel)
    except Exception as e:
        logger.error("OC-DFG discovery failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"OC-DFG discovery failed: {e}",
        )

    # ------------------------------------------------------------------
    # The pm4py OC-DFG result is a dict with this rough structure:
    #
    #   {
    #     "activities":      { activity_name: { "count": int, ... }, ... },
    #     "activities_ot":   { object_type: { activity_name: int, ... }, ... },
    #     "start_activities":{ object_type: { activity_name: int } },
    #     "end_activities":  { object_type: { activity_name: int } },
    #     "edges":           { object_type: { (act_a, act_b): int, ... }, ... },
    #     ...
    #   }
    #
    # Keys vary across pm4py minor versions, so we inspect defensively.
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # pm4py discover_ocdfg returns:
    #   "activities": set of activity names
    #   "activities_indep": {"events": {act: set_of_event_ids}}
    #   "activities_ot": {ot: {act: set_of_event_ids}}
    #   "edges": {ot: {(act_a, act_b): {set_of_event_ids}}}
    # Frequencies = len(set_of_event_ids)
    # ------------------------------------------------------------------

    # Activity names
    all_activities: set[str] = set()
    raw_acts = ocdfg.get("activities") or set()
    if isinstance(raw_acts, set):
        all_activities = {str(a) for a in raw_acts}
    elif isinstance(raw_acts, dict):
        all_activities = {str(a) for a in raw_acts.keys()}

    # Activity frequencies from activities_indep
    act_freq_global: dict[str, int] = {}
    acts_indep = ocdfg.get("activities_indep") or {}
    if isinstance(acts_indep, dict):
        events_dict = acts_indep.get("events") or acts_indep
        if isinstance(events_dict, dict):
            for act, val in events_dict.items():
                if isinstance(val, set):
                    act_freq_global[str(act)] = len(val)
                elif isinstance(val, (int, float)):
                    act_freq_global[str(act)] = int(val)
                all_activities.add(str(act))

    # Edges per object type
    # pm4py OC-DFG edges structure: {"event_couples": {ot: {(a,b): set}}, "unique_objects": {ot: {(a,b): set}}}
    # We use "unique_objects" for cleaner counts (unique object transitions)
    edges_by_type: dict[str, dict[tuple[str, str], int]] = {}
    raw_edges = ocdfg.get("edges") or {}

    # Try "unique_objects" first, fall back to "event_couples", then raw
    edge_source = raw_edges.get("unique_objects") or raw_edges.get("event_couples") or raw_edges
    if isinstance(edge_source, dict):
        for ot, edge_dict in edge_source.items():
            # Skip non-object-type keys
            if ot in ("event_couples", "unique_objects"):
                continue
            ot_str = str(ot)
            edges_by_type[ot_str] = {}
            if isinstance(edge_dict, dict):
                for edge_key, val in edge_dict.items():
                    if isinstance(edge_key, tuple) and len(edge_key) == 2:
                        src, tgt = str(edge_key[0]), str(edge_key[1])
                    elif isinstance(edge_key, str) and "@@" in edge_key:
                        parts = edge_key.split("@@", 1)
                        src, tgt = parts[0], parts[1]
                    else:
                        continue
                    all_activities.add(src)
                    all_activities.add(tgt)
                    if isinstance(val, set):
                        freq = len(val)
                    elif isinstance(val, dict):
                        freq = int(val.get("count", 0))
                    else:
                        try:
                            freq = int(val)
                        except (TypeError, ValueError):
                            freq = 0
                    edges_by_type[ot_str][(src, tgt)] = freq

    # ------------------------------------------------------------------
    # ONE node per activity, edges carry object_type for color-coding
    # ------------------------------------------------------------------
    nodes: list[OCDFGNode] = []
    node_ids_seen: set[str] = set()

    for act in sorted(all_activities):
        node_id = _sanitize_id(act)
        node_ids_seen.add(node_id)
        nodes.append(
            OCDFGNode(
                id=node_id,
                label=str(act),
                object_type="",
                frequency=act_freq_global.get(str(act), 0),
            )
        )

    edges: list[OCDFGEdge] = []
    for ot, edge_dict in edges_by_type.items():
        for (src_act, tgt_act), freq in edge_dict.items():
            src_id = _sanitize_id(src_act)
            tgt_id = _sanitize_id(tgt_act)
            if src_id in node_ids_seen and tgt_id in node_ids_seen:
                edges.append(
                    OCDFGEdge(source=src_id, target=tgt_id, object_type=ot, frequency=freq)
                )

    response = OCDFGResponse(
        ocel_id=ocel_id,
        nodes=nodes,
        edges=edges,
        object_types=object_types,
    )
    _ocel_cache_set(ocel_id, "oc_dfg", response.model_dump())
    return response


# ---------------------------------------------------------------------------
# Endpoint 5 — GET /ocel/{ocel_id}/flatten/{object_type}
# ---------------------------------------------------------------------------


class FlattenResponse(BaseModel):
    event_log_id: str
    object_type: str
    total_cases: int
    total_events: int
    total_activities: int


# ---------------------------------------------------------------------------
# Response schemas for native OCEL analysis endpoints
# ---------------------------------------------------------------------------


class ObjectInteraction(BaseModel):
    type_a: str
    type_b: str
    interaction_count: int


class ObjectInteractionsResponse(BaseModel):
    interactions: list[ObjectInteraction]
    total_interactions: int


class ObjectLifecycle(BaseModel):
    object_type: str
    object_count: int
    avg_lifecycle_duration: float | None  # seconds
    avg_events_per_object: float
    activities: list[str]


class ObjectLifecycleResponse(BaseModel):
    lifecycles: list[ObjectLifecycle]


class ActivityObjectType(BaseModel):
    activity: str
    object_types: dict[str, int]  # {type_name: avg_object_count rounded}
    total_events: int


class ActivityObjectTypesResponse(BaseModel):
    activities: list[ActivityObjectType]


# ---------------------------------------------------------------------------
# Endpoint 6 — GET /ocel/{ocel_id}/object-interactions
# ---------------------------------------------------------------------------


@router.get("/{ocel_id}/object-interactions", response_model=ObjectInteractionsResponse)
async def get_object_interactions(
    ocel_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Return which object type pairs interact and how often they co-occur across
    events.  Uses pm4py.ocel_objects_interactions_summary.
    """
    import pm4py

    await _assert_ocel_access(ocel_id, db, current_user)

    cached = _ocel_cache_get(ocel_id, "object_interactions")
    if cached is not None:
        return ObjectInteractionsResponse(**cached)

    ocel = _get_ocel_or_404(ocel_id)

    try:
        interactions_df = pm4py.ocel_objects_interactions_summary(ocel)
    except Exception as e:
        logger.error("ocel_objects_interactions_summary failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Could not compute object interactions: {e}",
        )

    interactions: list[ObjectInteraction] = []
    total = 0

    if interactions_df is not None and not interactions_df.empty:
        # Column names differ by pm4py version; try canonical names first
        type_col_a = next(
            (c for c in interactions_df.columns if c in ("ocel:type", "ocel:type_1", "type_1")),
            None,
        )
        type_col_b = next(
            (c for c in interactions_df.columns if c in ("ocel:type_2", "type_2")),
            None,
        )

        if type_col_a and type_col_b:
            grouped = (
                interactions_df.groupby([type_col_a, type_col_b])
                .size()
                .reset_index(name="count")
            )
            for _, row in grouped.iterrows():
                cnt = int(row["count"])
                total += cnt
                interactions.append(
                    ObjectInteraction(
                        type_a=str(row[type_col_a]),
                        type_b=str(row[type_col_b]),
                        interaction_count=cnt,
                    )
                )

    response = ObjectInteractionsResponse(
        interactions=interactions,
        total_interactions=total,
    )
    _ocel_cache_set(ocel_id, "object_interactions", response.model_dump())
    return response


# ---------------------------------------------------------------------------
# Endpoint 7 — GET /ocel/{ocel_id}/object-lifecycle
# ---------------------------------------------------------------------------


@router.get("/{ocel_id}/object-lifecycle", response_model=ObjectLifecycleResponse)
async def get_object_lifecycle(
    ocel_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Return per-object-type lifecycle statistics: object count, average
    lifecycle duration, average events per object, and associated activities.
    """
    import pm4py

    await _assert_ocel_access(ocel_id, db, current_user)

    cached = _ocel_cache_get(ocel_id, "object_lifecycle")
    if cached is not None:
        return ObjectLifecycleResponse(**cached)

    ocel = _get_ocel_or_404(ocel_id)

    try:
        object_types = pm4py.ocel_get_object_types(ocel)
    except Exception:
        object_types = []

    # Objects summary: index = ocel:oid, columns include lifecycle_duration
    try:
        objects_summary = pm4py.ocel_objects_summary(ocel)
    except Exception as e:
        logger.warning("ocel_objects_summary failed: %s", e)
        objects_summary = None

    # Activities per object type
    try:
        ot_activities: dict = pm4py.ocel_object_type_activities(ocel)
    except Exception:
        ot_activities = {}

    # Map ocel:oid -> ocel:type from ocel.objects DataFrame
    oid_to_type: dict[str, str] = {}
    try:
        obj_df = ocel.objects
        type_col = next(
            (c for c in obj_df.columns if c.lower() in ("ocel:type", "ocel_type", "type")),
            None,
        )
        oid_col = next(
            (c for c in obj_df.columns if c.lower() in ("ocel:oid", "ocel_oid", "oid")),
            None,
        )
        if type_col and oid_col:
            for _, row in obj_df.iterrows():
                oid_to_type[str(row[oid_col])] = str(row[type_col])
    except Exception as e:
        logger.warning("OCEL object lifecycle: oid→type index build failed: %s", e)

    # Count events per object using the relations table (ocel:oid, ocel:type)
    events_per_object: dict[str, int] = {}
    try:
        relations = ocel.relations
        if 'ocel:oid' in relations.columns:
            events_per_object = relations.groupby('ocel:oid').size().to_dict()
    except Exception as e:
        logger.warning("OCEL object lifecycle: events-per-object count failed: %s", e)

    lifecycles: list[ObjectLifecycle] = []

    for ot in object_types:
        oids_of_type = {oid for oid, t in oid_to_type.items() if t == ot}
        obj_count = len(oids_of_type)

        # Lifecycle duration from objects_summary
        avg_duration: float | None = None
        if objects_summary is not None and not objects_summary.empty:
            oid_col_sum = next(
                (c for c in objects_summary.columns if c.lower() in ("ocel:oid", "oid")),
                None,
            )
            if oid_col_sum:
                subset = objects_summary[objects_summary[oid_col_sum].isin(oids_of_type)]
            else:
                subset = objects_summary

            if not subset.empty:
                dur_col = next(
                    (c for c in subset.columns if "duration" in c.lower()),
                    None,
                )
                if dur_col:
                    try:
                        vals = subset[dur_col].dropna()
                        if len(vals) > 0:
                            if hasattr(vals.iloc[0], "total_seconds"):
                                vals = vals.apply(lambda td: td.total_seconds())
                            avg_duration = float(vals.mean())
                    except Exception as e:
                        logger.warning(
                            "OCEL object lifecycle: avg duration compute failed for %s: %s",
                            ot,
                            e,
                        )

        # Events per object from relations
        type_event_counts = [events_per_object.get(oid, 0) for oid in oids_of_type]
        avg_events = float(sum(type_event_counts) / len(type_event_counts)) if type_event_counts else 0.0

        activities = sorted(
            [str(a) for a in ot_activities.get(ot, set())],
            key=str,
        )

        lifecycles.append(
            ObjectLifecycle(
                object_type=ot,
                object_count=obj_count,
                avg_lifecycle_duration=avg_duration,
                avg_events_per_object=round(avg_events, 1),
                activities=activities,
            )
        )

    response = ObjectLifecycleResponse(lifecycles=lifecycles)
    _ocel_cache_set(ocel_id, "object_lifecycle", response.model_dump())
    return response


# ---------------------------------------------------------------------------
# Endpoint 8 — GET /ocel/{ocel_id}/activity-object-types
# ---------------------------------------------------------------------------


@router.get("/{ocel_id}/activity-object-types", response_model=ActivityObjectTypesResponse)
async def get_activity_object_types(
    ocel_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Return per-activity statistics: how many objects of each type are involved
    on average per event execution.  Uses ocel_objects_ot_count.
    """
    import pm4py

    await _assert_ocel_access(ocel_id, db, current_user)

    cached = _ocel_cache_get(ocel_id, "activity_object_types")
    if cached is not None:
        return ActivityObjectTypesResponse(**cached)

    ocel = _get_ocel_or_404(ocel_id)

    try:
        ot_count: dict = pm4py.ocel_objects_ot_count(ocel)
        # ot_count: event_id -> {object_type: count}
    except Exception as e:
        logger.error("ocel_objects_ot_count failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Could not compute activity-object-type counts: {e}",
        )

    # We also need event_id -> activity mapping
    activity_col: str | None = None
    event_id_col: str | None = None
    events_df = None

    try:
        events_df = ocel.events
        activity_col = next(
            (c for c in events_df.columns if c.lower() in ("ocel:activity", "concept:name", "activity")),
            None,
        )
        event_id_col = next(
            (c for c in events_df.columns if c.lower() in ("ocel:eid", "ocel_eid", "eid")),
            None,
        )
    except Exception as e:
        logger.warning("OCEL activity-object-types: events-df column probe failed: %s", e)

    # Build event_id -> activity map
    eid_to_activity: dict[str, str] = {}
    if events_df is not None and activity_col and event_id_col:
        for _, row in events_df.iterrows():
            eid_to_activity[str(row[event_id_col])] = str(row[activity_col])

    # Accumulate sums and counts per (activity, object_type)
    # Structure: activity -> object_type -> list[count]
    import collections

    act_ot_counts: dict[str, dict[str, list[int]]] = collections.defaultdict(
        lambda: collections.defaultdict(list)
    )
    act_event_counts: dict[str, int] = collections.Counter()

    for eid, ot_counts in ot_count.items():
        activity = eid_to_activity.get(str(eid), str(eid))
        act_event_counts[activity] += 1
        for ot, cnt in ot_counts.items():
            act_ot_counts[activity][str(ot)].append(int(cnt))

    activities: list[ActivityObjectType] = []
    for activity in sorted(act_ot_counts.keys()):
        ot_avgs: dict[str, int] = {}
        for ot, counts in act_ot_counts[activity].items():
            ot_avgs[ot] = round(sum(counts) / len(counts)) if counts else 0
        activities.append(
            ActivityObjectType(
                activity=activity,
                object_types=ot_avgs,
                total_events=act_event_counts[activity],
            )
        )

    response = ActivityObjectTypesResponse(activities=activities)
    _ocel_cache_set(ocel_id, "activity_object_types", response.model_dump())
    return response


# ---------------------------------------------------------------------------
# Response schemas for new OCEL-native analysis endpoints (9–13)
# ---------------------------------------------------------------------------


class OCPetriNetObjectType(BaseModel):
    object_type: str
    activity_count: int
    place_count: int
    arc_count: int
    activities: list[str]


class OCPetriNetResponse(BaseModel):
    object_types: list[OCPetriNetObjectType]
    total_object_types: int


class ObjectsGraphEdge(BaseModel):
    source_obj: str
    target_obj: str
    count: int = 1


class ObjectsGraphResponse(BaseModel):
    edges: list[ObjectsGraphEdge]
    total_edges: int
    graph_type: str


class OCELFeaturesResponse(BaseModel):
    columns: list[str]
    rows: list[dict]
    total_objects: int
    object_type: str


class TemporalHourBucket(BaseModel):
    hour: int
    count: int


class TemporalDayBucket(BaseModel):
    date: str
    count: int


class ActivityTimeline(BaseModel):
    activity: str
    first_seen: str
    last_seen: str
    event_count: int


class OCELTemporalResponse(BaseModel):
    events_by_hour: list[TemporalHourBucket]
    events_by_day: list[TemporalDayBucket]
    activity_timeline: list[ActivityTimeline]


class ComponentSizeBucket(BaseModel):
    size: int
    count: int


class ConnectedComponentsResponse(BaseModel):
    total_components: int
    size_distribution: list[ComponentSizeBucket]
    largest_component_size: int
    avg_component_size: float


# ---------------------------------------------------------------------------
# Endpoint 9 — GET /ocel/{ocel_id}/oc-petri-net
# ---------------------------------------------------------------------------


@router.get("/{ocel_id}/oc-petri-net", response_model=OCPetriNetResponse)
async def get_oc_petri_net(
    ocel_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Discover an Object-Centric Petri Net (OC-PN) and return structural info
    (activity, place and arc counts) per object type.
    """
    import pm4py

    await _assert_ocel_access(ocel_id, db, current_user)

    cached = _ocel_cache_get(ocel_id, "oc_petri_net")
    if cached is not None:
        return OCPetriNetResponse(**cached)

    ocel = _get_ocel_or_404(ocel_id)

    try:
        result = pm4py.discover_oc_petri_net(ocel)
    except Exception as e:
        logger.error("discover_oc_petri_net failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"OC Petri Net discovery failed: {e}",
        )

    # result is a dict with key 'petri_nets': {object_type: (PetriNet, InitMarking, FinalMarking)}
    petri_nets = result.get('petri_nets', result)  # fallback to result itself if no petri_nets key
    ot_items: list[OCPetriNetObjectType] = []
    for ot, net_tuple in petri_nets.items():
        # Skip non-net keys
        if not isinstance(net_tuple, (tuple, list)) and not hasattr(net_tuple, 'transitions'):
            continue
        try:
            net = net_tuple[0] if isinstance(net_tuple, (tuple, list)) else net_tuple
            places = list(net.places) if hasattr(net, "places") else []
            transitions = list(net.transitions) if hasattr(net, "transitions") else []
            arcs = list(net.arcs) if hasattr(net, "arcs") else []
            activities = sorted(
                [str(t.label) for t in transitions if hasattr(t, "label") and t.label is not None],
                key=str,
            )
            ot_items.append(
                OCPetriNetObjectType(
                    object_type=str(ot),
                    activity_count=len(activities),
                    place_count=len(places),
                    arc_count=len(arcs),
                    activities=activities,
                )
            )
        except Exception as parse_err:
            logger.warning("Could not parse net for object type %s: %s", ot, parse_err)
            ot_items.append(
                OCPetriNetObjectType(
                    object_type=str(ot),
                    activity_count=0,
                    place_count=0,
                    arc_count=0,
                    activities=[],
                )
            )

    response = OCPetriNetResponse(object_types=ot_items, total_object_types=len(ot_items))
    _ocel_cache_set(ocel_id, "oc_petri_net", response.model_dump())
    return response


# ---------------------------------------------------------------------------
# Endpoint 10 — GET /ocel/{ocel_id}/objects-graph
# ---------------------------------------------------------------------------

_VALID_GRAPH_TYPES = {
    "object_interaction",
    "object_descendants",
    "object_inheritance",
    "object_cobirth",
    "object_codeath",
}


@router.get("/{ocel_id}/objects-graph", response_model=ObjectsGraphResponse)
async def get_objects_graph(
    ocel_id: str,
    graph_type: str = "object_interaction",
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Discover an object-level graph.  Supports graph_type values:
    object_interaction (default), object_descendants, object_inheritance,
    object_cobirth, object_codeath.  Returns up to 1000 edges.
    """
    import pm4py

    if graph_type not in _VALID_GRAPH_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid graph_type '{graph_type}'. Valid: {sorted(_VALID_GRAPH_TYPES)}",
        )

    await _assert_ocel_access(ocel_id, db, current_user)

    cache_params = {"graph_type": graph_type}
    cached = _ocel_cache_get(ocel_id, "objects_graph", cache_params)
    if cached is not None:
        return ObjectsGraphResponse(**cached)

    ocel = _get_ocel_or_404(ocel_id)

    try:
        graph = pm4py.discover_objects_graph(ocel, graph_type=graph_type)
    except Exception as e:
        logger.error("discover_objects_graph failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Objects graph discovery failed: {e}",
        )

    # graph is a set of (source_obj, target_obj) tuples or a networkx graph
    all_edges: list[tuple[str, str]] = []
    try:
        if hasattr(graph, "edges"):
            # networkx-style
            for u, v in graph.edges():
                all_edges.append((str(u), str(v)))
        else:
            # set of tuples
            for edge in graph:
                if isinstance(edge, (tuple, list)) and len(edge) >= 2:
                    all_edges.append((str(edge[0]), str(edge[1])))
    except Exception as parse_err:
        logger.warning("Could not parse objects graph edges: %s", parse_err)

    total = len(all_edges)

    # Aggregate by object type pair using oid→type mapping
    oid_to_type: dict[str, str] = {}
    try:
        obj_df = ocel.objects
        type_col = next((c for c in obj_df.columns if c.lower() in ("ocel:type", "type")), None)
        oid_col = next((c for c in obj_df.columns if c.lower() in ("ocel:oid", "oid")), None)
        if type_col and oid_col:
            for _, row in obj_df.iterrows():
                oid_to_type[str(row[oid_col])] = str(row[type_col])
    except Exception as e:
        logger.warning("OCEL objects graph: oid→type index build failed: %s", e)

    from collections import Counter as _Counter
    type_pair_counts: _Counter = _Counter()
    for src, tgt in all_edges:
        src_type = oid_to_type.get(src, "Unknown")
        tgt_type = oid_to_type.get(tgt, "Unknown")
        pair = tuple(sorted([src_type, tgt_type]))
        type_pair_counts[pair] += 1

    # Build aggregated edges (type-to-type with counts)
    agg_edges = [
        ObjectsGraphEdge(source_obj=pair[0], target_obj=pair[1], count=count)
        for pair, count in type_pair_counts.most_common()
    ]

    response = ObjectsGraphResponse(
        edges=agg_edges,
        total_edges=total,
        graph_type=graph_type,
    )
    _ocel_cache_set(ocel_id, "objects_graph", response.model_dump(), cache_params)
    return response


# ---------------------------------------------------------------------------
# Endpoint 11 — GET /ocel/{ocel_id}/features/{object_type}
# ---------------------------------------------------------------------------


@router.get("/{ocel_id}/features/{object_type}", response_model=OCELFeaturesResponse)
async def get_ocel_features(
    ocel_id: str,
    object_type: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Extract per-object features for a given object type.
    Returns up to 100 rows as a feature preview.
    """
    import pm4py

    await _assert_ocel_access(ocel_id, db, current_user)

    cache_params = {"object_type": object_type}
    cached = _ocel_cache_get(ocel_id, "ocel_features", cache_params)
    if cached is not None:
        return OCELFeaturesResponse(**cached)

    ocel = _get_ocel_or_404(ocel_id)

    try:
        features_df = pm4py.extract_ocel_features(ocel, obj_type=object_type)
    except TypeError:
        # Some pm4py versions use positional arg
        try:
            features_df = pm4py.extract_ocel_features(ocel, object_type)
        except Exception as e2:
            logger.error("extract_ocel_features fallback failed: %s", e2, exc_info=True)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Feature extraction failed: {e2}",
            )
    except Exception as e:
        logger.error("extract_ocel_features failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Feature extraction failed: {e}",
        )

    if features_df is None or features_df.empty:
        empty = OCELFeaturesResponse(
            columns=[],
            rows=[],
            total_objects=0,
            object_type=object_type,
        )
        _ocel_cache_set(ocel_id, "ocel_features", empty.model_dump(), cache_params)
        return empty

    total = len(features_df)
    preview = features_df.head(100)
    columns = [str(c) for c in preview.columns.tolist()]

    rows: list[dict] = []
    for _, row in preview.iterrows():
        row_dict: dict = {}
        for col in columns:
            val = row[col]
            try:
                if hasattr(val, "item"):
                    val = val.item()
                row_dict[col] = round(float(val), 4) if isinstance(val, float) else val
            except Exception:
                row_dict[col] = str(val)
        rows.append(row_dict)

    response = OCELFeaturesResponse(
        columns=columns,
        rows=rows,
        total_objects=total,
        object_type=object_type,
    )
    _ocel_cache_set(ocel_id, "ocel_features", response.model_dump(), cache_params)
    return response


# ---------------------------------------------------------------------------
# Endpoint 12 — GET /ocel/{ocel_id}/temporal-summary
# ---------------------------------------------------------------------------


@router.get("/{ocel_id}/temporal-summary", response_model=OCELTemporalResponse)
async def get_temporal_summary(
    ocel_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Compute a temporal summary of the OCEL: events by hour of day, events by
    calendar date, and per-activity first/last seen + event count.
    """
    import pm4py
    from collections import Counter, defaultdict

    await _assert_ocel_access(ocel_id, db, current_user)

    cached = _ocel_cache_get(ocel_id, "temporal_summary")
    if cached is not None:
        return OCELTemporalResponse(**cached)

    ocel = _get_ocel_or_404(ocel_id)

    try:
        temporal = pm4py.ocel_temporal_summary(ocel)
    except Exception as e:
        logger.error("ocel_temporal_summary failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Temporal summary failed: {e}",
        )

    if temporal is None or temporal.empty:
        empty = OCELTemporalResponse(
            events_by_hour=[],
            events_by_day=[],
            activity_timeline=[],
        )
        _ocel_cache_set(ocel_id, "temporal_summary", empty.model_dump())
        return empty

    # Find timestamp and activity columns
    ts_col = next(
        (c for c in temporal.columns if "time" in c.lower() or "timestamp" in c.lower()),
        None,
    )
    act_col = next(
        (c for c in temporal.columns if "activity" in c.lower() or c == "ocel:activity"),
        None,
    )

    if ts_col is None:
        empty = OCELTemporalResponse(
            events_by_hour=[],
            events_by_day=[],
            activity_timeline=[],
        )
        _ocel_cache_set(ocel_id, "temporal_summary", empty.model_dump())
        return empty

    import pandas as pd

    temporal[ts_col] = pd.to_datetime(temporal[ts_col], errors="coerce", utc=True)
    temporal = temporal.dropna(subset=[ts_col])

    # Events by hour
    hour_counter: Counter = Counter()
    for ts in temporal[ts_col]:
        hour_counter[ts.hour] += 1

    events_by_hour = [
        TemporalHourBucket(hour=h, count=hour_counter.get(h, 0))
        for h in range(24)
    ]

    # Events by day
    day_counter: Counter = Counter()
    for ts in temporal[ts_col]:
        day_counter[ts.date().isoformat()] += 1

    events_by_day = [
        TemporalDayBucket(date=d, count=c)
        for d, c in sorted(day_counter.items())
    ]

    # Activity timeline
    activity_timeline: list[ActivityTimeline] = []
    if act_col:
        act_first: dict[str, object] = {}
        act_last: dict[str, object] = {}
        act_count: Counter = Counter()
        for _, row in temporal.iterrows():
            raw_act = row[act_col]
            ts = row[ts_col]
            # OCEL activity column may contain a list of activities per event
            if isinstance(raw_act, (list, set, tuple)):
                activities = [str(a) for a in raw_act]
            elif isinstance(raw_act, str) and raw_act.startswith('['):
                # String repr of list — shouldn't happen but guard against it
                activities = [raw_act]
            else:
                activities = [str(raw_act)]
            for act in activities:
                act_count[act] += 1
                if act not in act_first or ts < act_first[act]:
                    act_first[act] = ts
                if act not in act_last or ts > act_last[act]:
                    act_last[act] = ts

        for act in sorted(act_count.keys()):
            first = act_first.get(act)
            last = act_last.get(act)
            activity_timeline.append(
                ActivityTimeline(
                    activity=act,
                    first_seen=first.isoformat() if hasattr(first, "isoformat") else str(first),
                    last_seen=last.isoformat() if hasattr(last, "isoformat") else str(last),
                    event_count=act_count[act],
                )
            )

    response = OCELTemporalResponse(
        events_by_hour=events_by_hour,
        events_by_day=events_by_day,
        activity_timeline=activity_timeline,
    )
    _ocel_cache_set(ocel_id, "temporal_summary", response.model_dump())
    return response


# ---------------------------------------------------------------------------
# Endpoint 13 — GET /ocel/{ocel_id}/connected-components
# ---------------------------------------------------------------------------


# Process-local hint cache (cleared on restart). The authoritative cache is
# the Redis layer below — this dict just shaves a few ms off in-process hits.
_cc_cache: dict[str, dict] = {}


def _build_ocel_graph(ocel):
    """Build a bipartite event↔object graph from an OCEL, robust to pm4py version.

    Tries ``pm4py.convert_ocel_to_networkx`` first, and falls back to building
    the graph manually from the ``ocel.relations`` dataframe if that helper is
    missing or fails. Returns a ``networkx.Graph`` (undirected — connectivity
    is the same as weakly-connected on the directed version).
    """
    import networkx as nx

    # Prefer pm4py helper if available
    try:
        import pm4py
        helper = getattr(pm4py, "convert_ocel_to_networkx", None)
        if helper is not None:
            G = helper(ocel)
            # pm4py may return a DiGraph; we only need connectivity
            if G.is_directed():
                return G.to_undirected(as_view=False)
            return G
    except Exception as e:
        logger.warning("pm4py.convert_ocel_to_networkx unavailable or failed: %s", e)

    # Fallback: build from ocel.relations (event ↔ object) manually
    G = nx.Graph()
    try:
        relations = ocel.relations
    except AttributeError:
        relations = None

    if relations is not None and len(relations) > 0:
        cols = list(relations.columns)
        # Find the event-id and object-id columns (naming varies by pm4py version)
        eid_col = next((c for c in cols if "eid" in c.lower()), None)
        oid_col = next((c for c in cols if "oid" in c.lower()), None)
        if eid_col and oid_col:
            for eid, oid in zip(relations[eid_col].tolist(), relations[oid_col].tolist()):
                G.add_edge(f"e::{eid}", f"o::{oid}")

    # Also add any objects that have no relations as isolated nodes, so the
    # component count reflects truly disconnected objects.
    try:
        objects = ocel.objects
        oid_col = next((c for c in objects.columns if "oid" in c.lower()), None)
        if oid_col:
            for oid in objects[oid_col].tolist():
                node = f"o::{oid}"
                if not G.has_node(node):
                    G.add_node(node)
    except Exception as e:
        logger.warning("OCEL connected components: isolated-object node add failed: %s", e)

    return G


def _compute_connected_components(ocel) -> dict:
    """Synchronous computation — runs in FastAPI's threadpool when the
    endpoint is a plain ``def``. Returns the ConnectedComponentsResponse dict."""
    from collections import Counter
    import networkx as nx

    G = _build_ocel_graph(ocel)

    if G.number_of_nodes() == 0:
        return {
            "total_components": 0,
            "size_distribution": [],
            "largest_component_size": 0,
            "avg_component_size": 0.0,
        }

    if G.is_directed():
        components = list(nx.weakly_connected_components(G))
    else:
        components = list(nx.connected_components(G))

    sizes = [len(c) for c in components]
    size_dist = Counter(sizes)
    largest = max(sizes, default=0)
    avg = float(sum(sizes) / len(sizes)) if sizes else 0.0

    return {
        "total_components": len(components),
        "size_distribution": [
            {"size": sz, "count": cnt} for sz, cnt in sorted(size_dist.items())
        ],
        "largest_component_size": largest,
        "avg_component_size": round(avg, 2),
    }


@router.get("/{ocel_id}/connected-components", response_model=ConnectedComponentsResponse)
def get_connected_components(
    ocel_id: str,
    current_user: User = Depends(get_current_active_user),
):
    """
    Compute weakly-connected components of the OCEL event↔object graph.

    Declared as a plain ``def`` so FastAPI dispatches it to the threadpool —
    this avoids blocking the event loop on large OCELs, which was the cause
    of upstream 503s when the uvicorn worker became unresponsive.
    """
    # Sync handler (dispatched to FastAPI threadpool) — use sync auth helper.
    _assert_ocel_access_sync(ocel_id, current_user)

    cached = _cc_cache.get(ocel_id) or _ocel_cache_get(ocel_id, "connected_components")
    if cached is not None:
        return ConnectedComponentsResponse(
            total_components=cached["total_components"],
            size_distribution=[ComponentSizeBucket(**b) for b in cached["size_distribution"]],
            largest_component_size=cached["largest_component_size"],
            avg_component_size=cached["avg_component_size"],
        )

    ocel = _get_ocel_or_404(ocel_id)

    try:
        result = _compute_connected_components(ocel)
    except Exception as e:
        logger.error("Connected components computation failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Connected components computation failed: {e}",
        )

    _cc_cache[ocel_id] = result
    _ocel_cache_set(ocel_id, "connected_components", result)
    return ConnectedComponentsResponse(
        total_components=result["total_components"],
        size_distribution=[ComponentSizeBucket(**b) for b in result["size_distribution"]],
        largest_component_size=result["largest_component_size"],
        avg_component_size=result["avg_component_size"],
    )


@router.post("/{ocel_id}/flatten/{object_type}", response_model=FlattenResponse)
async def flatten_ocel(
    ocel_id: str,
    object_type: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Flatten the OCEL to a traditional event log for a single object type.
    Creates a real EventLog record in the database with the flattened CSV
    saved to disk, so all standard analysis endpoints work with it.
    """
    import pm4py

    await _assert_ocel_access(ocel_id, db, current_user)
    ocel_obj = _get_ocel_or_404(ocel_id)

    try:
        available_types = pm4py.ocel_get_object_types(ocel_obj)
    except Exception:
        available_types = []

    if available_types and object_type not in available_types:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Object type '{object_type}' not found. Available: {available_types}",
        )

    try:
        flat_df = pm4py.ocel_flattening(ocel_obj, object_type)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"OCEL flattening failed: {e}",
        )

    if flat_df is None or flat_df.empty:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Flattened log for '{object_type}' is empty.",
        )

    # Find the parent event log to get the project_id
    parent_log = None
    try:
        result = await db.execute(select(EventLog).where(EventLog.id == UUID(ocel_id)))
        parent_log = result.scalar_one_or_none()
    except Exception as e:
        logger.warning("OCEL flatten: parent event-log lookup failed for %s: %s", ocel_id, e)

    project_id = parent_log.project_id if parent_log else None

    # Save flattened CSV to disk
    flat_dir = os.path.join(settings.UPLOAD_DIR, "flattened")
    os.makedirs(flat_dir, exist_ok=True)
    flat_filename = f"{uuid_mod.uuid4().hex}_{object_type}_flattened.csv"
    flat_path = os.path.join(flat_dir, flat_filename)
    flat_df.to_csv(flat_path, index=False)

    # Determine column names
    case_col = next((c for c in flat_df.columns if 'case' in c.lower() or c == 'case:concept:name'), flat_df.columns[0])
    act_col = next((c for c in flat_df.columns if c == 'concept:name' or 'activity' in c.lower()), flat_df.columns[1] if len(flat_df.columns) > 1 else flat_df.columns[0])
    ts_col = next((c for c in flat_df.columns if c == 'time:timestamp' or 'time' in c.lower()), flat_df.columns[2] if len(flat_df.columns) > 2 else flat_df.columns[0])

    total_cases = int(flat_df[case_col].nunique())
    total_events = len(flat_df)
    total_activities = int(flat_df[act_col].nunique())

    flat_name = f"{parent_log.name if parent_log else 'OCEL'} — {object_type} (flattened)"

    # Reuse an existing hidden flattened log for the same (project, name) so
    # repeat clicks don't create orphan files on disk.
    existing = None
    if project_id is not None:
        existing_result = await db.execute(
            select(EventLog).where(
                EventLog.project_id == project_id,
                EventLog.name == flat_name,
                EventLog.hidden == True,  # noqa: E712
            )
        )
        existing = existing_result.scalar_one_or_none()

    if existing is not None:
        # Replace the file contents and refresh stats
        if existing.file_path and os.path.exists(existing.file_path) and existing.file_path != flat_path:
            try:
                os.remove(existing.file_path)
            except OSError:
                pass
        existing.file_path = flat_path
        existing.case_id_column = case_col
        existing.activity_column = act_col
        existing.timestamp_column = ts_col
        existing.total_cases = total_cases
        existing.total_events = total_events
        existing.total_activities = total_activities
        existing.status = EventLogStatus.ready
        await db.commit()
        await db.refresh(existing)
        event_log = existing
    else:
        # Create a new hidden event log record
        event_log = EventLog(
            project_id=project_id,
            name=flat_name,
            file_path=flat_path,
            source_type=SourceType.upload,
            log_type=LogType.standard,
            status=EventLogStatus.ready,
            case_id_column=case_col,
            activity_column=act_col,
            timestamp_column=ts_col,
            total_cases=total_cases,
            total_events=total_events,
            total_activities=total_activities,
            hidden=True,
        )
        db.add(event_log)
        await db.commit()
        await db.refresh(event_log)

    return FlattenResponse(
        event_log_id=str(event_log.id),
        object_type=object_type,
        total_cases=total_cases,
        total_events=total_events,
        total_activities=total_activities,
    )


# ---------------------------------------------------------------------------
# Endpoint 14 — GET /ocel/{ocel_id}/insights
# ---------------------------------------------------------------------------


class OCELInsight(BaseModel):
    category: str = "ocel"
    severity: str  # critical, warning, info
    title: str
    description: str
    metric_value: float | None = None
    recommendation: str | None = None


class OCELInsightsResponse(BaseModel):
    insights: list[OCELInsight]
    summary: str


def _compute_ocel_structural_insights(ocel_obj) -> tuple[list[dict], dict]:
    """Run the six structural OCEL checks and return (insights, meta).

    Extracted so both the standalone ``/insights`` endpoint and the new
    ``/improvement-report`` endpoint below can reuse the same rule
    implementations without duplicating them.

    The ``meta`` dict carries object-type counts and the OCEL scale so
    the improvement report can build its summary card in one pass.
    """
    import pm4py

    insights: list[dict] = []

    try:
        object_types = list(pm4py.ocel_get_object_types(ocel_obj))
    except Exception:
        object_types = []

    # Event/object counts
    try:
        evt_count = len(ocel_obj.get_extended_table())
    except Exception:
        evt_count = 0
    try:
        obj_count = len(pm4py.ocel_objects_summary(ocel_obj))
    except Exception:
        obj_count = 0

    # 1. Object type balance
    oid_to_type: dict[str, str] = {}
    try:
        obj_df = ocel_obj.objects
        type_col = next((c for c in obj_df.columns if c.lower() in ("ocel:type", "type")), None)
        oid_col = next((c for c in obj_df.columns if c.lower() in ("ocel:oid", "oid")), None)
        if type_col and oid_col:
            for _, row in obj_df.iterrows():
                oid_to_type[str(row[oid_col])] = str(row[type_col])
    except Exception as e:
        logger.warning("OCEL insights: object-type balance index build failed: %s", e)

    type_counts = {}
    for t in oid_to_type.values():
        type_counts[t] = type_counts.get(t, 0) + 1

    if type_counts:
        biggest = max(type_counts, key=type_counts.get)  # type: ignore[arg-type]
        smallest = min(type_counts, key=type_counts.get)  # type: ignore[arg-type]
        ratio = type_counts[biggest] / max(type_counts[smallest], 1)
        if ratio > 50:
            insights.append({
                "category": "ocel_balance",
                "severity": "warning",
                "title": f"Extreme object type imbalance",
                "description": f'"{biggest}" has {type_counts[biggest]:,} objects while "{smallest}" has only {type_counts[smallest]:,} — a {ratio:.0f}x difference.',
                "metric_value": ratio,
                "recommendation": f'The small number of "{smallest}" objects may create bottlenecks or indicate shared resources. Investigate if this is expected.',
            })

    # 2. Object interactions
    try:
        interactions = pm4py.ocel_objects_interactions_summary(ocel_obj)
        if len(interactions) > 0:
            type_col_int = next((c for c in interactions.columns if c == "ocel:type"), None)
            type2_col = next((c for c in interactions.columns if c == "ocel:type_2"), None)
            if type_col_int and type2_col:
                pair_counts = interactions.groupby([type_col_int, type2_col]).size()
                if len(pair_counts) > 0:
                    top_pair = pair_counts.idxmax()
                    top_count = int(pair_counts.max())
                    insights.append({
                        "category": "ocel_interaction",
                        "severity": "info",
                        "title": f"Strongest interaction: {top_pair[0]} ↔ {top_pair[1]}",
                        "description": f"These object types interact {top_count:,} times — the most frequent relationship in your data.",
                        "metric_value": float(top_count),
                        "recommendation": "This interaction is likely a core part of your process. Monitor it for delays or mismatches.",
                    })
    except Exception as e:
        logger.warning("OCEL insights: interactions summary failed: %s", e)

    # 3. Lifecycle duration analysis
    try:
        summary_df = pm4py.ocel_objects_summary(ocel_obj)
        dur_col = next((c for c in summary_df.columns if "duration" in c.lower()), None)
        oid_col_s = next((c for c in summary_df.columns if c.lower() in ("ocel:oid", "oid")), None)
        if dur_col and oid_col_s:
            for ot in object_types:
                oids_of_type = {oid for oid, t in oid_to_type.items() if t == ot}
                subset = summary_df[summary_df[oid_col_s].isin(oids_of_type)]
                vals = subset[dur_col].dropna()
                if len(vals) > 0:
                    if hasattr(vals.iloc[0], "total_seconds"):
                        vals = vals.apply(lambda td: td.total_seconds())
                    mean_dur = float(vals.mean())
                    max_dur = float(vals.max())
                    if max_dur > 0 and max_dur / max(mean_dur, 1) > 10:
                        insights.append({
                            "category": "ocel_lifecycle",
                            "severity": "warning",
                            "title": f'"{ot}" has extreme lifecycle outliers',
                            "description": f"The longest {ot} lifecycle is {max_dur/86400:.1f} days while the average is {mean_dur/86400:.1f} days — a {max_dur/max(mean_dur,1):.0f}x difference.",
                            "metric_value": max_dur / max(mean_dur, 1),
                            "recommendation": f"Investigate the slowest {ot} objects for stuck cases, waiting times, or data issues.",
                        })
                        break  # Only report the worst one
    except Exception as e:
        logger.warning("OCEL insights: lifecycle duration analysis failed: %s", e)

    # 4. Activity coverage across types
    try:
        ot_acts = pm4py.ocel_object_type_activities(ocel_obj)
        all_acts = set()
        for acts in ot_acts.values():
            all_acts |= set(acts)

        for ot, acts in ot_acts.items():
            if len(acts) == 1:
                insights.append({
                    "category": "ocel_coverage",
                    "severity": "info",
                    "title": f'"{ot}" participates in only 1 activity',
                    "description": f'{ot} objects are only involved in "{list(acts)[0]}". They have a very narrow role in the process.',
                    "recommendation": None,
                })
                break  # Only first

        shared_acts = []
        for act in all_acts:
            types_with_act = [ot for ot, acts in ot_acts.items() if act in acts]
            if len(types_with_act) >= 3:
                shared_acts.append((act, len(types_with_act)))
        if shared_acts:
            top = max(shared_acts, key=lambda x: x[1])
            insights.append({
                "category": "ocel_coverage",
                "severity": "info",
                "title": f'"{top[0]}" involves {top[1]} object types',
                "description": f"This activity is a multi-object touchpoint where {top[1]} different types of objects interact simultaneously.",
                "metric_value": float(top[1]),
                "recommendation": "Multi-object activities are coordination points. Delays here affect multiple process streams.",
            })
    except Exception as e:
        logger.warning("OCEL insights: activity coverage failed: %s", e)

    # 5. Object type convergence — universal coordinator detection
    try:
        if ot_acts and all_acts and len(all_acts) > 3:
            for ot, acts in ot_acts.items():
                coverage = len(acts) / len(all_acts)
                if coverage > 0.9:
                    insights.append({
                        "category": "ocel_convergence",
                        "severity": "info",
                        "title": f'"{ot}" is a universal coordinator ({coverage * 100:.0f}% of activities)',
                        "description": f'"{ot}" objects appear in {len(acts)} out of {len(all_acts)} activities. Every process stage involves {ot} objects, making them the central object in your process.',
                        "metric_value": coverage * 100,
                        "recommendation": f'Since "{ot}" is involved in nearly everything, delays or data quality issues on these objects will cascade across the entire process. Monitor them closely.',
                    })
                    break
    except Exception as e:
        logger.warning("OCEL insights: convergence detection failed: %s", e)

    # 6. Missing object linkage — isolated types
    try:
        if type_counts and len(type_counts) > 1:
            # Build set of types that have at least one interaction
            interacting_types: set[str] = set()
            try:
                interactions_df = pm4py.ocel_objects_interactions_summary(ocel_obj)
                type_col_i = next((c for c in interactions_df.columns if c == "ocel:type"), None)
                type2_col_i = next((c for c in interactions_df.columns if c == "ocel:type_2"), None)
                if type_col_i and type2_col_i:
                    interacting_types = set(interactions_df[type_col_i].unique()) | set(interactions_df[type2_col_i].unique())
            except Exception:
                interacting_types = set(type_counts.keys())  # can't tell — skip

            isolated = [t for t in type_counts if t not in interacting_types]
            if isolated:
                iso = isolated[0]
                insights.append({
                    "category": "ocel_linkage",
                    "severity": "warning",
                    "title": f'"{iso}" objects are never linked to other types',
                    "description": f'"{iso}" objects ({type_counts[iso]:,} total) appear in the log but never co-occur with other object types in the same events. They may represent orphaned data or a missing relationship.',
                    "metric_value": type_counts[iso],
                    "recommendation": f'Investigate whether "{iso}" objects should be linked to other types. If they are truly independent, consider whether they belong in this OCEL.',
                })
    except Exception as e:
        logger.warning("OCEL insights: isolated-type detection failed: %s", e)

    # Sort
    sev_order = {"critical": 0, "warning": 1, "info": 2}
    insights.sort(key=lambda i: sev_order.get(i["severity"], 9))

    meta = {
        "object_types": object_types,
        "type_counts": type_counts,
        "event_count": evt_count,
        "object_count": obj_count,
    }
    return insights, meta


@router.get("/{ocel_id}/insights", response_model=OCELInsightsResponse)
async def get_ocel_insights(
    ocel_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """Generate automated plain-language insights for an OCEL."""
    await _assert_ocel_access(ocel_id, db, current_user)

    cached = _ocel_cache_get(ocel_id, "ocel_insights")
    if cached is not None:
        return OCELInsightsResponse(**cached)

    ocel_obj = _get_ocel_or_404(ocel_id)

    insights, meta = _compute_ocel_structural_insights(ocel_obj)

    # Summary
    summary = (
        f"OCEL with {len(meta['object_types'])} object types, "
        f"{meta['object_count']:,} objects, {meta['event_count']:,} events."
    )
    warnings = sum(1 for i in insights if i["severity"] == "warning")
    if warnings:
        summary += f" {warnings} warning{'s' if warnings > 1 else ''} found."
    if not insights:
        summary += " No issues detected."

    response = OCELInsightsResponse(insights=insights, summary=summary)
    _ocel_cache_set(ocel_id, "ocel_insights", response.model_dump())
    return response


# ---------------------------------------------------------------------------
# Improvement-report + LLM-narration routes moved to app.api.ocel_improvements
# (registered separately at the same /api/v1/ocel prefix in main.py).
#
# Re-exported here so external importers — notably
# scripts/tune_ocpm_narrative.py — and this module's own /report HTML
# export keep importing them from app.api.ocel unchanged.
# ---------------------------------------------------------------------------
from app.api.ocel_improvements import (  # noqa: E402,F401
    ExplainFindingRequest,
    ExplainFindingResponse,
    ImprovementFinding,
    ImprovementReportResponse,
    NarrativeResponse,
    ObjectTypeSection,
    _NARRATE_SYSTEM_PROMPT,
    _summarise_findings_for_prompt,
    explain_improvement_finding,
    get_ocpm_improvement_report,
    narrate_improvement_report,
)


# ---------------------------------------------------------------------------
# Endpoint — GET /ocel/{ocel_id}/report
# Self-contained printable HTML report of the improvement findings.
# Mirrors `/mining/report/{event_log_id}` for standard logs but
# pulls from the OCPM improvement report so OCEL users have an
# equivalent one-click document export.
# ---------------------------------------------------------------------------


class OCELReportResponse(BaseModel):
    html: str
    event_log_name: str | None


@router.get("/{ocel_id}/report", response_model=OCELReportResponse)
async def generate_ocel_report(
    ocel_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """Generate a printable HTML improvement report for an OCEL.

    Pulls the same structured data the Improvements tab renders
    (OCEL-level findings + per-object-type sections + cross-object
    patterns) plus an LLM-written narrative when a provider is
    configured. Returns one self-contained HTML string the frontend
    opens in a noopener window for printing.
    """
    from datetime import date

    from app.api._mining_deps import _get_cached, _set_cached

    await _assert_ocel_access(ocel_id, db, current_user)

    cached = _get_cached(ocel_id, "improvement_report_html")
    if cached is not None:
        return OCELReportResponse(**cached)

    # The improvement report endpoint is the canonical source for
    # everything we render — call it directly so a single change in
    # the rule engine flows into both the live page and the report.
    report = await get_ocpm_improvement_report(ocel_id, current_user, db)
    # Try to get the AI narrative too — fall back gracefully if no
    # LLM provider is configured.
    narrative_text: str | None = None
    try:
        narr = await narrate_improvement_report(ocel_id, current_user, db)
        if narr.llm_configured:
            narrative_text = narr.narrative
    except Exception as e:
        logger.warning("OCEL report: narrative fetch failed: %s", e)

    # Look up the event log for the title
    event_log = None
    try:
        result = await db.execute(select(EventLog).where(EventLog.id == UUID(ocel_id)))
        event_log = result.scalar_one_or_none()
    except Exception:
        pass
    log_name = event_log.name if event_log else "OCEL"
    report_date = date.today().isoformat()

    sev_color = {
        "critical": "#c0392b",
        "warning": "#e67e22",
        "info": "#27ae60",
    }

    def _render_finding_row(f) -> str:
        color = sev_color.get(f.severity, "#888")
        impact = f.impact_estimate or ""
        return (
            f"<tr>"
            f"<td style='vertical-align:top;width:90px'>"
            f"<span style='display:inline-block;padding:2px 8px;border-radius:10px;"
            f"background:{color}22;color:{color};font-size:11px;font-weight:bold'>"
            f"{f.severity.upper()}</span></td>"
            f"<td>"
            f"<div style='font-weight:bold;color:#1a2e4a'>{f.title}</div>"
            f"<div style='color:#444;margin-top:2px'>{f.description}</div>"
            + (
                f"<div style='margin-top:4px;color:#777;font-style:italic'>{f.recommendation}</div>"
                if f.recommendation
                else ""
            )
            + (
                f"<div style='margin-top:4px;color:#1a73e8'>↓ {impact}</div>"
                if impact
                else ""
            )
            + "</td>"
            "</tr>"
        )

    def _render_section(title: str, findings) -> str:
        if not findings:
            return ""
        rows = "".join(_render_finding_row(f) for f in findings)
        return f"<h2>{title}</h2><table><tbody>{rows}</tbody></table>"

    cross_html = _render_section(
        f"Cross-object patterns ({len(report.cross_object_findings)})",
        report.cross_object_findings,
    )
    ocel_html = _render_section(
        f"OCEL structural findings ({len(report.ocel_findings)})",
        report.ocel_findings,
    )

    per_type_html = ""
    for section in report.per_object_type:
        if section.error:
            per_type_html += (
                f"<h3>{section.object_type}</h3>"
                f"<p style='color:#888;font-style:italic'>{section.error}</p>"
            )
            continue
        meta = (
            f"<p class='meta'>"
            f"{section.total_cases:,} cases · {section.total_events:,} events · "
            f"{section.total_activities} activities · "
            f"<span style='color:{sev_color['critical']}'>"
            f"{section.critical_count} critical</span> · "
            f"<span style='color:{sev_color['warning']}'>"
            f"{section.warning_count} warning</span>"
            f"</p>"
        )
        rows = "".join(_render_finding_row(f) for f in section.findings) or (
            "<tr><td colspan='2' style='color:#888;text-align:center'>"
            "No findings for this perspective.</td></tr>"
        )
        per_type_html += (
            f"<h3>{section.object_type}</h3>"
            f"{meta}"
            f"<table><tbody>{rows}</tbody></table>"
        )

    # Narrative section — only when we actually got an LLM response.
    narrative_html = ""
    if narrative_text:
        # Escape angle brackets so the LLM can't smuggle markup. We
        # already strip the dangerous patterns server-side via the
        # secret-scrub log processor, but report HTML is rendered in
        # a noopener-isolated window so we want belt-and-braces.
        from html import escape as _esc
        narrative_html = (
            "<h2>AI executive summary</h2>"
            f"<div class='narrative'>{_esc(narrative_text)}</div>"
        )

    summary_pieces = [
        f"<strong>Object types:</strong> {report.object_type_count}",
        f"<strong>Objects:</strong> {report.ocel_object_count:,}",
        f"<strong>Events:</strong> {report.ocel_event_count:,}",
        f"<strong>Findings:</strong> {report.total_findings} "
        f"({report.critical_count} critical, {report.warning_count} warning)",
    ]
    summary_html = " &nbsp;&bull;&nbsp; ".join(summary_pieces)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>FlowMiner OCPM Report — {log_name}</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px;
         color: #222; background: #fff; padding: 32px 40px; }}
  h1 {{ font-size: 22px; color: #1a2e4a; margin-bottom: 4px; }}
  h2 {{ font-size: 15px; color: #1a2e4a; margin: 28px 0 10px;
        border-bottom: 2px solid #3498db; padding-bottom: 4px; }}
  h3 {{ font-size: 13px; color: #1a2e4a; margin: 18px 0 6px; }}
  .meta {{ font-size: 12px; color: #666; margin-bottom: 14px; }}
  .summary-meta {{ font-size: 12px; color: #444; margin-bottom: 24px; }}
  table {{ width: 100%; border-collapse: collapse; margin-bottom: 8px; }}
  td {{ padding: 9px 10px; border-bottom: 1px solid #e8e8e8; vertical-align: top; }}
  tr:nth-child(even) td {{ background: #f7f9fc; }}
  .narrative {{ background: #f0f7ff; border-left: 3px solid #3498db;
                padding: 12px 16px; margin: 8px 0 16px; white-space: pre-wrap;
                line-height: 1.55; }}
  footer {{ margin-top: 40px; padding-top: 12px; border-top: 1px solid #ddd;
            font-size: 11px; color: #999; text-align: center; }}
  @media print {{
    body {{ padding: 16px 20px; }}
    h2, h3 {{ page-break-after: avoid; }}
    table {{ page-break-inside: avoid; }}
    .narrative {{ page-break-inside: avoid; }}
  }}
</style>
</head>
<body>
<h1>OCPM Improvement Report</h1>
<p class="meta">
  <strong>Event log:</strong> {log_name} &nbsp;&bull;&nbsp;
  <strong>Generated:</strong> {report_date} &nbsp;&bull;&nbsp;
  <strong>Generated by:</strong> FlowMiner
</p>
<p class="summary-meta">{summary_html}</p>
{narrative_html}
{cross_html}
{ocel_html}
{('<h2>Per object type</h2>' + per_type_html) if per_type_html else ''}
<footer>
  Generated by <strong>FlowMiner</strong> &mdash; Open-source Process Mining Platform &mdash; {report_date}
</footer>
</body>
</html>"""

    response = OCELReportResponse(html=html, event_log_name=log_name)
    _set_cached(ocel_id, "improvement_report_html", response.model_dump())
    return response


# ---------------------------------------------------------------------------
# Endpoint — POST /ocel/{ocel_id}/state-aware
# State-Aware OCPM pre-processor (Kretzschmann, Berti, van der Aalst, EDOC 2025)
# ---------------------------------------------------------------------------


class StateTransition(BaseModel):
    oid: str
    object_type: str
    from_state: str | None = None
    to_state: str
    timestamp: str
    activity: str


class StateAwareResponse(BaseModel):
    """Typed wrapper over ``enrich_ocel_with_state_transitions`` so the
    frontend has a stable contract for the State-Aware OCPM service."""

    new_events_count: int = Field(
        ..., description="Number of synthetic state-transition events generated"
    )
    annotated_events: int = Field(
        ..., description="How many existing events were enriched with object state"
    )
    state_transitions: list[StateTransition] = Field(
        default_factory=list,
        description="The generated transition events (capped at 500 for transport)",
    )
    distinct_states: dict[str, list[str]] = Field(
        default_factory=dict,
        description="Unique states observed, keyed by object type",
    )
    annotations_by_event: dict[str, dict[str, str]] = Field(
        default_factory=dict,
        description="event_id -> {state_<object_type>: current_state}",
    )
    method: str = Field(..., description="Algorithm identifier")
    state_column: str | None = None
    object_type_filter: str | None = None
    note: str | None = None


@router.post("/{ocel_id}/state-aware", response_model=StateAwareResponse)
async def ocel_state_aware(
    ocel_id: str,
    state_column: str = Query(..., description="Object attribute column that carries the state label"),
    object_type: str | None = Query(None, description="Optional — restrict to a single object type"),
    persist: bool = Query(
        True,
        description=(
            "When true (default) the enriched OCEL — with the synthetic "
            "state-transition events materialised — replaces the stored log "
            "in memory and on disk, so downstream OC-DFG / OPerA / "
            "improvement-report runs actually see the new events. Set false "
            "to compute the summary without mutating the stored log."
        ),
    ),
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """Enrich this OCEL with object-state transition events.

    Implements the **State-Aware OCPM** extension of OCEL 2.0 from
    Kretzschmann, Berti & van der Aalst (EDOC 2025). Materializes
    every state change of the selected object attribute as a
    synthetic event and annotates every existing event with the
    current state of each related object.

    This unlocks lifecycle-driven analysis — inventory cycles,
    patient care pathways, order lifecycle — on existing OCEL 2.0
    logs without any custom preprocessing, and is backward-compatible
    with every OCEL 2.0 reader (the new events are regular events
    with a distinguished activity name prefix).

    Unless ``persist=false``, the enriched OCEL is written back to the
    EventLog's file on disk AND replaces the in-memory cache entry, so a
    subsequent ``_get_ocel_or_404`` (in this process or after a restart)
    returns the enriched log and downstream analyses run on it.
    """
    from app.services.ocel_state_aware import enrich_ocel_with_state_transitions
    import asyncio as _asyncio

    await _assert_ocel_access(ocel_id, db, current_user)
    ocel = _get_ocel_or_404(ocel_id)

    try:
        result = await _asyncio.to_thread(
            enrich_ocel_with_state_transitions,
            ocel,
            state_column,
            object_type,
            persist,  # materialize — only build the new OCEL when we'll persist it
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.error("State-aware OCPM enrichment failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"State-aware enrichment failed: {e}",
        )

    # ``materialized_ocel`` is the enriched pm4py OCEL object; it is not
    # JSON-serialisable and is absent from StateAwareResponse, so pop it out
    # of the dict before constructing the response either way.
    enriched_ocel = result.pop("materialized_ocel", None)

    if persist and enriched_ocel is not None:
        try:
            await _asyncio.to_thread(
                _persist_enriched_ocel_sync, ocel_id, enriched_ocel
            )
        except Exception as e:
            # Persistence is best-effort: the summary is still valid even if
            # the write-back failed, but surface a hint to the caller.
            logger.error(
                "State-aware enrichment computed but persisting failed for %s: %s",
                ocel_id, e, exc_info=True,
            )
            result["note"] = (
                (result.get("note") + " | " if result.get("note") else "")
                + f"enrichment NOT persisted ({e})"
            )

    return StateAwareResponse(**result)


def _persist_enriched_ocel_sync(ocel_id: str, enriched_ocel) -> None:
    """Write the enriched OCEL back to disk and refresh the in-memory cache
    and EventLog totals so every later reload sees the materialised events.

    Synchronous (dispatched to a thread): uses the sync engine, mirroring
    ``_resolve_ocel_disk_path_sync`` / ``_get_ocel_or_404``. Writes to the
    EventLog's existing ``file_path`` when there is a backing row (so the
    next disk reload returns the enriched log) and always updates the
    in-memory store so same-process analyses see it immediately.
    """
    from sqlalchemy.orm import Session as SyncSession
    from app.database import sync_engine

    # Always refresh the in-memory cache first — same-process downstream
    # analyses (OC-DFG / OPerA / improvement-report) read from here.
    _ocel_store[ocel_id] = enriched_ocel

    event_count, object_count = _ocel_counts(enriched_ocel)
    try:
        activities_count = len(
            set(enriched_ocel.events["ocel:activity"].astype(str).tolist())
        )
    except Exception:
        activities_count = 0

    with SyncSession(sync_engine) as db:
        event_log = db.query(EventLog).filter(
            EventLog.id == UUID(ocel_id),
            EventLog.log_type == LogType.ocel.value,
        ).first()

        if event_log is None or not event_log.file_path:
            # Synthetic conversion id (no backing row / no file): the
            # in-memory refresh above is the only durable place to put it.
            logger.info(
                "State-aware: ocel %s has no EventLog file_path; "
                "enriched log kept in memory only",
                ocel_id,
            )
            return

        # Overwrite the existing file in place so file_path stays valid and
        # the next disk reload returns the enriched OCEL.
        write_ocel_to_disk(enriched_ocel, event_log.file_path)

        # Keep the row's totals consistent with the now-enriched log.
        event_log.total_events = event_count
        event_log.total_cases = object_count
        event_log.total_activities = activities_count
        db.add(event_log)
        db.commit()
        logger.info(
            "State-aware: persisted enriched OCEL %s to %s (%d events, %d objects)",
            ocel_id, event_log.file_path, event_count, object_count,
        )


# ---------------------------------------------------------------------------
# Endpoint — GET /ocel/{ocel_id}/opera-performance
# OPerA object-centric performance metrics (Park, Adams, van der Aalst).
# Computes synchronization / pooling / lagging / flow time per activity via
# ocpa's token-replay-based performance over a discovered OC Petri net.
# ---------------------------------------------------------------------------


class OPeraActivityMetrics(BaseModel):
    """Per-activity OPerA timing metrics, all in seconds (None when the
    underlying replay produced no measurement for that activity)."""

    activity: str
    flow_time: float | None = Field(
        None,
        description="Total time from the first to last object-token arrival at the activity",
    )
    synchronization_time: float | None = Field(
        None,
        description="Time the activity waits for the last required object to become available",
    )
    pooling_time: float | None = Field(
        None,
        description="Time spent pooling objects of a single type before the activity fires",
    )
    lagging_time: float | None = Field(
        None,
        description="Time an object spends waiting because objects of other types lag behind",
    )


class OPeraPerformanceResponse(BaseModel):
    ocel_id: str
    activities: list[OPeraActivityMetrics]
    method: str = "opera_token_replay_based_performance"
    note: str | None = None


# Map the four user-facing OPerA metric names to the substrings that appear
# in ocpa diagnostics keys across versions (e.g. ``agg_merged_flow_times``,
# ``flow_time``, ``flow``). Order matters — more specific first.
_OPERA_METRIC_KEYS: dict[str, tuple[str, ...]] = {
    "flow_time": ("flow",),
    "synchronization_time": ("synchronization", "sync"),
    "pooling_time": ("pooling", "pool"),
    "lagging_time": ("lagging", "lag"),
}


def _opera_coerce_seconds(value) -> float | None:
    """Reduce an ocpa diagnostics value to a single float (seconds).

    ocpa hands back numbers, timedeltas, or aggregates (lists / dicts of
    per-trace measurements). We average lists and pull the mean out of an
    aggregate dict so the response is a single comparable number.
    """
    if value is None:
        return None
    if hasattr(value, "total_seconds"):
        try:
            return float(value.total_seconds())
        except Exception:
            return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, dict):
        # Prefer an explicit mean/avg key if ocpa already aggregated it.
        for k in ("mean", "avg", "average"):
            if k in value:
                return _opera_coerce_seconds(value[k])
        nums = [_opera_coerce_seconds(v) for v in value.values()]
        nums = [n for n in nums if n is not None]
        return float(sum(nums) / len(nums)) if nums else None
    if isinstance(value, (list, tuple, set)):
        nums = [_opera_coerce_seconds(v) for v in value]
        nums = [n for n in nums if n is not None]
        return float(sum(nums) / len(nums)) if nums else None
    return None


def _opera_extract_metrics(diagnostics: dict) -> dict[str, dict[str, float | None]]:
    """Pull the four OPerA metrics per activity out of ocpa diagnostics.

    ocpa's ``token_replay_based_performance`` returns a dict whose timing
    sections are keyed by something like ``agg_merged_flow_times`` and map
    activity (transition) name -> measurement. Key names drift across ocpa
    releases, so we match defensively by substring and skip anything we
    can't interpret rather than failing the whole request.
    """
    per_activity: dict[str, dict[str, float | None]] = {}
    if not isinstance(diagnostics, dict):
        return per_activity

    for metric, needles in _OPERA_METRIC_KEYS.items():
        # Find the diagnostics section for this metric: an activity->value
        # mapping whose key name contains one of the needles plus "time".
        section = None
        for key, val in diagnostics.items():
            key_l = str(key).lower()
            if "time" not in key_l:
                continue
            if any(n in key_l for n in needles) and isinstance(val, dict):
                section = val
                break
        if section is None:
            continue
        for activity, raw in section.items():
            secs = _opera_coerce_seconds(raw)
            per_activity.setdefault(str(activity), {})[metric] = secs

    return per_activity


def _resolve_ocel_disk_path_sync(ocel_id: str) -> str | None:
    """Best-effort lookup of the on-disk OCEL file for a real EventLog id.

    Mirrors the reload path in ``_get_ocel_or_404``. Returns None for
    synthetic conversion ids (which never have a file on disk) — the
    caller falls back to materialising the in-memory OCEL to a temp file.
    """
    from sqlalchemy.orm import Session as SyncSession
    from app.database import sync_engine

    try:
        with SyncSession(sync_engine) as db:
            event_log = db.query(EventLog).filter(
                EventLog.id == UUID(ocel_id),
                EventLog.log_type == LogType.ocel,
            ).first()
        if event_log and event_log.file_path and os.path.exists(event_log.file_path):
            return event_log.file_path
    except Exception as e:
        logger.warning("OPerA: on-disk OCEL path lookup failed for %s: %s", ocel_id, e)
    return None


def _compute_opera_performance(ocel_id: str, ocel_obj) -> dict:
    """Synchronous OPerA computation (dispatched to a thread).

    Imports ocpa LAZILY — the import is allowed to raise ImportError so the
    async endpoint can translate it into a 501. ocpa needs to import the OCEL
    from a file via its own importer, so we feed it the original upload path
    when available, otherwise we serialise the in-memory pm4py OCEL to a
    temporary ``.jsonocel`` first.
    """
    import tempfile

    # Lazy import — propagates ImportError to the endpoint for a clean 501.
    from ocpa.objects.ocel.importer import factory as ocel_import_factory
    from ocpa.algo.discovery.ocpn import algorithm as ocpn_discovery_factory
    from ocpa.algo.enhancement.token_replay_based_performance import (
        algorithm as performance_factory,
    )

    tmp_path: str | None = None
    file_path = _resolve_ocel_disk_path_sync(ocel_id)

    if file_path is None or os.path.splitext(file_path)[1].lower() not in (".jsonocel", ".json"):
        # Materialise the in-memory OCEL to an OCEL 1.0 JSON file that ocpa's
        # importer reliably reads (covers converted logs and OCEL 2.0
        # sqlite/xml uploads ocpa can't parse directly).
        import pm4py

        fd, tmp_path = tempfile.mkstemp(suffix=".jsonocel", prefix="opera_")
        os.close(fd)
        try:
            pm4py.write_ocel_json(ocel_obj, tmp_path)
        except Exception:
            writer = getattr(pm4py, "write_ocel2_json", None)
            if writer is None:
                raise
            writer(ocel_obj, tmp_path)
        file_path = tmp_path

    try:
        ocpa_ocel = ocel_import_factory.apply(file_path)
        ocpn = ocpn_discovery_factory.apply(ocpa_ocel)
        diagnostics = performance_factory.apply(ocpn, ocpa_ocel)
    finally:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    per_activity = _opera_extract_metrics(diagnostics)

    activities = [
        {
            "activity": act,
            "flow_time": metrics.get("flow_time"),
            "synchronization_time": metrics.get("synchronization_time"),
            "pooling_time": metrics.get("pooling_time"),
            "lagging_time": metrics.get("lagging_time"),
        }
        for act, metrics in sorted(per_activity.items())
    ]

    return {
        "ocel_id": ocel_id,
        "activities": activities,
        "method": "opera_token_replay_based_performance",
        "note": None if activities else (
            "ocpa produced no per-activity timing diagnostics for this OCEL. "
            "The log may lack the multi-object overlaps OPerA measures."
        ),
    }


@router.get("/{ocel_id}/opera-performance", response_model=OPeraPerformanceResponse)
async def get_opera_performance(
    ocel_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """Compute **OPerA** object-centric performance metrics for the OCEL.

    OPerA (Object-centric Performance Analysis, Park / Adams / van der
    Aalst) decomposes activity time into *flow*, *synchronization*,
    *pooling* and *lagging* time — the object-centric analogue of the
    waiting/service split in a flat log, and FlowMiner's named
    anti-Celonis differentiator on the OCPM side.

    The computation uses ocpa's token-replay-based performance over a
    discovered object-centric Petri net. ocpa is an OPTIONAL dependency:
    if it isn't installed this endpoint returns ``501 Not Implemented``
    with an actionable message rather than crashing.
    """
    import asyncio as _asyncio

    await _assert_ocel_access(ocel_id, db, current_user)

    cached = _ocel_cache_get(ocel_id, "opera_performance")
    if cached is not None:
        return OPeraPerformanceResponse(**cached)

    ocel_obj = _get_ocel_or_404(ocel_id)

    try:
        result = await _asyncio.to_thread(_compute_opera_performance, ocel_id, ocel_obj)
    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=(
                "OPerA performance metrics require the optional 'ocpa' package, "
                "which is not installed in this environment. Install it "
                "(pip install ocpa) and restart the backend to enable this feature."
            ),
        )
    except Exception as e:
        logger.error("OPerA performance computation failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"OPerA performance computation failed: {e}",
        )

    response = OPeraPerformanceResponse(**result)
    _ocel_cache_set(ocel_id, "opera_performance", response.model_dump())
    return response
