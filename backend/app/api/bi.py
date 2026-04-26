"""BI connector endpoints — flat tabular shapes for Power BI, Tableau, Looker.

Every response here is a plain ``list[dict]`` with a stable column set —
no nested objects, no variable keys, no row caps. BI tools hit these
endpoints via HTTP, authenticate with a standard API key
(``Authorization: Bearer fmk_...``) or JWT, and get rows directly into
their data model.

The endpoints deliberately mirror the analytics already computed by
``mining_engine`` — this router does the last-mile flattening, it does
not run new analyses. That keeps BI refreshes cheap because the results
are already cached.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_active_user
from app.api.mining import (
    _assert_event_log_access,
    _load_event_log_and_df,
)
from app.database import get_db
from app.models import User
from app.services.mining_engine import mining_engine

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/tables")
async def list_bi_tables(
    _current_user: User = Depends(get_current_active_user),
):
    """List the tables a BI tool can pull.

    Power BI / Tableau drivers call this first to build a schema picker.
    Each entry is self-describing: the ``path`` is the REST endpoint that
    returns rows, and ``columns`` is the fixed schema the BI tool should
    bind against.
    """
    return {
        "tables": [
            {
                "name": "statistics",
                "description": "Overall KPI row for an event log (1 row)",
                "path": "/api/v1/bi/statistics",
                "columns": [
                    {"name": "event_log_id", "type": "string"},
                    {"name": "total_cases", "type": "int"},
                    {"name": "total_events", "type": "int"},
                    {"name": "total_activities", "type": "int"},
                    {"name": "avg_case_duration_hours", "type": "float"},
                    {"name": "median_case_duration_hours", "type": "float"},
                    {"name": "start_timestamp", "type": "datetime"},
                    {"name": "end_timestamp", "type": "datetime"},
                ],
            },
            {
                "name": "variants",
                "description": "Process variants ranked by frequency",
                "path": "/api/v1/bi/variants",
                "columns": [
                    {"name": "event_log_id", "type": "string"},
                    {"name": "variant_rank", "type": "int"},
                    {"name": "case_count", "type": "int"},
                    {"name": "case_percentage", "type": "float"},
                    {"name": "activity_sequence", "type": "string"},
                    {"name": "step_count", "type": "int"},
                ],
            },
            {
                "name": "bottlenecks",
                "description": "Activities ranked by waiting/duration",
                "path": "/api/v1/bi/bottlenecks",
                "columns": [
                    {"name": "event_log_id", "type": "string"},
                    {"name": "activity", "type": "string"},
                    {"name": "avg_duration_seconds", "type": "float"},
                    {"name": "max_duration_seconds", "type": "float"},
                    {"name": "frequency", "type": "int"},
                ],
            },
            {
                "name": "activities",
                "description": "One row per distinct activity with occurrence count",
                "path": "/api/v1/bi/activities",
                "columns": [
                    {"name": "event_log_id", "type": "string"},
                    {"name": "activity", "type": "string"},
                    {"name": "occurrences", "type": "int"},
                    {"name": "cases_touching", "type": "int"},
                ],
            },
            {
                "name": "cases",
                "description": "One row per case with KPIs",
                "path": "/api/v1/bi/cases",
                "columns": [
                    {"name": "event_log_id", "type": "string"},
                    {"name": "case_id", "type": "string"},
                    {"name": "event_count", "type": "int"},
                    {"name": "duration_seconds", "type": "float"},
                    {"name": "start_timestamp", "type": "datetime"},
                    {"name": "end_timestamp", "type": "datetime"},
                    {"name": "activity_count", "type": "int"},
                ],
            },
            {
                "name": "events",
                "description": "Flat event stream (one row per event)",
                "path": "/api/v1/bi/events",
                "columns": [
                    {"name": "event_log_id", "type": "string"},
                    {"name": "case_id", "type": "string"},
                    {"name": "activity", "type": "string"},
                    {"name": "timestamp", "type": "datetime"},
                    {"name": "resource", "type": "string"},
                ],
            },
        ]
    }


def _ts_iso(v) -> str | None:
    if v is None:
        return None
    try:
        return v.isoformat() if hasattr(v, "isoformat") else str(v)
    except Exception:
        return None


@router.get("/statistics")
async def bi_statistics(
    event_log_id: UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """One-row KPI table for the event log."""
    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    stats = mining_engine.compute_statistics(df)

    avg_dur_s = stats.get("avg_case_duration_seconds") or 0.0
    median_dur_s = stats.get("median_case_duration_seconds") or 0.0

    row = {
        "event_log_id": str(event_log_id),
        "total_cases": int(stats.get("total_cases") or 0),
        "total_events": int(stats.get("total_events") or 0),
        "total_activities": int(stats.get("total_activities") or 0),
        "avg_case_duration_hours": round(float(avg_dur_s) / 3600.0, 4),
        "median_case_duration_hours": round(float(median_dur_s) / 3600.0, 4),
        "start_timestamp": _ts_iso(stats.get("start_time")),
        "end_timestamp": _ts_iso(stats.get("end_time")),
    }
    return [row]


@router.get("/variants")
async def bi_variants(
    event_log_id: UUID = Query(...),
    limit: int = Query(500, ge=1, le=10000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Flat variant rows, ranked by frequency."""
    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    result = mining_engine.run_variant_analysis(df)
    variants = result.get("variants") or []
    total_cases = sum(v.get("case_count", 0) for v in variants) or 1

    rows = []
    for i, v in enumerate(variants[:limit]):
        activities = v.get("activities") or []
        case_count = int(v.get("case_count") or 0)
        rows.append({
            "event_log_id": str(event_log_id),
            "variant_rank": i + 1,
            "case_count": case_count,
            "case_percentage": round(case_count * 100.0 / total_cases, 3),
            "activity_sequence": " → ".join(activities),
            "step_count": len(activities),
        })
    return rows


@router.get("/bottlenecks")
async def bi_bottlenecks(
    event_log_id: UUID = Query(...),
    limit: int = Query(500, ge=1, le=10000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Flat bottleneck rows, one per activity."""
    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    result = mining_engine.run_bottleneck_analysis(df)
    bottlenecks = result.get("bottlenecks") or []

    rows = []
    for b in bottlenecks[:limit]:
        rows.append({
            "event_log_id": str(event_log_id),
            "activity": str(b.get("activity") or ""),
            "avg_duration_seconds": round(float(b.get("avg_duration") or 0.0), 3),
            "max_duration_seconds": round(float(b.get("max_duration") or 0.0), 3),
            "frequency": int(b.get("frequency") or 0),
        })
    return rows


@router.get("/activities")
async def bi_activities(
    event_log_id: UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """One row per distinct activity."""
    from app.services.ingestion import CASE_COL, ACTIVITY_COL

    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    if ACTIVITY_COL not in df.columns:
        return []

    counts = df[ACTIVITY_COL].value_counts().to_dict()
    cases_touching = df.groupby(ACTIVITY_COL)[CASE_COL].nunique().to_dict()

    rows = []
    for activity, occurrences in counts.items():
        rows.append({
            "event_log_id": str(event_log_id),
            "activity": str(activity),
            "occurrences": int(occurrences),
            "cases_touching": int(cases_touching.get(activity, 0)),
        })
    rows.sort(key=lambda r: -r["occurrences"])
    return rows


@router.get("/cases")
async def bi_cases(
    event_log_id: UUID = Query(...),
    limit: int = Query(5000, ge=1, le=100000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """One row per case with KPIs. Paginated — pass offset to page through."""
    from app.services.ingestion import CASE_COL, ACTIVITY_COL, TIMESTAMP_COL

    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    if CASE_COL not in df.columns:
        return []

    grouped = df.groupby(CASE_COL)
    rows = []
    for case_id, case_df in grouped:
        ts = case_df[TIMESTAMP_COL] if TIMESTAMP_COL in case_df.columns else None
        start_ts = ts.min() if ts is not None else None
        end_ts = ts.max() if ts is not None else None
        duration_s = 0.0
        if start_ts is not None and end_ts is not None:
            try:
                duration_s = float((end_ts - start_ts).total_seconds())
            except Exception:
                duration_s = 0.0
        rows.append({
            "event_log_id": str(event_log_id),
            "case_id": str(case_id),
            "event_count": int(len(case_df)),
            "duration_seconds": round(duration_s, 3),
            "start_timestamp": _ts_iso(start_ts),
            "end_timestamp": _ts_iso(end_ts),
            "activity_count": int(case_df[ACTIVITY_COL].nunique()) if ACTIVITY_COL in case_df.columns else 0,
        })

    rows.sort(key=lambda r: r["start_timestamp"] or "")
    return rows[offset : offset + limit]


@router.get("/events")
async def bi_events(
    event_log_id: UUID = Query(...),
    limit: int = Query(10000, ge=1, le=500000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Flat event stream. Use ``limit`` + ``offset`` to page through big logs."""
    from app.services.ingestion import CASE_COL, ACTIVITY_COL, TIMESTAMP_COL

    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    resource_col = "org:resource" if "org:resource" in df.columns else None

    # Sort by timestamp so pagination is deterministic
    sort_cols = [c for c in (TIMESTAMP_COL, CASE_COL) if c in df.columns]
    if sort_cols:
        df = df.sort_values(sort_cols)

    sliced = df.iloc[offset : offset + limit]
    rows = []
    for _idx, ev in sliced.iterrows():
        rows.append({
            "event_log_id": str(event_log_id),
            "case_id": str(ev.get(CASE_COL)) if CASE_COL in df.columns else None,
            "activity": str(ev.get(ACTIVITY_COL)) if ACTIVITY_COL in df.columns else None,
            "timestamp": _ts_iso(ev.get(TIMESTAMP_COL)) if TIMESTAMP_COL in df.columns else None,
            "resource": str(ev.get(resource_col)) if resource_col else None,
        })
    return rows
