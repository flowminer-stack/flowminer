"""
Process mining router: discovery, variant analysis, bottleneck detection,
conformance checking, root cause analysis, statistics, and auto-summary.

Results are cached in-memory keyed by (event_log_id, analysis_type, params_hash).

The printable / exported report endpoints (``/conformance/{id}/pdf`` and
``/report/{id}``) live in ``app.api.mining_reports``, whose router mounts at
the same ``/api/v1/mining`` prefix. The data-quality computation engine lives
in ``app.services.data_quality`` (the ``/quality/{id}`` route here calls into
it).
"""

import asyncio
import functools
import hashlib
import json
import logging
import os
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
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
    DataQualityResponse,
    DeclareResponse,
    DiscoveryRequest,
    DiscoveryResponse,
    DottedChartResponse,
    EFGResponse,
    FeatureExportResponse,
    FourEyesRequest,
    FourEyesResponse,
    DriftResponse,
    InsightsResponse,
    LogSkeletonResponse,
    OrgRolesResponse,
    PerformanceDFGResponse,
    PerformanceSpectrumResponse,
    ProcessFilter,
    ProcessStatistics,
    ProcessSummary,
    QueueMiningResponse,
    ReworkResponse,
    RootCauseResponse,
    SNAResponse,
    SimulationRequest,
    SimulationResponse,
    DESScenario,
    DESSimulationResponse,
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

# Shared mining helpers now live in the api-deps layer so other routers
# (ai, bi, competitive, scorecards, task_mining, ocel, event_logs) and the
# MCP server depend on a shared dependency module instead of importing from
# this sibling router. Imported here so this router's own endpoints keep
# calling them unchanged.
from app.api._mining_deps import (  # noqa: E402
    _apply_filters,
    _assert_event_log_access,
    _build_log_context,
    _clear_cache_for_event_log,
    _get_cached,
    _load_event_log_and_df,
    _run_in_thread,
    _set_cached,
)


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

    # Cap the returned variant list — a high-variant log (BPIC has ~27k distinct
    # variants) otherwise yields a ~10 MB payload that is slow to transfer and
    # render. total_variants still reports the true count.
    MAX_VARIANTS_IN_RESPONSE = 1000
    variants = result.get("variants")
    if isinstance(variants, list) and len(variants) > MAX_VARIANTS_IN_RESPONSE:
        result = {**result, "variants": variants[:MAX_VARIANTS_IN_RESPONSE]}

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


@router.get("/queue-mining/{event_log_id}", response_model=QueueMiningResponse)
async def get_queue_mining(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    M/M/c queue mining per activity: arrival/service rates, utilisation,
    Erlang-C expected wait, and wait-time decomposition (resource contention,
    inter-batch, external dependency).

    Reference: Senderovich et al., Information Systems 2015.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "queue_mining")
    if cached is not None:
        return QueueMiningResponse(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.analyze_queue, df)
    except Exception as e:
        logger.error(f"Queue mining analysis failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Queue mining analysis failed: {str(e)}",
        )

    _set_cached(event_log_id, "queue_mining", result)
    return QueueMiningResponse(**result)


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

    await _assert_event_log_access(event_log_id, db, current_user)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    # When the caller did not supply an explicit reference model, prefer one
    # persisted alongside the log (e.g. attached by a vertical recipe at build
    # time). Falls through to auto-discovery if no sidecar exists.
    if ref_model_dict is None:
        from app.services.log_builder_recipes import read_reference_model_sidecar

        ref_model_dict = read_reference_model_sidecar(event_log.file_path)

    cache_params = {"reference_model": ref_model_dict, "method": method}
    cached = _get_cached(event_log_id, "conformance", cache_params)
    if cached is not None:
        return ConformanceResponse(**cached)

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

    await _assert_event_log_access(event_log_id, db, current_user)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    # Prefer a recipe-attached reference model when none was passed (see the
    # non-stochastic conformance endpoint for the rationale).
    if ref_model_dict is None:
        from app.services.log_builder_recipes import read_reference_model_sidecar

        ref_model_dict = read_reference_model_sidecar(_event_log.file_path)

    cache_params = {"reference_model": ref_model_dict}
    cached = _get_cached(event_log_id, "conformance_stochastic", cache_params)
    if cached is not None:
        return StochasticConformanceResponse(**cached)

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
        from app.services.rust_accel import discover_inductive_net as _rs_inductive_net

        # Prefer the Rust Inductive Miner (verified byte-identical net to pm4py,
        # ~65x faster on large logs). The pm4py path took ~40s on BPIC2019,
        # which is why this endpoint appeared to hang. Falls back to pm4py.
        rs_net = _rs_inductive_net(df)
        if rs_net is not None:
            net, im, fm = rs_net
        else:
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


@router.get("/simulate/des-params/{event_log_id}")
async def get_des_params(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Mine and return DES simulation parameters for the given event log.

    Parameters are cached with a 12-hour TTL. Returns arrival distribution,
    per-activity duration stats (mean, std, up to 200 samples), gateway
    probabilities, resource pools, and hourly arrival calendar.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "des_params")
    if cached is not None:
        return cached

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(
            mining_engine.mine_des_parameters,
            df=df,
        )
    except Exception as e:
        logger.error("DES parameter mining failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"DES parameter mining failed: {e}",
        )

    _set_cached(event_log_id, "des_params", result)
    return result


@router.post("/simulate/des/{event_log_id}", response_model=DESSimulationResponse)
async def run_des_simulation(
    event_log_id: UUID,
    body: DESScenario,
    runs: int = Query(5, ge=1, le=20),
    max_cases: int = Query(500, ge=50, le=5000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Run a discrete-event simulation with the supplied what-if scenario.

    The simulation mines parameters fresh from the log on each call, then
    runs `runs` replications of the scenario *and* a no-change baseline so
    the caller gets absolute numbers for both plus percentage deltas.

    Result is NOT cached — each scenario combination is user-specific.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(
            mining_engine.run_des_simulation,
            df=df,
            scenario=body.model_dump(),
            runs=runs,
            max_cases=max_cases,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error("DES simulation failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"DES simulation failed: {e}",
        )

    return DESSimulationResponse(**result)


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

    from app.services.data_quality import compute_data_quality

    result = compute_data_quality(df)
    _set_cached(event_log_id, "quality", result)
    return DataQualityResponse(**result)


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
    support_threshold: float = Query(default=0.7, ge=0.0, le=1.0, description="Minimum support threshold (0–1). Rules with support below this value are omitted."),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Discover DECLARE constraints (e.g. response, precedence, coexistence) from
    the event log. Returns a list of rules with template name, activity pair,
    support, confidence, and a plain-language narrative.

    Use ``support_threshold`` (default 0.7) to filter out low-support rules.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cache_params = {"support_threshold": support_threshold}
    cached = _get_cached(event_log_id, "declare", cache_params)
    if cached is not None:
        return DeclareResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(mining_engine.get_declare, df, support_threshold)
    except Exception as e:
        logger.error(f"DECLARE discovery failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"DECLARE discovery failed: {str(e)}",
        )

    _set_cached(event_log_id, "declare", result, cache_params)
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


@router.get("/drift/{event_log_id}", response_model=DriftResponse)
async def get_drift(
    event_log_id: UUID,
    window: str = Query(
        default="auto",
        description=(
            "Window granularity for drift detection. "
            "Accepted values: 'auto' (picks day/week/month to yield 8-30 windows), "
            "'day', 'week', 'month', or '<N>cases' (e.g. '50cases')."
        ),
    ),
    sensitivity: float = Query(
        default=0.15,
        ge=0.0,
        le=1.0,
        description=(
            "Jensen-Shannon divergence threshold in [0, 1]. "
            "Windows whose JSD exceeds this value are flagged as drift points. "
            "Lower = more sensitive; default 0.15."
        ),
    ),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Detect concept drift in an event log using a sliding-window JSD detector.

    Slides a time- or case-count window over the log, computes a normalized
    transition-frequency distribution per window, and flags consecutive window
    pairs whose Jensen-Shannon divergence exceeds the sensitivity threshold.

    Returns per-window metadata, drift points with structural change
    explanations (added / removed / magnitude-changed edges), and a summary.
    """
    await _assert_event_log_access(event_log_id, db, current_user)

    cache_params = {"window": window, "sensitivity": sensitivity}
    cached = _get_cached(event_log_id, "drift", cache_params)
    if cached is not None:
        return DriftResponse(**cached)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(
            mining_engine.detect_drifts, df, window, sensitivity
        )
    except Exception as e:
        logger.error(f"Drift detection failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Drift detection failed: {str(e)}",
        )

    _set_cached(event_log_id, "drift", result, cache_params)
    return DriftResponse(**result)


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
    # predict_remaining_time trains a model synchronously; run it in the
    # threadpool so it doesn't block the event loop during the fit+predict.
    result = await _run_in_thread(predictive_service.predict_remaining_time, df)
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


# ── Close-the-loop: alarms, explainability, model health ─────────────────────
#
# These three endpoints sit on top of the per-log model persistence in
# ``app.services.model_store``: passing ``event_log_id`` lets the predictive
# service reuse a fitted model across the (potentially repeated) alarm /
# explanation calls instead of refitting every request.


class NextActivityPrediction(BaseModel):
    activity: str
    probability: float


class CaseAtRisk(BaseModel):
    case_id: str
    prefix_length: int
    last_activity: str
    elapsed_seconds: float
    breach_probability: float = Field(..., description="P(case finishes over SLA)")
    risk_label: str
    predicted_remaining_seconds: float | None = None
    predicted_total_seconds: float | None = None
    predicted_finish_over_sla: bool | None = None
    top_next_activities: list[NextActivityPrediction] = Field(default_factory=list)


class CasesAtRiskResponse(BaseModel):
    event_log_id: UUID
    sla_hours: float
    sla_seconds: float
    risk_threshold: float
    count: int
    cases_at_risk: list[CaseAtRisk] = Field(default_factory=list)


class FeatureContribution(BaseModel):
    feature: str
    value: float
    contribution: float = Field(..., description="Signed SHAP contribution")


class ExplainResponse(BaseModel):
    available: bool
    reason: str | None = None
    case_id: str | None = None
    kind: str | None = None
    prefix_length: int | None = None
    current_activity: str | None = None
    base_value: float | None = Field(
        default=None, description="Model expected value (waterfall start)"
    )
    predicted_value: float | None = Field(
        default=None, description="This case's prediction (waterfall end)"
    )
    top_contributions: list[FeatureContribution] = Field(default_factory=list)
    model_info: dict | None = None


class ModelHealthEntry(BaseModel):
    kind: str
    trained: bool
    trained_at: str | None = None
    n_cases: int | None = None
    metrics: dict = Field(default_factory=dict)
    content_hash: str | None = None
    serializer: str | None = None


class ModelHealthResponse(BaseModel):
    event_log_id: UUID
    models: list[ModelHealthEntry] = Field(default_factory=list)


@router.get("/predict/cases-at-risk/{event_log_id}", response_model=CasesAtRiskResponse)
async def predict_cases_at_risk(
    event_log_id: UUID,
    sla_hours: float = Query(..., gt=0, description="SLA threshold in hours; cases predicted to finish beyond it are at risk."),
    risk_threshold: float = Query(0.7, ge=0.0, le=1.0, description="Minimum breach probability for a case to be flagged."),
    as_of: datetime | None = Query(
        default=None,
        description=(
            "ISO datetime cutoff defining 'now'. Only cases open at this moment "
            "(started but not finished) are scored, on their truncated in-progress "
            "prefix. Defaults to the ~0.6 quantile of case end times so a meaningful "
            "subset of a fully-historical log is still in-flight."
        ),
    ),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Score the cases open at ``as_of`` for SLA-breach risk (the close-the-loop alarm layer).

    A case is "open" at ``as_of`` when it had started but not yet finished by
    then; it is scored on the events that had occurred by the cutoff (its
    in-progress prefix). Already-finished and not-yet-started cases are
    excluded. When ``as_of`` is omitted, a default cutoff (~0.6 quantile of
    case end times) is derived so a fully-historical log still yields a
    meaningful set of in-flight cases.

    Returns those open cases whose predicted breach probability meets
    ``risk_threshold``, each with P(breach), predicted remaining time, and the
    top likely next activities for routing the alarm.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    sla_seconds = sla_hours * 3600.0
    cache_params = {
        "sla_hours": sla_hours,
        "risk_threshold": risk_threshold,
        "as_of": as_of.isoformat() if as_of is not None else None,
    }
    cached = _get_cached(event_log_id, "predict_cases_at_risk", cache_params)
    if cached is not None:
        return cached

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)
    at_risk = await _run_in_thread(
        predictive_service.score_cases_for_alarm,
        df,
        sla_seconds,
        risk_threshold,
        str(event_log_id),
        as_of,
    )
    result = {
        "event_log_id": event_log_id,
        "sla_hours": sla_hours,
        "sla_seconds": sla_seconds,
        "risk_threshold": risk_threshold,
        "count": len(at_risk),
        "cases_at_risk": at_risk,
    }
    _set_cached(event_log_id, "predict_cases_at_risk", result, cache_params)
    return result


@router.get("/predict/explain/{event_log_id}/{case_id}", response_model=ExplainResponse)
async def predict_explain(
    event_log_id: UUID,
    case_id: str,
    kind: str = Query("outcome", description="Which model to explain: outcome | remaining_time | next_activity."),
    top_n: int = Query(8, ge=1, le=50, description="Number of top signed feature contributions to return."),
    sla_threshold: float | None = Query(default=None, description="SLA threshold in seconds for the outcome model (defaults to median)."),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Explain a single case's prediction via SHAP feature attributions.

    Returns the top-N signed feature contributions for the case's current
    prefix. When SHAP isn't installed (or the model/case can't be resolved)
    the service returns ``{"available": false, "reason": ...}`` and we pass
    that through unchanged.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cache_params = {"case_id": case_id, "kind": kind, "top_n": top_n, "sla_threshold": sla_threshold}
    cached = _get_cached(event_log_id, "predict_explain", cache_params)
    if cached is not None:
        return cached

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)
    result = await _run_in_thread(
        predictive_service.explain_case,
        df,
        case_id,
        kind,
        top_n,
        sla_threshold,
        str(event_log_id),
    )
    _set_cached(event_log_id, "predict_explain", result, cache_params)
    return result


@router.get("/predict/model-health/{event_log_id}", response_model=ModelHealthResponse)
async def predict_model_health(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Report the persisted-model metadata (trained_at, n_cases, MAE/AUC/etc.)
    for each predictive model kind cached for this event log.

    Reads ``model_store`` envelope metadata only — it does not retrain or load
    the (potentially large) estimator into memory. Kinds with no cached model
    report ``trained: false``.
    """
    await _assert_event_log_access(event_log_id, db, current_user)

    import os as _os

    from app.services import model_store

    log_id = str(event_log_id)

    # Discover every kind actually persisted for this log by scanning the cache
    # directory. The outcome model is stored under a threshold-folded kind
    # (e.g. ``outcome__median`` / ``outcome__sla3600``), so a fixed kind list
    # would miss it — enumerate the .pkl files instead.
    discovered: list[str] = []
    try:
        model_dir = model_store._model_dir(log_id)  # creates the dir if absent
        for name in sorted(_os.listdir(model_dir)):
            if name.endswith(".pkl"):
                discovered.append(name[: -len(".pkl")])
    except Exception as e:  # noqa: BLE001 - health must never 500
        logger.warning("model-health: could not list cache dir for %s: %s", log_id, e)

    # Always surface the three core kinds (reporting trained=false when absent),
    # plus any extra persisted kinds (e.g. threshold-specific outcome models).
    base_kinds = ["remaining_time", "outcome", "next_activity"]
    ordered = base_kinds + [k for k in discovered if k not in base_kinds]

    models: list[dict] = []
    for kind in ordered:
        meta = model_store.model_meta(log_id, kind)
        if meta is None:
            # Skip a base kind only if a threshold-variant of it is present
            # (avoids a misleading "outcome: not trained" alongside the real
            # "outcome__median: trained" entry).
            if kind in base_kinds and any(d.startswith(kind + "__") for d in discovered):
                continue
            models.append({"kind": kind, "trained": False, "metrics": {}})
        else:
            models.append({"kind": kind, "trained": True, **meta})

    return {"event_log_id": event_log_id, "models": models}


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
