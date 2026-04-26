"""
Process mining router: discovery, variant analysis, bottleneck detection,
conformance checking, root cause analysis, statistics, and auto-summary.

Results are cached in-memory keyed by (event_log_id, analysis_type, params_hash).
"""

import asyncio
import functools
import hashlib
import json
import logging
import os
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import EventLog, User
import pandas as pd

from app.schemas.mining import (
    ActivityDetailResponse,
    AttributeFilter,
    BatchResponse,
    BPMNExportResponse,
    BottleneckResponse,
    CaseDetailResponse,
    CaseListResponse,
    CaseOverlapResponse,
    ClusterRequest,
    ClusterResponse,
    ComparisonRequest,
    ComparisonResponse,
    ConformanceResponse,
    DataQualityIssue,
    DataQualityResponse,
    DeclareResponse,
    DiscoveryRequest,
    DiscoveryResponse,
    DottedChartResponse,
    EFGResponse,
    FeatureExportResponse,
    FourEyesRequest,
    FourEyesResponse,
    InsightsResponse,
    LogSkeletonResponse,
    OrgRolesResponse,
    PerformanceDFGResponse,
    PerformanceSpectrumResponse,
    ProcessFilter,
    ProcessStatistics,
    ProcessSummary,
    ReportResponse,
    ReworkResponse,
    RootCauseResponse,
    SNAResponse,
    SimulationRequest,
    SimulationResponse,
    SocialNetworkResponse,
    StochasticConformanceResponse,
    TemporalProfileResponse,
    TimelineResponse,
    VariantResponse,
)
from app.api.deps import _user_can_access_project, get_current_active_user
from app.models import Project
from app.services.mining_engine import mining_engine
from app.services.ingestion import CASE_COL, ACTIVITY_COL, TIMESTAMP_COL

logger = logging.getLogger(__name__)

router = APIRouter()

# Shared mining result cache (Redis-backed, with in-process fallback).
# Using a shared cache means multi-worker deployments don't recompute the
# same discovery/conformance/etc. per worker.
from app.services.result_cache import (  # noqa: E402
    cache_clear_event_log,
    cache_get,
    cache_set,
)


async def _run_in_thread(func, *args, **kwargs):
    """Run a blocking function in the threadpool so it doesn't block the event loop.

    Every CPU-heavy mining_engine call should be dispatched through this
    instead of being awaited directly. Using asyncio.to_thread is cheap and
    means concurrent requests can make progress on the event loop while one
    request's mining is in flight.
    """
    if kwargs:
        return await asyncio.to_thread(functools.partial(func, *args, **kwargs))
    return await asyncio.to_thread(func, *args)


def _make_params_hash(params: dict | None) -> str:
    """Create a deterministic hash for a set of parameters."""
    if not params:
        return "none"
    serialized = json.dumps(params, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()


from contextvars import ContextVar

# Contextvar set by _assert_event_log_access at the top of every request.
# Used by the cache key scoping below so redacted results can't leak
# between roles on a cache hit.
_current_user_ctx: ContextVar[User | None] = ContextVar("mining_current_user", default=None)


def _scope_params(params: dict | None) -> dict:
    """Expand the cache params with a privacy scope. See _current_user_ctx."""
    scoped = dict(params or {})
    user = _current_user_ctx.get()
    if user is not None:
        scoped["_role"] = getattr(user.role, "value", str(user.role))
    return scoped


def _get_cached(event_log_id: UUID, analysis_type: str, params: dict | None = None) -> dict | None:
    return cache_get(str(event_log_id), analysis_type, _make_params_hash(_scope_params(params)))


def _set_cached(event_log_id: UUID, analysis_type: str, result: dict, params: dict | None = None):
    cache_set(str(event_log_id), analysis_type, result, _make_params_hash(_scope_params(params)))


def _clear_cache_for_event_log(event_log_id: UUID):
    """Remove all cached results for a given event log (called when column mapping changes)."""
    cache_clear_event_log(str(event_log_id))


async def _assert_event_log_access(event_log_id: UUID, db: AsyncSession, user: User) -> None:
    """Lightweight authorization check used BEFORE the result cache lookup.

    Without this, a cached mining result would leak to any authenticated user
    who guesses the event_log_id, because the cache bypasses the row fetch
    inside ``_load_event_log_and_df``. This helper does a small two-row lookup
    (event_log + project) and raises 404 if the caller can't access the
    parent project. It also binds ``user`` to the cache-scope contextvar so
    subsequent ``_get_cached`` / ``_set_cached`` calls are tenant-scoped.
    """
    result = await db.execute(select(EventLog).where(EventLog.id == event_log_id))
    event_log = result.scalar_one_or_none()
    if event_log is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event log not found")
    proj_result = await db.execute(select(Project).where(Project.id == event_log.project_id))
    project = proj_result.scalar_one_or_none()
    if project is None or not _user_can_access_project(user, project):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event log not found")

    # Bind the authenticated user so cache keys are scoped by role.
    _current_user_ctx.set(user)


async def _load_event_log_and_df(event_log_id: UUID, db: AsyncSession, user: User | None = None):
    """
    Fetch the EventLog record from the DB, verify the caller has access to
    its parent project, validate it has column mapping, and load the
    DataFrame using the mining engine.

    Every mining endpoint funnels through this helper, so the authorization
    check applied here covers all 39 endpoints at once. The ``user``
    argument is optional only so callers that pass an explicit user can
    do so without keyword ambiguity — in practice every caller should
    pass the authenticated user.

    Returns:
        (event_log, df) tuple
    """
    result = await db.execute(select(EventLog).where(EventLog.id == event_log_id))
    event_log = result.scalar_one_or_none()
    if event_log is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Event log not found"
        )

    # Row-level authorization: verify the current user can access the parent
    # project. If no user was passed in (shouldn't happen in practice but
    # guards against legacy callers), skip the check — existing endpoints
    # still authenticate via their own dependency.
    if user is not None:
        proj_result = await db.execute(select(Project).where(Project.id == event_log.project_id))
        project = proj_result.scalar_one_or_none()
        if project is None or not _user_can_access_project(user, project):
            # Mask existence — don't leak the row to unauthorized callers.
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event log not found")

    if event_log.log_type == "ocel":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "This is an OCEL log. Standard process-mining analyses require a "
                "case/activity/timestamp mapping, which OCEL logs don't have. "
                "Use the OCEL views (/ocpm) or a standard event log instead."
            ),
        )

    if not event_log.case_id_column:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Column mapping not set. Please set case_id_column, activity_column, "
            "and timestamp_column before running analysis.",
        )

    if not event_log.file_path or not os.path.exists(event_log.file_path):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Event log file not found on disk",
        )

    try:
        # File I/O + pandas parsing runs in the threadpool so a 500 MB CSV
        # parse doesn't freeze every other request on the worker.
        df = await _run_in_thread(
            mining_engine.load_event_log,
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
            detail=f"Error loading event log: {str(e)}",
        )

    # Apply per-project privacy config if one exists. This is how GDPR /
    # PII rules are enforced — the anonymizer runs on every frame that
    # flows into mining endpoints, so downstream analyses only ever see
    # the redacted version. Admins always see raw data.
    try:
        from app.models import PrivacyConfig, UserRole
        from app.services.anonymizer import anonymize_df

        if user is not None and user.role != UserRole.admin:
            pc_result = await db.execute(
                select(PrivacyConfig).where(PrivacyConfig.project_id == event_log.project_id)
            )
            pc = pc_result.scalar_one_or_none()
            if pc is not None:
                # Role-based raw-data access: if the user's role is not
                # allowed raw data, redact regardless of column flags.
                role_sees_raw = (
                    (user.role == UserRole.analyst and pc.analyst_sees_raw)
                    or (user.role == UserRole.viewer and pc.viewer_sees_raw)
                )
                if not role_sees_raw or pc.anonymize_resources or pc.anonymize_case_ids or pc.masked_columns:
                    df = await _run_in_thread(
                        anonymize_df,
                        df,
                        anonymize_resources=pc.anonymize_resources or not role_sees_raw,
                        anonymize_case_ids=pc.anonymize_case_ids or not role_sees_raw,
                        masked_columns=pc.masked_columns or [],
                    )
    except Exception as e:
        logger.warning("Privacy enforcement failed (continuing with raw data): %s", e)

    return event_log, df


def _apply_filters(df: pd.DataFrame, filters: ProcessFilter | None) -> pd.DataFrame:
    """Apply process-level filters to a DataFrame, returning a filtered copy."""
    if filters is None:
        return df

    filtered = df

    # Timeframe filter
    if filters.time_start:
        try:
            ts = pd.Timestamp(filters.time_start)
            filtered = filtered[filtered[TIMESTAMP_COL] >= ts]
        except Exception:
            pass
    if filters.time_end:
        try:
            ts = pd.Timestamp(filters.time_end)
            filtered = filtered[filtered[TIMESTAMP_COL] <= ts]
        except Exception:
            pass

    # Case duration filter
    if filters.duration_min is not None or filters.duration_max is not None:
        case_dur = filtered.groupby(CASE_COL)[TIMESTAMP_COL].apply(
            lambda x: (x.max() - x.min()).total_seconds()
        )
        keep = case_dur.index
        if filters.duration_min is not None:
            keep = case_dur[case_dur >= filters.duration_min].index
        if filters.duration_max is not None:
            keep = keep.intersection(case_dur[case_dur <= filters.duration_max].index)
        filtered = filtered[filtered[CASE_COL].isin(keep)]

    # Activity include (cases must contain ALL listed activities)
    if filters.activities_include:
        case_acts = filtered.groupby(CASE_COL)[ACTIVITY_COL].apply(set)
        required = set(filters.activities_include)
        keep = case_acts[case_acts.apply(lambda s: required.issubset(s))].index
        filtered = filtered[filtered[CASE_COL].isin(keep)]

    # Activity exclude (cases containing ANY listed activity are removed)
    if filters.activities_exclude:
        excluded = set(filters.activities_exclude)
        case_acts = filtered.groupby(CASE_COL)[ACTIVITY_COL].apply(set)
        keep = case_acts[case_acts.apply(lambda s: s.isdisjoint(excluded))].index
        filtered = filtered[filtered[CASE_COL].isin(keep)]

    # Start activity filter
    if filters.start_activities:
        starts = set(filters.start_activities)
        first_act = filtered.sort_values(TIMESTAMP_COL).groupby(CASE_COL)[ACTIVITY_COL].first()
        keep = first_act[first_act.isin(starts)].index
        filtered = filtered[filtered[CASE_COL].isin(keep)]

    # End activity filter
    if filters.end_activities:
        ends = set(filters.end_activities)
        last_act = filtered.sort_values(TIMESTAMP_COL).groupby(CASE_COL)[ACTIVITY_COL].last()
        keep = last_act[last_act.isin(ends)].index
        filtered = filtered[filtered[CASE_COL].isin(keep)]

    # Variant filter
    if filters.variants is not None:
        case_variants = filtered.sort_values(TIMESTAMP_COL).groupby(CASE_COL)[ACTIVITY_COL].apply(
            lambda x: ' → '.join(x)
        )
        variant_list = case_variants.value_counts().index.tolist()
        selected_variant_strings = {variant_list[i] for i in filters.variants if i < len(variant_list)}
        keep = case_variants[case_variants.isin(selected_variant_strings)].index
        filtered = filtered[filtered[CASE_COL].isin(keep)]

    # Attribute filters
    if filters.attributes:
        for attr_filter in filters.attributes:
            col = attr_filter.column
            if col not in filtered.columns:
                continue
            vals = set(attr_filter.values)
            case_vals = filtered.groupby(CASE_COL)[col].apply(lambda x: set(x.astype(str)))
            if attr_filter.exclude:
                keep = case_vals[case_vals.apply(lambda s: s.isdisjoint(vals))].index
            else:
                keep = case_vals[case_vals.apply(lambda s: bool(s & vals))].index
            filtered = filtered[filtered[CASE_COL].isin(keep)]

    # Edge-based filters: walk each case's activity sequence in time order
    # and build a set of consecutive (prev, current) pairs. Required edges
    # must ALL be present; forbidden edges must NOT appear.
    if filters.required_edges or filters.forbidden_edges:
        ordered = filtered.sort_values(TIMESTAMP_COL)
        case_pairs: dict = {}
        for case_id, group in ordered.groupby(CASE_COL, sort=False):
            acts = group[ACTIVITY_COL].tolist()
            pairs = set()
            for i in range(len(acts) - 1):
                pairs.add((str(acts[i]), str(acts[i + 1])))
            case_pairs[case_id] = pairs

        required_set = {tuple(p) for p in (filters.required_edges or [])}
        forbidden_set = {tuple(p) for p in (filters.forbidden_edges or [])}

        def case_passes(pairs: set) -> bool:
            if required_set and not required_set.issubset(pairs):
                return False
            if forbidden_set and not pairs.isdisjoint(forbidden_set):
                return False
            return True

        keep_ids = [cid for cid, p in case_pairs.items() if case_passes(p)]
        filtered = filtered[filtered[CASE_COL].isin(keep_ids)]

    return filtered


@router.get("/filter-options/{event_log_id}")
async def get_filter_options(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Return available columns, activities, date range, and top attribute values for filtering."""
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "filter_options")
    if cached is not None:
        return cached

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    activities = sorted(df[ACTIVITY_COL].unique().tolist())

    # Start/end activities
    sorted_df = df.sort_values(TIMESTAMP_COL)
    first_acts = sorted_df.groupby(CASE_COL)[ACTIVITY_COL].first()
    last_acts = sorted_df.groupby(CASE_COL)[ACTIVITY_COL].last()
    start_activities = sorted(first_acts.unique().tolist())
    end_activities = sorted(last_acts.unique().tolist())

    # Date range
    date_min = str(df[TIMESTAMP_COL].min()) if len(df) > 0 else None
    date_max = str(df[TIMESTAMP_COL].max()) if len(df) > 0 else None

    # Case duration range
    case_dur = df.groupby(CASE_COL)[TIMESTAMP_COL].apply(lambda x: (x.max() - x.min()).total_seconds())
    dur_min = float(case_dur.min()) if len(case_dur) > 0 else 0
    dur_max = float(case_dur.max()) if len(case_dur) > 0 else 0

    # Filterable attribute columns (non-standard columns with <100 unique values)
    skip = {CASE_COL, ACTIVITY_COL, TIMESTAMP_COL}
    attributes = {}
    for col in df.columns:
        if col in skip:
            continue
        nunique = df[col].nunique()
        if 1 < nunique <= 100:
            attributes[col] = sorted(df[col].dropna().astype(str).unique().tolist())

    result = {
        "activities": activities,
        "start_activities": start_activities,
        "end_activities": end_activities,
        "date_min": date_min,
        "date_max": date_max,
        "duration_min": dur_min,
        "duration_max": dur_max,
        "attributes": attributes,
    }
    _set_cached(event_log_id, "filter_options", result)
    return result


@router.post("/discover", response_model=DiscoveryResponse)
async def discover_process(
    body: DiscoveryRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Run process discovery on an event log using the specified algorithm.
    Supported algorithms: dfg, alpha, heuristic, inductive.
    Accepts optional filters to subset the data before discovery.
    """
    filter_dict = body.filters.model_dump(exclude_none=True) if body.filters else {}
    cache_params = {"algorithm": body.algorithm, **body.parameters, "filters": filter_dict}
    await _assert_event_log_access(body.event_log_id, db, current_user)
    cached = _get_cached(body.event_log_id, "discover", cache_params)
    if cached is not None:
        return DiscoveryResponse(
            event_log_id=body.event_log_id,
            algorithm=body.algorithm,
            **cached,
        )

    event_log, df = await _load_event_log_and_df(body.event_log_id, db, current_user)
    df = _apply_filters(df, body.filters)

    if df.empty:
        return DiscoveryResponse(
            event_log_id=body.event_log_id,
            algorithm=body.algorithm,
            nodes=[],
            edges=[],
            statistics={},
        )

    try:
        result = await _run_in_thread(
            mining_engine.run_discovery,
            df=df, algorithm=body.algorithm, parameters=body.parameters,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        )
    except Exception as e:
        logger.error(f"Discovery failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Discovery analysis failed: {str(e)}",
        )

    _set_cached(body.event_log_id, "discover", result, cache_params)

    return DiscoveryResponse(
        event_log_id=body.event_log_id,
        algorithm=body.algorithm,
        nodes=result.get("nodes", []),
        edges=result.get("edges", []),
        statistics=result.get("statistics", {}),
    )


@router.get("/variants/{event_log_id}", response_model=VariantResponse)
async def get_variants(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Run variant analysis on the event log."""
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "variants")
    if cached is not None:
        return VariantResponse(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.run_variant_analysis, df)
    except Exception as e:
        logger.error(f"Variant analysis failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Variant analysis failed: {str(e)}",
        )

    _set_cached(event_log_id, "variants", result)
    return VariantResponse(**result)


@router.get("/bottlenecks/{event_log_id}", response_model=BottleneckResponse)
async def get_bottlenecks(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Run bottleneck analysis on the event log."""
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "bottlenecks")
    if cached is not None:
        return BottleneckResponse(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.run_bottleneck_analysis, df)
    except Exception as e:
        logger.error(f"Bottleneck analysis failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Bottleneck analysis failed: {str(e)}",
        )

    _set_cached(event_log_id, "bottlenecks", result)
    return BottleneckResponse(**result)


@router.get("/conformance/{event_log_id}", response_model=ConformanceResponse)
async def check_conformance(
    event_log_id: UUID,
    reference_model: str | None = Query(
        default=None,
        description="Optional reference model as JSON string",
    ),
    method: str = Query(
        default="auto",
        description=(
            "Conformance method: 'auto' (picks alignment for small logs, "
            "decomposed for large ones), 'token_replay' (fast), 'alignment' "
            "(strictly more accurate, ~10-100× slower), 'decomposed' "
            "(scales to 100k+ events), or 'footprints' (cheapest, "
            "structural only)."
        ),
    ),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Run conformance checking on the event log. Optionally provide a reference
    model as a JSON query parameter. If not provided, one is auto-discovered.
    """
    ref_model_dict = None
    if reference_model:
        try:
            ref_model_dict = json.loads(reference_model)
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="reference_model must be a valid JSON string",
            )

    if method not in {"auto", "token_replay", "alignment", "decomposed", "footprints", "jsd"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="method must be one of: auto, token_replay, alignment, decomposed, footprints, jsd",
        )

    cache_params = {"reference_model": ref_model_dict, "method": method}
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "conformance", cache_params)
    if cached is not None:
        return ConformanceResponse(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(
            mining_engine.run_conformance,
            df,
            reference_model=ref_model_dict,
            method=method,
        )
    except Exception as e:
        logger.error(f"Conformance checking failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Conformance checking failed: {str(e)}",
        )

    _set_cached(event_log_id, "conformance", result, cache_params)
    return ConformanceResponse(**result)


@router.get(
    "/conformance/{event_log_id}/stochastic",
    response_model=StochasticConformanceResponse,
)
async def check_stochastic_conformance(
    event_log_id: UUID,
    reference_model: str | None = Query(
        default=None,
        description="Optional reference model as JSON string",
    ),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Stochastic conformance via Earth Mover's Distance (EMD).

    Computes the EMD between the log's empirical variant distribution and
    the model's sampled stochastic language, giving a frequency-weighted
    fitness score that distinguishes a 0.1% deviation from a 30% deviation.

    Reference: Polyvyanyy et al., "Earth Movers' Stochastic Conformance"
    (Information Systems 2021); Leemans & Polyvyanyy, "Stochastic-aware
    precision and recall measures" (2023).

    Returns:
        emd_distance         – float in [0, 1], lower = better distributional fit
        stochastic_fitness   – 1 - emd_distance, higher = better
        top_deviating_variants – up to 20 variants sorted by |Δ| desc
        severity_breakdown   – minor / moderate / severe variant counts
        log_variants_count   – distinct variants in the log
        model_traces_sampled – traces sampled from the model
    """
    ref_model_dict = None
    if reference_model:
        try:
            ref_model_dict = json.loads(reference_model)
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="reference_model must be a valid JSON string",
            )

    cache_params = {"reference_model": ref_model_dict}
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "conformance_stochastic", cache_params)
    if cached is not None:
        return StochasticConformanceResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(
            mining_engine.compute_stochastic_conformance,
            df,
            reference_model=ref_model_dict,
        )
    except Exception as e:
        logger.error("Stochastic conformance failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Stochastic conformance failed: {str(e)}",
        )

    _set_cached(event_log_id, "conformance_stochastic", result, cache_params)
    return StochasticConformanceResponse(**result)


@router.get("/conformance/{event_log_id}/pdf")
async def conformance_pdf(
    event_log_id: UUID,
    method: str = Query(
        default="alignment",
        description="Conformance method used to build the report",
    ),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Generate a standardized PDF conformance report.

    Emits a reproducible layout — overview, fitness/precision/generalization
    gauges, per-case compliance count, deviation breakdown, and methodology —
    so reports can be compared across runs, tools, and teams.
    """
    from io import BytesIO
    from datetime import datetime, timezone
    from fastapi.responses import StreamingResponse

    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            SimpleDocTemplate,
            Paragraph,
            Spacer,
            Table,
            TableStyle,
            PageBreak,
        )
    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="reportlab is not installed — add it to requirements.txt and rebuild.",
        )

    if method not in {"auto", "token_replay", "alignment", "decomposed", "footprints", "jsd"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="method must be one of: auto, token_replay, alignment, decomposed, footprints, jsd",
        )

    await _assert_event_log_access(event_log_id, db, current_user)
    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    cache_params = {"reference_model": None, "method": method}
    cached = _get_cached(event_log_id, "conformance", cache_params)
    if cached is not None:
        result = cached
    else:
        try:
            result = await _run_in_thread(
                mining_engine.run_conformance,
                df,
                reference_model=None,
                method=method,
            )
        except Exception as e:
            logger.error("Conformance checking failed for PDF export: %s", e, exc_info=True)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Conformance checking failed: {e}",
            )
        _set_cached(event_log_id, "conformance", result, cache_params)

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=20 * mm,
        bottomMargin=20 * mm,
        title=f"FlowMiner Conformance Report — {event_log.name}",
        author="FlowMiner",
    )

    styles = getSampleStyleSheet()
    h1 = ParagraphStyle(
        "H1",
        parent=styles["Heading1"],
        fontSize=18,
        spaceAfter=6,
        textColor=colors.HexColor("#0f172a"),
    )
    h2 = ParagraphStyle(
        "H2",
        parent=styles["Heading2"],
        fontSize=13,
        spaceBefore=12,
        spaceAfter=4,
        textColor=colors.HexColor("#0f172a"),
    )
    body = ParagraphStyle(
        "Body",
        parent=styles["BodyText"],
        fontSize=9,
        leading=12,
        textColor=colors.HexColor("#1e293b"),
    )
    mono = ParagraphStyle(
        "Mono",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=8,
        textColor=colors.HexColor("#475569"),
    )

    story: list = []

    story.append(Paragraph("FlowMiner Conformance Report", h1))
    story.append(
        Paragraph(
            f"Event log: <b>{event_log.name}</b> · "
            f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
            body,
        )
    )
    story.append(Spacer(1, 6))

    # Summary metrics table — big, easy to scan
    fitness = result.get("fitness") or 0.0
    precision = result.get("precision")
    generalization = result.get("generalization")
    total_cases = result.get("total_cases") or 0
    conformant_cases = result.get("conformant_cases") or 0
    non_conformant = max(0, total_cases - conformant_cases)
    compliance_pct = (conformant_cases / total_cases * 100) if total_cases else 0.0

    def _fmt_score(v):
        if v is None:
            return "—"
        return f"{v:.3f}"

    def _score_color(v):
        if v is None:
            return colors.HexColor("#94a3b8")
        if v >= 0.85:
            return colors.HexColor("#10b981")
        if v >= 0.6:
            return colors.HexColor("#f59e0b")
        return colors.HexColor("#ef4444")

    metrics_data = [
        ["Metric", "Value", "Interpretation"],
        ["Fitness", _fmt_score(fitness), _fitness_interpretation(fitness)],
        ["Precision", _fmt_score(precision), _precision_interpretation(precision)],
        ["Generalization", _fmt_score(generalization), _generalization_interpretation(generalization)],
        ["Simplicity", "—", "Not computed in this run."],
    ]
    metrics_table = Table(
        metrics_data,
        colWidths=[35 * mm, 25 * mm, 110 * mm],
    )
    metrics_table.setStyle(
        TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e293b")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#f8fafc")),
            ("TEXTCOLOR", (1, 1), (1, 1), _score_color(fitness)),
            ("TEXTCOLOR", (1, 2), (1, 2), _score_color(precision)),
            ("TEXTCOLOR", (1, 3), (1, 3), _score_color(generalization)),
            ("FONTNAME", (1, 1), (1, -1), "Helvetica-Bold"),
            ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ])
    )
    story.append(metrics_table)
    story.append(Spacer(1, 10))

    # Case-level compliance block
    story.append(Paragraph("Case-level compliance", h2))
    compliance_data = [
        ["Total cases", f"{total_cases:,}"],
        ["Conformant cases", f"{conformant_cases:,}"],
        ["Non-conformant cases", f"{non_conformant:,}"],
        ["Compliance rate", f"{compliance_pct:.1f}%"],
    ]
    compliance_table = Table(compliance_data, colWidths=[60 * mm, 40 * mm])
    compliance_table.setStyle(
        TableStyle([
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("FONTNAME", (0, 0), (0, -1), "Helvetica"),
            ("FONTNAME", (1, 0), (1, -1), "Helvetica-Bold"),
            ("LINEBELOW", (0, 0), (-1, -2), 0.25, colors.HexColor("#e2e8f0")),
            ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#334155")),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ])
    )
    story.append(compliance_table)
    story.append(Spacer(1, 10))

    # Deviation breakdown
    deviations = result.get("deviations") or []
    story.append(Paragraph("Deviations", h2))
    if not deviations:
        story.append(Paragraph("No deviations detected — every case is conformant.", body))
    else:
        # Count by type
        counts: dict[str, int] = {}
        activity_counts: dict[str, int] = {}
        for d in deviations:
            dtype = d.get("deviation_type") or "unknown"
            counts[dtype] = counts.get(dtype, 0) + 1
            activity = d.get("activity")
            if activity:
                activity_counts[activity] = activity_counts.get(activity, 0) + 1

        breakdown_rows = [["Type", "Count", "Share"]]
        total_dev = sum(counts.values()) or 1
        for dtype, cnt in sorted(counts.items(), key=lambda x: -x[1]):
            pct = cnt / total_dev * 100
            breakdown_rows.append([dtype.replace("_", " ").title(), f"{cnt:,}", f"{pct:.1f}%"])
        breakdown_table = Table(breakdown_rows, colWidths=[70 * mm, 30 * mm, 30 * mm])
        breakdown_table.setStyle(
            TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ])
        )
        story.append(breakdown_table)
        story.append(Spacer(1, 8))

        if activity_counts:
            story.append(Paragraph("Top activities involved in deviations", h2))
            top_activities = sorted(activity_counts.items(), key=lambda x: -x[1])[:10]
            act_rows = [["Activity", "Deviation count"]]
            for act, cnt in top_activities:
                act_rows.append([act, f"{cnt:,}"])
            act_table = Table(act_rows, colWidths=[100 * mm, 30 * mm])
            act_table.setStyle(
                TableStyle([
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("FONTSIZE", (0, 0), (-1, -1), 9),
                    ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
                    ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ])
            )
            story.append(act_table)
            story.append(Spacer(1, 8))

    # Methodology — critical for comparability across runs/tools
    story.append(PageBreak())
    story.append(Paragraph("Methodology", h1))
    story.append(
        Paragraph(
            f"This report was generated by FlowMiner using the "
            f"<b>{method}</b> conformance method. The reference process "
            "model was discovered from the event log via the pm4py "
            "Inductive Miner unless a reference model was explicitly "
            "provided.",
            body,
        )
    )
    story.append(Spacer(1, 6))
    story.append(
        Paragraph(
            "<b>Fitness</b> measures how well the event log can be replayed "
            "on the model. 1.0 means every case replays without deviation. "
            "Token-replay fitness is fast but imprecise on models with "
            "invisible transitions; alignment-based fitness is strictly more "
            "accurate but ~10–100× slower.",
            body,
        )
    )
    story.append(Spacer(1, 4))
    story.append(
        Paragraph(
            "<b>Precision</b> measures how much additional behavior the "
            "model allows beyond what's observed in the log. 1.0 means the "
            "model is tight; 0.0 means it allows any sequence.",
            body,
        )
    )
    story.append(Spacer(1, 4))
    story.append(
        Paragraph(
            "<b>Generalization</b> measures how well the model handles "
            "unseen behavior. High generalization correlates with low "
            "overfitting.",
            body,
        )
    )
    story.append(Spacer(1, 10))
    story.append(
        Paragraph(
            f"Report ID: <font name='Helvetica-Bold'>{event_log_id}</font> · "
            f"Events: {len(df):,} · Cases: {total_cases:,} · "
            f"Method: {method}",
            mono,
        )
    )

    doc.build(story)
    buf.seek(0)

    filename = f"conformance_{event_log.name.replace(' ', '_')}_{method}.pdf"
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _fitness_interpretation(v):
    if v is None:
        return "Could not compute."
    if v >= 0.95:
        return "Excellent — model replays almost perfectly."
    if v >= 0.85:
        return "Good — minor deviations present."
    if v >= 0.6:
        return "Fair — significant deviations; investigate."
    return "Poor — the model does not match reality."


def _precision_interpretation(v):
    if v is None:
        return "Not computed (common for alignment-based runs)."
    if v >= 0.85:
        return "Tight model — allows only observed behavior."
    if v >= 0.6:
        return "Loose model — some unused paths."
    return "Underfitting — model permits too much behavior."


def _generalization_interpretation(v):
    if v is None:
        return "Not computed for this method."
    if v >= 0.85:
        return "Generalizes well to unseen cases."
    if v >= 0.6:
        return "Moderate generalization."
    return "Overfits the log — may miss legitimate variation."


@router.get("/counterfactual/{event_log_id}")
async def get_counterfactual(
    event_log_id: UUID,
    case_id: str = Query(..., description="Case ID to generate a counterfactual for"),
    max_generations: int = Query(20, ge=5, le=100),
    population_size: int = Query(32, ge=8, le=128),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Generate a temporally-constrained counterfactual for a case.

    Runs a small genetic algorithm (insert/delete/swap/replace) to
    find the minimum-edit rewrite of the case's trace that becomes
    conformant against the discovered reference model, while
    respecting mined *"A must precede B"* temporal constraints.

    Inspired by Buliga et al. (AAAI 2025, arXiv:2503.01792) — the
    first counterfactual PM approach that guarantees LTLp-style
    temporal validity on the generated explanations.
    """
    from app.services.counterfactual import generate_counterfactual

    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(
            generate_counterfactual,
            df,
            case_id,
            None,
            max_generations,
            population_size,
        )
    except Exception as e:
        logger.error("Counterfactual generation failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Counterfactual generation failed: {e}",
        )
    return result


@router.get("/causal-dag/{event_log_id}")
async def get_causal_dag(
    event_log_id: UUID,
    top_k: int = Query(20, ge=5, le=50),
    threshold: float = Query(0.1, ge=0.0, le=1.0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Discover a causal DAG of activity dwell-time dependencies.

    Implements Fournier et al. (KI 2025, arXiv:2310.14975) — runs
    DirectLiNGAM over per-case activity durations to infer a DAG of
    *true* cause-effect dependencies between activities. Each edge has
    a standardized weight: positive means the source activity slows
    down the target; negative means it speeds it up.

    Unlike the control-flow DFG (which only shows "what happens after
    what") this answers *"why"* — if adding a step to an upstream
    activity systematically slows down a downstream one, the edge
    shows up here even when the DFG doesn't connect them directly.
    """
    from app.services.causal import discover_causal_dag

    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "causal_dag", {"top_k": top_k, "threshold": threshold})
    if cached is not None:
        return cached

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(discover_causal_dag, df, top_k, threshold)
    except Exception as e:
        logger.error("Causal DAG discovery failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Causal DAG discovery failed: {e}",
        )

    _set_cached(event_log_id, "causal_dag", result, {"top_k": top_k, "threshold": threshold})
    return result


@router.get("/root-cause/{event_log_id}", response_model=RootCauseResponse)
async def get_root_causes(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Run root cause analysis on the event log."""
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "root_cause")
    if cached is not None:
        return RootCauseResponse(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.run_root_cause_analysis, df)
    except Exception as e:
        logger.error(f"Root cause analysis failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Root cause analysis failed: {str(e)}",
        )

    _set_cached(event_log_id, "root_cause", result)
    return RootCauseResponse(**result)


@router.get("/statistics/{event_log_id}", response_model=ProcessStatistics)
async def get_statistics(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Compute comprehensive process statistics for the event log."""
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "statistics")
    if cached is not None:
        return ProcessStatistics(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.compute_statistics, df)
    except Exception as e:
        logger.error(f"Statistics computation failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Statistics computation failed: {str(e)}",
        )

    _set_cached(event_log_id, "statistics", result)
    return ProcessStatistics(**result)


@router.get("/summary/{event_log_id}", response_model=ProcessSummary)
async def get_summary(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Generate a full auto-analysis summary including statistics, top variants,
    bottlenecks, and the process map.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "summary")
    if cached is not None:
        return ProcessSummary(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.generate_summary, df)
        # Ensure the process_map includes event_log_id and algorithm
        process_map = result.get("process_map", {})
        process_map["event_log_id"] = str(event_log_id)
        process_map["algorithm"] = "dfg"
        result["process_map"] = process_map
    except Exception as e:
        logger.error(f"Summary generation failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Summary generation failed: {str(e)}",
        )

    _set_cached(event_log_id, "summary", result)
    return ProcessSummary(**result)


@router.get("/cases/{event_log_id}", response_model=CaseListResponse)
async def get_cases(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Return a list of cases with summary data (event count, duration, start/end
    activity, variant). Limited to the first 1000 cases for performance.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "cases")
    if cached is not None:
        return CaseListResponse(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_cases, df)
    except Exception as e:
        logger.error(f"Case list failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Case list failed: {str(e)}",
        )

    _set_cached(event_log_id, "cases", result)
    return CaseListResponse(**result)


@router.get("/cases/{event_log_id}/{case_id}", response_model=CaseDetailResponse)
async def get_case_detail(
    event_log_id: UUID,
    case_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Return all events for a specific case, including resource and duration to
    the next event for each row.
    """
    cache_params = {"case_id": case_id}
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "case_detail", cache_params)
    if cached is not None:
        return CaseDetailResponse(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_case_detail, df, case_id=case_id)
    except Exception as e:
        logger.error(f"Case detail failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Case detail failed: {str(e)}",
        )

    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Case '{case_id}' not found in event log",
        )

    _set_cached(event_log_id, "case_detail", result, cache_params)
    return CaseDetailResponse(**result)


@router.get("/timeline/{event_log_id}", response_model=TimelineResponse)
async def get_timeline(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Return events sorted by timestamp for animation replay. Each event includes
    the previous activity for that case (source) so the UI can animate the
    token traversing the correct process-map edge. Limited to the first 5000
    events for performance.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "timeline")
    if cached is not None:
        return TimelineResponse(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_timeline, df)
    except Exception as e:
        logger.error(f"Timeline failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Timeline failed: {str(e)}",
        )

    _set_cached(event_log_id, "timeline", result)
    return TimelineResponse(**result)


@router.get("/edges/{event_log_id}")
async def get_edge_stats(
    event_log_id: UUID,
    source: str = Query(..., description="Source activity"),
    target: str = Query(..., description="Target activity"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Return statistics for a single (source, target) directly-follows edge:
    frequency, case coverage, duration quantiles, and a histogram of
    transition durations. Feeds the edge-detail popover in the process map.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cache_key = f"edges:{source}→{target}"
    cached = _get_cached(event_log_id, cache_key)
    if cached is not None:
        return cached

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(
            mining_engine.get_edge_stats, df, source, target
        )
    except Exception as e:
        logger.error(f"Edge stats failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Edge stats failed: {str(e)}",
        )

    _set_cached(event_log_id, cache_key, result)
    return result


@router.get("/export-bpmn/{event_log_id}", response_model=BPMNExportResponse)
async def export_bpmn(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Discover a process model using the Inductive Miner and export it as BPMN XML.
    The resulting XML string is returned in the JSON response body.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "export_bpmn")
    if cached is not None:
        return BPMNExportResponse(event_log_id=event_log_id, **cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        import tempfile

        import pm4py
        from pm4py.objects.bpmn.exporter import exporter as bpmn_exporter

        net, im, fm = pm4py.discover_petri_net_inductive(
            df,
            case_id_key="case:concept:name",
            activity_key="concept:name",
            timestamp_key="time:timestamp",
        )
        bpmn_model = pm4py.convert_to_bpmn(net, im, fm)

        # Apply graphviz layout so shapes get proper x/y coordinates
        from pm4py.objects.bpmn.layout import layouter as bpmn_layouter
        bpmn_model = bpmn_layouter.apply(bpmn_model)

        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".bpmn", delete=False) as tmp:
                tmp_path = tmp.name
            bpmn_exporter.apply(bpmn_model, tmp_path)
            with open(tmp_path, "r") as f:
                bpmn_xml = f.read()
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)

        # Fix pm4py's tiny shapes — enlarge task bounds so labels fit inside
        import re
        def _enlarge_bounds(match: re.Match) -> str:
            h = float(match.group(1))
            w = float(match.group(2))
            x = float(match.group(3))
            y = float(match.group(4))
            # Only enlarge task shapes (not gateways/events which are small)
            if w <= 60 and h <= 40:
                new_w = max(w, 120)
                new_h = max(h, 60)
                # Recenter: shift x,y so the center stays the same
                x -= (new_w - w) / 2
                y -= (new_h - h) / 2
                w = new_w
                h = new_h
            return f'height="{h}" width="{w}" x="{x}" y="{y}"'

        bpmn_xml = re.sub(
            r'height="([\d.]+)"\s+width="([\d.]+)"\s+x="([\-\d.]+)"\s+y="([\-\d.]+)"',
            _enlarge_bounds,
            bpmn_xml,
        )

    except Exception as e:
        logger.error(f"BPMN export failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"BPMN export failed: {str(e)}",
        )

    result = {"bpmn_xml": bpmn_xml, "algorithm": "inductive"}
    _set_cached(event_log_id, "export_bpmn", result)
    return BPMNExportResponse(event_log_id=event_log_id, **result)


@router.get("/dotted-chart/{event_log_id}", response_model=DottedChartResponse)
async def get_dotted_chart(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Return event data for a dotted chart visualization. Each event includes a
    numeric case_index for Y-axis positioning based on first-occurrence order.
    Limited to the first 10,000 events.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "dotted_chart")
    if cached is not None:
        return DottedChartResponse(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_dotted_chart, df)
    except Exception as e:
        logger.error(f"Dotted chart failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Dotted chart failed: {str(e)}",
        )

    _set_cached(event_log_id, "dotted_chart", result)
    return DottedChartResponse(**result)


@router.get("/social-network/{event_log_id}", response_model=SocialNetworkResponse)
async def get_social_network(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Return a handover-of-work social network between resources. Nodes are
    resources; edges represent handovers between consecutive resources within a
    case. If no resource column is present, an empty network is returned.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "social_network")
    if cached is not None:
        return SocialNetworkResponse(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_social_network, df)
    except Exception as e:
        logger.error(f"Social network analysis failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Social network analysis failed: {str(e)}",
        )

    _set_cached(event_log_id, "social_network", result)
    return SocialNetworkResponse(**result)


@router.post("/compare", response_model=ComparisonResponse)
async def compare_process(
    body: ComparisonRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Compare two subsets of the same event log split by a column attribute.
    Returns merged DFG nodes and edges with frequency diffs and status labels
    (added, removed, increased, decreased, unchanged).
    """
    cache_params = {
        "split_attribute": body.split_attribute,
        "split_value_a": body.split_value_a,
        "split_value_b": body.split_value_b,
    }
    await _assert_event_log_access(body.event_log_id, db, current_user)
    cached = _get_cached(body.event_log_id, "compare", cache_params)
    if cached is not None:
        return ComparisonResponse(**cached)

    event_log, df = await _load_event_log_and_df(body.event_log_id, db, current_user)

    try:
        result = await _run_in_thread(
            mining_engine.compare_process,
            df=df,
            split_attribute=body.split_attribute,
            split_value_a=body.split_value_a,
            split_value_b=body.split_value_b,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        )
    except Exception as e:
        logger.error(f"Process comparison failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Process comparison failed: {str(e)}",
        )

    _set_cached(body.event_log_id, "compare", result, cache_params)
    return ComparisonResponse(**result)


@router.get("/rework/{event_log_id}", response_model=ReworkResponse)
async def get_rework(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Detect rework (activities repeated within a case) and self-loops
    (consecutive identical activities). Returns per-activity rework rates and
    overall rework statistics.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "rework")
    if cached is not None:
        return ReworkResponse(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_rework, df)
    except Exception as e:
        logger.error(f"Rework detection failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Rework detection failed: {str(e)}",
        )

    _set_cached(event_log_id, "rework", result)
    return ReworkResponse(**result)


@router.post("/simulate", response_model=SimulationResponse)
async def simulate_process(
    body: SimulationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Run a what-if process simulation on an event log.

    Discovers a Petri net from the original log using the Inductive Miner,
    generates a synthetic baseline via Petri net playout, applies the requested
    modifications (duration scaling, activity removal, frequency adjustment), and
    returns side-by-side statistics for the original and simulated logs together
    with improvement metrics.
    """
    cache_params = {
        "num_traces": body.num_traces,
        "modifications": [m.model_dump() for m in body.modifications],
    }
    await _assert_event_log_access(body.event_log_id, db, current_user)
    cached = _get_cached(body.event_log_id, "simulate", cache_params)
    if cached is not None:
        return SimulationResponse(**cached)

    event_log, df = await _load_event_log_and_df(body.event_log_id, db, current_user)

    try:
        result = await _run_in_thread(
            mining_engine.run_simulation,
            df=df,
            modifications=[m.model_dump() for m in body.modifications],
            num_traces=body.num_traces,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        )
    except Exception as e:
        logger.error(f"Process simulation failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Process simulation failed: {str(e)}",
        )

    _set_cached(body.event_log_id, "simulate", result, cache_params)
    return SimulationResponse(**result)


@router.post("/simulate/monte-carlo")
async def simulate_monte_carlo(
    body: SimulationRequest,
    iterations: int = Query(20, ge=3, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Run the simulation ``iterations`` times and return mean + percentile
    bands for the key KPIs. Used by the frontend to render confidence
    intervals on the simulation page.

    Each iteration perturbs the duration scaling and rework rate slightly
    (normal noise with sigma=0.08) so you get a meaningful spread even
    when the input spec is deterministic.
    """
    import random
    import statistics

    await _assert_event_log_access(body.event_log_id, db, current_user)
    event_log, df = await _load_event_log_and_df(body.event_log_id, db, current_user)

    base_mods = [m.model_dump() for m in body.modifications]
    samples = {
        "avg_case_duration_seconds": [],
        "rework_rate": [],
        "variant_count": [],
        "case_count": [],
    }

    for i in range(iterations):
        jittered = []
        for m in base_mods:
            mj = dict(m)
            if mj.get("type") == "duration_scale" and "value" in mj:
                try:
                    mj["value"] = float(mj["value"]) * random.gauss(1.0, 0.08)
                except Exception:
                    pass
            jittered.append(mj)

        try:
            run = await _run_in_thread(
                mining_engine.run_simulation,
                df=df,
                modifications=jittered,
                num_traces=body.num_traces,
            )
        except Exception as e:
            logger.warning("monte-carlo iteration %s failed: %s", i, e)
            continue

        sim = run.get("simulated") or {}
        samples["avg_case_duration_seconds"].append(float(sim.get("avg_case_duration_seconds", 0)))
        samples["rework_rate"].append(float(sim.get("rework_rate", 0)))
        samples["variant_count"].append(int(sim.get("variant_count", 0)))
        samples["case_count"].append(int(sim.get("case_count", 0)))

    def _band(xs: list[float]) -> dict:
        if not xs:
            return {"mean": 0, "p05": 0, "p50": 0, "p95": 0, "stdev": 0, "n": 0}
        xs_sorted = sorted(xs)
        return {
            "mean": statistics.mean(xs),
            "p05": xs_sorted[max(0, int(0.05 * len(xs_sorted)))],
            "p50": statistics.median(xs_sorted),
            "p95": xs_sorted[min(len(xs_sorted) - 1, int(0.95 * len(xs_sorted)))],
            "stdev": statistics.stdev(xs) if len(xs) > 1 else 0.0,
            "n": len(xs),
        }

    return {
        "iterations_attempted": iterations,
        "iterations_succeeded": len(samples["avg_case_duration_seconds"]),
        "bands": {k: _band(v) for k, v in samples.items()},
    }


@router.get("/activity-detail/{event_log_id}/{activity_name}", response_model=ActivityDetailResponse)
async def get_activity_detail(
    event_log_id: UUID,
    activity_name: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Return detailed statistics for a single activity: frequency, case count,
    duration statistics, a 10-bin histogram, resource distribution, predecessor
    and successor activities from the DFG, and start/end flags.
    """
    cache_params = {"activity_name": activity_name}
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "activity_detail", cache_params)
    if cached is not None:
        return ActivityDetailResponse(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_activity_detail, df, activity_name=activity_name)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=str(e)
        )
    except Exception as e:
        logger.error(f"Activity detail failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Activity detail failed: {str(e)}",
        )

    _set_cached(event_log_id, "activity_detail", result, cache_params)
    return ActivityDetailResponse(**result)


@router.get("/quality/{event_log_id}", response_model=DataQualityResponse)
async def get_data_quality(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Run a data quality report on the event log.

    Checks for missing values, duplicate events, timestamp anomalies,
    single-event cases, high-frequency catch-all activities, and rare
    activities. Returns a scored summary with individual issues.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "quality")
    if cached is not None:
        return DataQualityResponse(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    from app.services.ingestion import CASE_COL, ACTIVITY_COL, TIMESTAMP_COL
    import pandas as pd
    from datetime import timezone

    total_events = len(df)
    issues: list[DataQualityIssue] = []

    # --- 1. Missing values in key columns ---
    for col_name, col_const in [
        ("case_id", CASE_COL),
        ("activity", ACTIVITY_COL),
        ("timestamp", TIMESTAMP_COL),
    ]:
        if col_const not in df.columns:
            continue
        null_count = int(df[col_const].isna().sum())
        if null_count > 0:
            pct = round(100.0 * null_count / total_events, 2) if total_events else 0.0
            issues.append(
                DataQualityIssue(
                    severity="error",
                    category="missing_values",
                    message=f"Missing values in '{col_name}' column: {null_count} events affected",
                    affected_count=null_count,
                    affected_percentage=pct,
                )
            )

    # --- 2. Duplicate events (same case_id + activity + timestamp) ---
    dup_mask = df.duplicated(subset=[CASE_COL, ACTIVITY_COL, TIMESTAMP_COL], keep=False)
    dup_count = int(dup_mask.sum())
    if dup_count > 0:
        pct = round(100.0 * dup_count / total_events, 2) if total_events else 0.0
        issues.append(
            DataQualityIssue(
                severity="warning",
                category="duplicates",
                message=f"{dup_count} duplicate events (same case, activity, timestamp)",
                affected_count=dup_count,
                affected_percentage=pct,
            )
        )

    # --- 3. Timestamp issues ---
    ts_col = df[TIMESTAMP_COL].dropna()

    # Future timestamps
    try:
        now = pd.Timestamp.now(tz="UTC")
        ts_utc = ts_col
        if ts_utc.dt.tz is None:
            ts_utc = ts_utc.dt.tz_localize("UTC")
        else:
            ts_utc = ts_utc.dt.tz_convert("UTC")
        future_count = int((ts_utc > now).sum())
        if future_count > 0:
            pct = round(100.0 * future_count / total_events, 2)
            issues.append(
                DataQualityIssue(
                    severity="warning",
                    category="timestamps",
                    message=f"{future_count} events have timestamps in the future",
                    affected_count=future_count,
                    affected_percentage=pct,
                )
            )
    except Exception:
        pass

    # Pre-2000 timestamps
    try:
        cutoff = pd.Timestamp("2000-01-01", tz="UTC")
        ts_utc2 = ts_col
        if ts_utc2.dt.tz is None:
            ts_utc2 = ts_utc2.dt.tz_localize("UTC")
        else:
            ts_utc2 = ts_utc2.dt.tz_convert("UTC")
        old_count = int((ts_utc2 < cutoff).sum())
        if old_count > 0:
            pct = round(100.0 * old_count / total_events, 2)
            issues.append(
                DataQualityIssue(
                    severity="info",
                    category="timestamps",
                    message=f"{old_count} events have timestamps before year 2000",
                    affected_count=old_count,
                    affected_percentage=pct,
                )
            )
    except Exception:
        pass

    # Out-of-order events within a case
    try:
        sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL])
        prev_ts = sorted_df.groupby(CASE_COL)[TIMESTAMP_COL].shift(1)
        out_of_order = int((sorted_df[TIMESTAMP_COL] < prev_ts).sum())
        if out_of_order > 0:
            pct = round(100.0 * out_of_order / total_events, 2)
            issues.append(
                DataQualityIssue(
                    severity="warning",
                    category="timestamps",
                    message=f"{out_of_order} events are out of chronological order within their case",
                    affected_count=out_of_order,
                    affected_percentage=pct,
                )
            )
    except Exception:
        pass

    # --- 4. Single-event cases ---
    case_sizes = df.groupby(CASE_COL).size()
    single_event_cases = int((case_sizes == 1).sum())
    total_cases = int(case_sizes.shape[0])
    if single_event_cases > 0:
        pct = round(100.0 * single_event_cases / total_cases, 2) if total_cases else 0.0
        issues.append(
            DataQualityIssue(
                severity="warning",
                category="outliers",
                message=f"{single_event_cases} cases contain only 1 event (cannot mine a process from them)",
                affected_count=single_event_cases,
                affected_percentage=pct,
            )
        )

    # --- 5. High-frequency activities (>90% of events) ---
    activity_counts = df[ACTIVITY_COL].value_counts()
    for activity, count in activity_counts.items():
        pct = 100.0 * count / total_events if total_events else 0.0
        if pct > 90.0:
            issues.append(
                DataQualityIssue(
                    severity="info",
                    category="outliers",
                    message=(
                        f"Activity '{activity}' appears in {pct:.1f}% of events — "
                        "may be a catch-all category"
                    ),
                    affected_count=int(count),
                    affected_percentage=round(pct, 2),
                )
            )

    # --- 6. Rare activities (<1% of events) ---
    rare_activities = [
        (act, cnt)
        for act, cnt in activity_counts.items()
        if (100.0 * cnt / total_events if total_events else 0.0) < 1.0
    ]
    if rare_activities:
        rare_count = sum(cnt for _, cnt in rare_activities)
        pct = round(100.0 * rare_count / total_events, 2) if total_events else 0.0
        issues.append(
            DataQualityIssue(
                severity="info",
                category="outliers",
                message=(
                    f"{len(rare_activities)} activities appear in <1% of events "
                    f"({rare_count} total events affected)"
                ),
                affected_count=rare_count,
                affected_percentage=pct,
            )
        )

    # --- Score: start at 100, subtract per severity ---
    _DEDUCTIONS = {"error": 20, "warning": 10, "info": 5}
    score = 100.0
    for issue in issues:
        score -= _DEDUCTIONS.get(issue.severity, 0)
    score = max(0.0, score)

    result = {
        "overall_score": round(score, 1),
        "total_events": total_events,
        "issues": [i.model_dump() for i in issues],
    }
    _set_cached(event_log_id, "quality", result)
    return DataQualityResponse(**result)


@router.get("/report/{event_log_id}", response_model=ReportResponse)
async def generate_report(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Generate an HTML process mining report for the event log.

    Runs statistics, variant analysis, and bottleneck analysis then returns
    a self-contained HTML string with inline CSS. The frontend can open this
    in a new window and call window.print() to produce a PDF.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "report")
    if cached is not None:
        return ReportResponse(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        from datetime import date

        stats_raw = await _run_in_thread(mining_engine.compute_statistics, df)
        variants_raw = await _run_in_thread(mining_engine.run_variant_analysis, df)
        bottlenecks_raw = await _run_in_thread(mining_engine.run_bottleneck_analysis, df)
    except Exception as e:
        logger.error(f"Report generation failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Report generation failed: {str(e)}",
        )

    def _fmt_duration(seconds: float | None) -> str:
        if seconds is None:
            return "N/A"
        if seconds < 60:
            return f"{seconds:.1f}s"
        if seconds < 3600:
            return f"{seconds / 60:.1f}m"
        if seconds < 86400:
            return f"{seconds / 3600:.1f}h"
        return f"{seconds / 86400:.1f}d"

    log_name = event_log.name
    report_date = date.today().isoformat()

    # --- Summary stats table ---
    total_cases = stats_raw.get("total_cases", 0)
    total_events = stats_raw.get("total_events", 0)
    total_activities = stats_raw.get("total_activities", 0)
    avg_dur = _fmt_duration(stats_raw.get("avg_case_duration"))

    stats_rows = "".join(
        f"<tr><td>{label}</td><td><strong>{value}</strong></td></tr>"
        for label, value in [
            ("Total Cases", f"{total_cases:,}"),
            ("Total Events", f"{total_events:,}"),
            ("Unique Activities", f"{total_activities:,}"),
            ("Avg Case Duration", avg_dur),
            ("Median Case Duration", _fmt_duration(stats_raw.get("median_case_duration"))),
            ("Min Case Duration", _fmt_duration(stats_raw.get("min_case_duration"))),
            ("Max Case Duration", _fmt_duration(stats_raw.get("max_case_duration"))),
        ]
    )

    # --- Top 5 variants ---
    top_variants = variants_raw.get("variants", [])[:5]
    variant_rows = ""
    for v in top_variants:
        activities_flow = " &rarr; ".join(v.get("activities", []))
        freq = v.get("frequency", 0)
        pct = v.get("percentage", 0.0)
        avg_v = _fmt_duration(v.get("avg_duration"))
        variant_rows += (
            f"<tr>"
            f"<td style='word-break:break-word;max-width:400px'>{activities_flow}</td>"
            f"<td style='text-align:center'>{freq:,}</td>"
            f"<td style='text-align:center'>{pct:.1f}%</td>"
            f"<td style='text-align:center'>{avg_v}</td>"
            f"</tr>"
        )
    if not variant_rows:
        variant_rows = "<tr><td colspan='4' style='text-align:center;color:#888'>No variants found</td></tr>"

    # --- Bottleneck table ---
    bottlenecks = bottlenecks_raw.get("bottlenecks", [])
    bottleneck_rows = ""
    severity_colors = {
        "critical": "#c0392b",
        "high": "#e67e22",
        "medium": "#f39c12",
        "low": "#27ae60",
    }
    for b in bottlenecks:
        color = severity_colors.get(b.get("severity", "low"), "#27ae60")
        flag = " &#9888;" if b.get("is_bottleneck") else ""
        bottleneck_rows += (
            f"<tr>"
            f"<td>{b.get('activity', '')}{flag}</td>"
            f"<td style='text-align:center'>{_fmt_duration(b.get('avg_duration'))}</td>"
            f"<td style='text-align:center'>{b.get('frequency', 0):,}</td>"
            f"<td style='text-align:center;color:{color};font-weight:bold'>"
            f"{b.get('severity', '').capitalize()}</td>"
            f"</tr>"
        )
    if not bottleneck_rows:
        bottleneck_rows = (
            "<tr><td colspan='4' style='text-align:center;color:#888'>No bottleneck data</td></tr>"
        )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>FlowMiner Report — {log_name}</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px;
         color: #222; background: #fff; padding: 32px 40px; }}
  h1 {{ font-size: 22px; color: #1a2e4a; margin-bottom: 4px; }}
  h2 {{ font-size: 15px; color: #1a2e4a; margin: 28px 0 10px; border-bottom: 2px solid #3498db;
        padding-bottom: 4px; }}
  .meta {{ font-size: 12px; color: #666; margin-bottom: 24px; }}
  table {{ width: 100%; border-collapse: collapse; margin-bottom: 8px; }}
  th {{ background: #2c3e50; color: #fff; padding: 8px 10px; text-align: left;
        font-size: 12px; }}
  td {{ padding: 7px 10px; border-bottom: 1px solid #e8e8e8; vertical-align: top; }}
  tr:nth-child(even) td {{ background: #f7f9fc; }}
  .score-badge {{ display: inline-block; padding: 2px 10px; border-radius: 12px;
                  font-weight: bold; font-size: 12px; }}
  footer {{ margin-top: 40px; padding-top: 12px; border-top: 1px solid #ddd;
            font-size: 11px; color: #999; text-align: center; }}
  @media print {{
    body {{ padding: 16px 20px; }}
    h2 {{ page-break-after: avoid; }}
    table {{ page-break-inside: avoid; }}
  }}
</style>
</head>
<body>
<h1>Process Mining Report</h1>
<p class="meta">
  <strong>Event Log:</strong> {log_name} &nbsp;&bull;&nbsp;
  <strong>Generated:</strong> {report_date} &nbsp;&bull;&nbsp;
  <strong>Generated by:</strong> FlowMiner
</p>

<h2>Summary Statistics</h2>
<table>
  <thead><tr><th>Metric</th><th>Value</th></tr></thead>
  <tbody>{stats_rows}</tbody>
</table>

<h2>Top 5 Process Variants</h2>
<table>
  <thead>
    <tr>
      <th>Activity Flow</th>
      <th style="text-align:center">Cases</th>
      <th style="text-align:center">Coverage</th>
      <th style="text-align:center">Avg Duration</th>
    </tr>
  </thead>
  <tbody>{variant_rows}</tbody>
</table>

<h2>Bottleneck Analysis</h2>
<table>
  <thead>
    <tr>
      <th>Activity</th>
      <th style="text-align:center">Avg Duration</th>
      <th style="text-align:center">Frequency</th>
      <th style="text-align:center">Severity</th>
    </tr>
  </thead>
  <tbody>{bottleneck_rows}</tbody>
</table>

<footer>Generated by <strong>FlowMiner</strong> &mdash; Open-source Process Mining Platform &mdash; {report_date}</footer>
</body>
</html>"""

    result = {"html": html, "event_log_name": log_name}
    _set_cached(event_log_id, "report", result)
    return ReportResponse(**result)


# ---------------------------------------------------------------------------
# 1. Performance DFG
# ---------------------------------------------------------------------------

@router.get("/performance-dfg/{event_log_id}", response_model=PerformanceDFGResponse)
async def get_performance_dfg(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Discover a performance DFG where each edge carries the average transition
    duration in seconds between the two activities.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "performance_dfg")
    if cached is not None:
        return PerformanceDFGResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_performance_dfg, df)
    except Exception as e:
        logger.error(f"Performance DFG failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Performance DFG failed: {str(e)}",
        )

    _set_cached(event_log_id, "performance_dfg", result)
    return PerformanceDFGResponse(**result)


# ---------------------------------------------------------------------------
# 2. Eventually-Follows Graph
# ---------------------------------------------------------------------------

@router.get("/efg/{event_log_id}", response_model=EFGResponse)
async def get_efg(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Discover the Eventually-Follows Graph: all activity pairs (a, b) where a
    eventually precedes b within a case, with occurrence counts.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "efg")
    if cached is not None:
        return EFGResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_efg, df)
    except Exception as e:
        logger.error(f"EFG discovery failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"EFG discovery failed: {str(e)}",
        )

    _set_cached(event_log_id, "efg", result)
    return EFGResponse(**result)


# ---------------------------------------------------------------------------
# 3. Temporal Profile
# ---------------------------------------------------------------------------

@router.get("/temporal-profile/{event_log_id}", response_model=TemporalProfileResponse)
async def get_temporal_profile(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Discover a temporal profile (mean and stdev of time between activity pairs)
    and flag cases/pairs that deviate by more than 2 standard deviations.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "temporal_profile")
    if cached is not None:
        return TemporalProfileResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_temporal_profile, df)
    except Exception as e:
        logger.error(f"Temporal profile failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Temporal profile failed: {str(e)}",
        )

    _set_cached(event_log_id, "temporal_profile", result)
    return TemporalProfileResponse(**result)


# ---------------------------------------------------------------------------
# 4. Batch Detection
# ---------------------------------------------------------------------------

@router.get("/batches/{event_log_id}", response_model=BatchResponse)
async def get_batches(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Detect batch execution patterns: activities performed concurrently in batches
    by the same resource. Returns an empty list if no resource column is mapped.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "batches")
    if cached is not None:
        return BatchResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_batches, df)
    except Exception as e:
        logger.error(f"Batch detection failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Batch detection failed: {str(e)}",
        )

    _set_cached(event_log_id, "batches", result)
    return BatchResponse(**result)


# ---------------------------------------------------------------------------
# 5. Case Overlap
# ---------------------------------------------------------------------------

@router.get("/case-overlap/{event_log_id}", response_model=CaseOverlapResponse)
async def get_case_overlap(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Compute the number of concurrently active cases at each event timestamp.
    Returns the raw overlap series, maximum, and average overlap.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "case_overlap")
    if cached is not None:
        return CaseOverlapResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_case_overlap, df)
    except Exception as e:
        logger.error(f"Case overlap failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Case overlap failed: {str(e)}",
        )

    _set_cached(event_log_id, "case_overlap", result)
    return CaseOverlapResponse(**result)


# ---------------------------------------------------------------------------
# 6. Organizational Roles
# ---------------------------------------------------------------------------

@router.get("/org-roles/{event_log_id}", response_model=OrgRolesResponse)
async def get_org_roles(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Discover organizational roles: groups of resources that share similar
    activity execution profiles. Returns an empty list if no resource column
    is mapped.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "org_roles")
    if cached is not None:
        return OrgRolesResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_org_roles, df)
    except Exception as e:
        logger.error(f"Organizational roles failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Organizational roles failed: {str(e)}",
        )

    _set_cached(event_log_id, "org_roles", result)
    return OrgRolesResponse(**result)


# ---------------------------------------------------------------------------
# 7. SNA Networks
# ---------------------------------------------------------------------------

@router.get("/sna/{event_log_id}", response_model=SNAResponse)
async def get_sna(
    event_log_id: UUID,
    network_type: str = Query(
        default="handover",
        description="Network type: handover, working_together, subcontracting",
    ),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Compute a Social Network Analysis matrix between resources.
    Supported network types: handover, working_together, subcontracting.
    Returns an empty matrix if no resource column is mapped.
    """
    if network_type not in ("handover", "working_together", "subcontracting"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="network_type must be one of: handover, working_together, subcontracting",
        )

    cache_params = {"network_type": network_type}
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "sna", cache_params)
    if cached is not None:
        return SNAResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_sna, df, network_type=network_type)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        )
    except Exception as e:
        logger.error(f"SNA failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"SNA failed: {str(e)}",
        )

    _set_cached(event_log_id, "sna", result, cache_params)
    return SNAResponse(**result)


# ---------------------------------------------------------------------------
# 8. Case Clustering
# ---------------------------------------------------------------------------

@router.post("/cluster/{event_log_id}", response_model=ClusterResponse)
async def cluster_log(
    event_log_id: UUID,
    body: ClusterRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Cluster the event log into n_clusters groups using KMeans on pm4py-extracted
    features. Returns per-cluster case count, average duration, and the most
    frequent activity variant.

    Returns HTTP 501 if scikit-learn is not installed.
    """
    try:
        from sklearn.cluster import KMeans  # noqa: F401
    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="scikit-learn is not installed; clustering is unavailable",
        )

    cache_params = {"n_clusters": body.n_clusters}
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "cluster", cache_params)
    if cached is not None:
        return ClusterResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.cluster_log, df, n_clusters=body.n_clusters)
    except Exception as e:
        logger.error(f"Clustering failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Clustering failed: {str(e)}",
        )

    _set_cached(event_log_id, "cluster", result, cache_params)
    return ClusterResponse(**result)


# ---------------------------------------------------------------------------
# 9. Log Skeleton
# ---------------------------------------------------------------------------

@router.get("/log-skeleton/{event_log_id}", response_model=LogSkeletonResponse)
async def get_log_skeleton(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Discover the log skeleton: a declarative process model capturing
    always-before, always-after, equivalence, and never-together constraints.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "log_skeleton")
    if cached is not None:
        return LogSkeletonResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_log_skeleton, df)
    except Exception as e:
        logger.error(f"Log skeleton failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Log skeleton failed: {str(e)}",
        )

    _set_cached(event_log_id, "log_skeleton", result)
    return LogSkeletonResponse(**result)


# ---------------------------------------------------------------------------
# 10. DECLARE
# ---------------------------------------------------------------------------

@router.get("/declare/{event_log_id}", response_model=DeclareResponse)
async def get_declare(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Discover DECLARE constraints (e.g. response, precedence, coexistence) from
    the event log. Returns a list of rules with template name, activity pair,
    and support value.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "declare")
    if cached is not None:
        return DeclareResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_declare, df)
    except Exception as e:
        logger.error(f"DECLARE discovery failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"DECLARE discovery failed: {str(e)}",
        )

    _set_cached(event_log_id, "declare", result)
    return DeclareResponse(**result)


# ---------------------------------------------------------------------------
# 11. Four-Eyes Principle
# ---------------------------------------------------------------------------

@router.post("/four-eyes/{event_log_id}", response_model=FourEyesResponse)
async def check_four_eyes(
    event_log_id: UUID,
    body: FourEyesRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Detect violations of the four-eyes principle: cases where the same resource
    performed both activity1 and activity2. Requires a resource column to be
    mapped; otherwise returns zero violations.
    """
    cache_params = {"activity1": body.activity1, "activity2": body.activity2}
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "four_eyes", cache_params)
    if cached is not None:
        return FourEyesResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.check_four_eyes, df, body.activity1, body.activity2)
    except Exception as e:
        logger.error(f"Four-eyes check failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Four-eyes check failed: {str(e)}",
        )

    _set_cached(event_log_id, "four_eyes", result, cache_params)
    return FourEyesResponse(**result)


# ---------------------------------------------------------------------------
# 12. Performance Spectrum
# ---------------------------------------------------------------------------

@router.get("/performance-spectrum/{event_log_id}", response_model=PerformanceSpectrumResponse)
async def get_performance_spectrum(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Return per-case activity timelines for performance spectrum visualization.
    Limited to the first 100 cases. Each case contains an ordered list of
    {activity, timestamp} events.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "performance_spectrum")
    if cached is not None:
        return PerformanceSpectrumResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_performance_spectrum, df, limit=100)
    except Exception as e:
        logger.error(f"Performance spectrum failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Performance spectrum failed: {str(e)}",
        )

    _set_cached(event_log_id, "performance_spectrum", result)
    return PerformanceSpectrumResponse(**result)


# ---------------------------------------------------------------------------
# 13. Feature Export
# ---------------------------------------------------------------------------

@router.get("/features/{event_log_id}", response_model=FeatureExportResponse)
async def get_features(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Extract a feature vector per case using pm4py's feature extraction.
    Returns all feature column names, one row dict per case, and the total
    case count.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "features")
    if cached is not None:
        return FeatureExportResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_features, df)
    except Exception as e:
        logger.error(f"Feature extraction failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Feature extraction failed: {str(e)}",
        )

    _set_cached(event_log_id, "features", result)
    return FeatureExportResponse(**result)


# ---------------------------------------------------------------------------
# 14. Automated Insights
# ---------------------------------------------------------------------------

@router.get("/insights/{event_log_id}", response_model=InsightsResponse)
async def get_insights(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Generate automated plain-language insights for an event log.

    Runs bottleneck, variant, rework, conformance, and resource analyses,
    then synthesises the results into actionable Insight objects sorted by
    severity (critical → warning → info) with a short summary string.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "insights")
    if cached is not None:
        return InsightsResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.generate_insights, df)
    except Exception as e:
        logger.error(f"Insights generation failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Insights generation failed: {str(e)}",
        )

    _set_cached(event_log_id, "insights", result)
    return InsightsResponse(**result)


# ── Export endpoints ─────────────────────────────────────────────────────────

from fastapi.responses import StreamingResponse
import io
import csv


@router.get("/export/{event_log_id}/csv")
async def export_csv(
    event_log_id: UUID,
    analysis: str = Query(description="Analysis type: variants, bottlenecks, cases, statistics, features"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Export analysis results as CSV."""
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    rows: list[dict] = []
    if analysis == "variants":
        result = await _run_in_thread(mining_engine.run_variant_analysis, df)
        rows = result.get("variants", [])
    elif analysis == "bottlenecks":
        result = await _run_in_thread(mining_engine.run_bottleneck_analysis, df)
        rows = result.get("bottlenecks", [])
    elif analysis == "cases":
        result = await _run_in_thread(mining_engine.get_cases, df, limit=10000)
        rows = result.get("cases", [])
    elif analysis == "statistics":
        result = await _run_in_thread(mining_engine.compute_statistics, df)
        # Flatten the stats dict into rows
        rows = [{"metric": k, "value": v} for k, v in result.items() if not isinstance(v, (dict, list))]
    elif analysis == "features":
        result = await _run_in_thread(mining_engine.extract_features, df)
        rows = result.get("rows", [])
    elif analysis == "insights":
        result = await _run_in_thread(mining_engine.generate_insights, df)
        rows = result.get("insights", [])
    else:
        raise HTTPException(status_code=400, detail=f"Unknown analysis type: {analysis}")

    if not rows:
        raise HTTPException(status_code=404, detail="No data to export")

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=rows[0].keys(), extrasaction='ignore')
    writer.writeheader()
    for row in rows:
        writer.writerow({k: v for k, v in row.items() if not isinstance(v, (dict, list))})

    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={analysis}_{event_log_id}.csv"},
    )


@router.get("/export/{event_log_id}/excel")
async def export_excel(
    event_log_id: UUID,
    analysis: str = Query(description="Analysis type: variants, bottlenecks, cases, features"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Export analysis results as Excel (.xlsx)."""
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    rows: list[dict] = []
    if analysis == "variants":
        result = await _run_in_thread(mining_engine.run_variant_analysis, df)
        rows = result.get("variants", [])
    elif analysis == "bottlenecks":
        result = await _run_in_thread(mining_engine.run_bottleneck_analysis, df)
        rows = result.get("bottlenecks", [])
    elif analysis == "cases":
        result = await _run_in_thread(mining_engine.get_cases, df, limit=10000)
        rows = result.get("cases", [])
    elif analysis == "features":
        result = await _run_in_thread(mining_engine.extract_features, df)
        rows = result.get("rows", [])
    else:
        raise HTTPException(status_code=400, detail=f"Unknown analysis type: {analysis}")

    if not rows:
        raise HTTPException(status_code=404, detail="No data to export")

    export_df = pd.DataFrame(rows)
    # Drop complex columns
    for col in export_df.columns:
        if export_df[col].apply(lambda x: isinstance(x, (dict, list))).any():
            export_df[col] = export_df[col].astype(str)

    buf = io.BytesIO()
    export_df.to_excel(buf, index=False, engine="openpyxl")
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={analysis}_{event_log_id}.xlsx"},
    )


# ── Predictive Process Monitoring ────────────────────────────────────────────

from app.services.predictive import predictive_service


@router.get("/predict/remaining-time/{event_log_id}")
async def predict_remaining_time(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Predict remaining time for each case based on prefix analysis."""
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "predict_remaining_time")
    if cached is not None:
        return cached

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)
    result = predictive_service.predict_remaining_time(df)
    _set_cached(event_log_id, "predict_remaining_time", result)
    return result


@router.get("/predict/outcome/{event_log_id}")
async def predict_outcome(
    event_log_id: UUID,
    sla_threshold: float | None = Query(default=None, description="SLA threshold in seconds. Defaults to median case duration."),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Predict case outcome (fast/slow) with risk scoring."""
    cache_params = {"sla_threshold": sla_threshold}
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "predict_outcome", cache_params)
    if cached is not None:
        return cached

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)
    result = await _run_in_thread(predictive_service.predict_outcome, df, sla_threshold)
    _set_cached(event_log_id, "predict_outcome", result, cache_params)
    return result


@router.post("/cluster-dbscan/{event_log_id}")
async def cluster_log_dbscan(
    event_log_id: UUID,
    eps: float = Query(0.5, ge=0.0),
    min_samples: int = Query(5, ge=2),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Density-based trace clustering (DBSCAN on PCA-reduced features).

    Complements the existing k-means clustering for irregular
    behavioural distributions — finds naturally-shaped groups and
    flags outliers.
    """
    cache_params = {"eps": eps, "min_samples": min_samples}
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "cluster_dbscan", cache_params)
    if cached is not None:
        return cached

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)
    try:
        result = await _run_in_thread(
            mining_engine.cluster_log_dbscan, df, eps=eps, min_samples=min_samples,
        )
    except Exception as e:
        logger.error("DBSCAN clustering failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"DBSCAN clustering failed: {e}")
    _set_cached(event_log_id, "cluster_dbscan", result, cache_params)
    return result


@router.get("/discover-ilp/{event_log_id}")
async def discover_ilp(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Discover a Petri net using ILP Miner. More precise than Inductive
    Miner on logs with complex concurrency; slower."""
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "discover_ilp")
    if cached is not None:
        return cached

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)
    try:
        result = await _run_in_thread(mining_engine.run_discovery_ilp, df)
    except Exception as e:
        logger.error("ILP discovery failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"ILP discovery failed: {e}")
    _set_cached(event_log_id, "discover_ilp", result)
    return result


@router.get("/discover-correlation/{event_log_id}")
async def discover_correlation(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Correlation-miner discovery for logs with unreliable case IDs."""
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "discover_correlation")
    if cached is not None:
        return cached

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)
    try:
        result = await _run_in_thread(mining_engine.run_correlation_mining, df)
    except Exception as e:
        logger.error("Correlation mining failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Correlation mining failed: {e}")
    _set_cached(event_log_id, "discover_correlation", result)
    return result


@router.get("/predict/next-activity/{event_log_id}")
async def predict_next_activity(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Predict the next activity for each running case (top-3 with probabilities)."""
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "predict_next_activity")
    if cached is not None:
        return cached

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)
    result = await _run_in_thread(predictive_service.predict_next_activity, df)
    _set_cached(event_log_id, "predict_next_activity", result)
    return result


@router.get("/predict/suffix/{event_log_id}")
async def predict_suffix(
    event_log_id: UUID,
    max_suffix_length: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Predict the entire future trace suffix for each running case.

    Implements an iterative adaptation of SuTraN (Wuyts, Vanden Broucke,
    De Weerdt — ICPM 2024) — chains next-activity and remaining-time
    predictors to unroll the full predicted suffix step by step, with
    probability and time estimates at each step, terminating on sink
    activities or the max-length cap.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cache_params = {"max_suffix_length": max_suffix_length}
    cached = _get_cached(event_log_id, "predict_suffix", cache_params)
    if cached is not None:
        return cached

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)
    result = await _run_in_thread(
        predictive_service.predict_suffix, df, max_suffix_length,
    )
    _set_cached(event_log_id, "predict_suffix", result, cache_params)
    return result


@router.get("/digital-twin/{event_log_id}")
async def digital_twin(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """IBM-style Digital Twin: auto-infer resource-aware simulation
    parameters (activity durations, inter-arrival, resource calendars,
    branching probabilities) directly from the log."""
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "digital_twin")
    if cached is not None:
        return cached
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)
    result = await _run_in_thread(mining_engine.digital_twin_parameters, df)
    _set_cached(event_log_id, "digital_twin", result)
    return result


@router.get("/decision-rules/{event_log_id}")
async def decision_rules(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Decision mining: tree-based rules for each branching point."""
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "decision_rules")
    if cached is not None:
        return cached
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)
    result = await _run_in_thread(mining_engine.discover_decision_rules, df)
    _set_cached(event_log_id, "decision_rules", result)
    return result


@router.get("/decision-rules/{event_log_id}/dmn")
async def decision_rules_dmn(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Export discovered decision rules as a DMN 1.4 XML file.

    Returns an ``application/xml`` response suitable for import into
    Camunda Modeler, Trisotech, or any DMN 1.4-compliant engine.
    The filename is derived from the event log name.
    """
    from fastapi.responses import Response as FastAPIResponse
    from app.services.dmn_export import decision_rules_to_dmn

    await _assert_event_log_access(event_log_id, db, current_user)

    # Reuse cached decision-rules result if available
    cached = _get_cached(event_log_id, "decision_rules")
    if cached is not None:
        rules = cached
        # Fetch log name separately (cheap)
        result = await db.execute(select(EventLog).where(EventLog.id == event_log_id))
        event_log = result.scalar_one_or_none()
        log_name = event_log.name if event_log else "Process"
    else:
        event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)
        log_name = event_log.name
        rules = await _run_in_thread(mining_engine.discover_decision_rules, df)
        _set_cached(event_log_id, "decision_rules", rules)

    xml_content = decision_rules_to_dmn(rules, log_name)

    from app.services.dmn_export import _slugify
    slug = _slugify(log_name)
    filename = f"{slug}_decisions.dmn"

    return FastAPIResponse(
        content=xml_content,
        media_type="application/xml",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/staff-assignment/{event_log_id}")
async def staff_assignment(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Staff assignment mining: who does what, with confidence."""
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "staff_assignment")
    if cached is not None:
        return cached
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)
    result = await _run_in_thread(mining_engine.discover_staff_assignment, df)
    _set_cached(event_log_id, "staff_assignment", result)
    return result


@router.get("/dcr-rules/{event_log_id}")
async def dcr_rules(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """DCR graph discovery: conditions ('B requires A') and responses ('A obliges B')."""
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "dcr_rules")
    if cached is not None:
        return cached
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)
    result = await _run_in_thread(mining_engine.discover_dcr_rules, df)
    _set_cached(event_log_id, "dcr_rules", result)
    return result


@router.post("/ltl-check/{event_log_id}")
async def ltl_check(
    event_log_id: UUID,
    formula: str = Query(..., description="LTL-f formula as a string"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Check every case against an LTL-f formula. Returns per-case
    compliance plus a global compliance rate.

    Supported operators (subset): ``a BEFORE b``, ``a AFTER b``,
    ``a AND b``, ``a OR b``, ``NOT a``, ``a ALWAYS_WITH b``,
    ``a NEVER_WITH b``, ``a EXACTLY_ONCE``, ``a AT_LEAST_ONCE``.
    Nested expressions via parentheses. This is a minimal evaluator
    tailored to the common patterns — for full LTL-f use the log
    skeleton endpoint as a pre-check.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)
    try:
        result = await _run_in_thread(mining_engine.check_ltl, df, formula)
    except Exception as e:
        logger.error("LTL check failed: %s", e, exc_info=True)
        raise HTTPException(status_code=400, detail=f"LTL check failed: {e}")
    return result
