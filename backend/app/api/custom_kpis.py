"""Custom KPI builder: define, compute, and track custom process metrics."""

import re
from uuid import UUID
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import User
from app.models.custom_kpi import CustomKPI
from app.api.deps import get_current_active_user, assert_project_access, assert_event_log_access

# Regex used to detect whether an expression looks like the filter-DSL
# (uses `case.`, `activity`, `resource`, `attr.`, or duration literals like
# `7d`/`30m`) rather than a plain arithmetic formula on base metric names.
_FILTER_DSL_RE = re.compile(
    r"\bcase\.|"
    r"\bactivity\b|"
    r"\bresource\b|"
    r"\battr\.|"
    r"\d+[smhd]\b"
)

router = APIRouter()


class KPICreate(BaseModel):
    project_id: UUID
    name: str
    description: str | None = None
    metric: str  # avg_case_duration, case_count, activity_frequency, rework_rate, conformance_fitness, bottleneck_count, variant_count
    expression: str | None = None
    filters: dict | None = None
    unit: str | None = None
    target_value: float | None = None
    warning_threshold: float | None = None
    critical_threshold: float | None = None


class KPIUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    target_value: float | None = None
    warning_threshold: float | None = None
    critical_threshold: float | None = None
    unit: str | None = None


def _to_response(k: CustomKPI) -> dict:
    return {
        "id": str(k.id),
        "project_id": str(k.project_id),
        "name": k.name,
        "description": k.description,
        "metric": k.metric,
        "expression": k.expression,
        "filters": k.filters,
        "unit": k.unit,
        "target_value": k.target_value,
        "warning_threshold": k.warning_threshold,
        "critical_threshold": k.critical_threshold,
        "last_value": k.last_value,
        "last_computed_at": str(k.last_computed_at) if k.last_computed_at else None,
        "created_at": str(k.created_at) if k.created_at else "",
    }


@router.get("")
async def list_kpis(
    project_id: UUID,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    await assert_project_access(project_id, db, current_user)
    result = await db.execute(
        select(CustomKPI).where(CustomKPI.project_id == project_id).order_by(CustomKPI.created_at).limit(limit).offset(offset)
    )
    return [_to_response(k) for k in result.scalars().all()]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_kpi(
    body: KPICreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    await assert_project_access(body.project_id, db, current_user)
    kpi = CustomKPI(
        project_id=body.project_id,
        name=body.name,
        description=body.description,
        metric=body.metric,
        expression=body.expression,
        filters=body.filters,
        unit=body.unit,
        target_value=body.target_value,
        warning_threshold=body.warning_threshold,
        critical_threshold=body.critical_threshold,
        created_by=current_user.id,
    )
    db.add(kpi)
    await db.commit()
    await db.refresh(kpi)
    return _to_response(kpi)


@router.put("/{kpi_id}")
async def update_kpi(
    kpi_id: UUID,
    body: KPIUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    result = await db.execute(select(CustomKPI).where(CustomKPI.id == kpi_id))
    kpi = result.scalar_one_or_none()
    if not kpi:
        raise HTTPException(status_code=404, detail="KPI not found")
    await assert_project_access(kpi.project_id, db, current_user)
    for field, val in body.model_dump(exclude_none=True).items():
        setattr(kpi, field, val)
    await db.commit()
    await db.refresh(kpi)
    return _to_response(kpi)


@router.delete("/{kpi_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_kpi(
    kpi_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    result = await db.execute(select(CustomKPI).where(CustomKPI.id == kpi_id))
    kpi = result.scalar_one_or_none()
    if not kpi:
        raise HTTPException(status_code=404, detail="KPI not found")
    await assert_project_access(kpi.project_id, db, current_user)
    await db.delete(kpi)
    await db.commit()


def _compute_base_metrics(df: "pd.DataFrame", mining_engine: object) -> dict[str, float]:  # type: ignore[name-defined]
    """Compute all 9 base metric scalars from an event log DataFrame.

    Returns a dict keyed by metric name (the same names accepted by the
    ``metric`` field) so callers can either look up a single value or
    expose the whole dict as a one-row DataFrame for safe_eval arithmetic.
    """
    # Lazy import — avoid pulling pandas into module-level scope.
    import pandas as pd  # noqa: F401 — used inside helpers called from here
    from app.services.ingestion import CASE_COL, ACTIVITY_COL, TIMESTAMP_COL

    durations = df.groupby(CASE_COL)[TIMESTAMP_COL].apply(
        lambda x: (x.max() - x.min()).total_seconds()
    )

    rework = mining_engine.get_rework(df)
    variants = mining_engine.run_variant_analysis(df)
    conf = mining_engine.run_conformance(df)
    bn = mining_engine.run_bottleneck_analysis(df)

    return {
        "avg_case_duration": float(durations.mean()) if len(durations) > 0 else 0.0,
        "case_count": float(df[CASE_COL].nunique()),
        "event_count": float(len(df)),
        "activity_count": float(df[ACTIVITY_COL].nunique()),
        "rework_rate": float(rework.get("overall_rework_rate", 0)),
        "variant_count": float(variants.get("total_variants", 0)),
        "conformance_fitness": float(conf.get("fitness", 0)),
        "bottleneck_count": float(
            len([b for b in bn.get("bottlenecks", []) if b.get("is_bottleneck")])
        ),
        "median_case_duration": float(durations.median()) if len(durations) > 0 else 0.0,
    }


@router.post("/{kpi_id}/compute")
async def compute_kpi(
    kpi_id: UUID,
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Compute a KPI value against an event log.

    When ``expression`` is set on the KPI the evaluator is chosen as follows:

    1. **Filter-DSL expression** — if the expression contains process-aware
       tokens such as ``case.``, ``activity``, ``resource``, ``attr.``, or
       duration literals (``7d``, ``30m`` …), it is passed to the same
       recursive-descent filter evaluator used by the ``/filter-expression``
       endpoint (``_evaluate_filter`` from ``competitive.py``). The returned
       value is the **count of matching cases**.

    2. **Arithmetic formula** — otherwise the expression is evaluated by the
       safe AST-walking evaluator in ``safe_expression.py``, with the nine
       base metric scalars available as column names (e.g.
       ``avg_case_duration / 86400`` converts seconds to days, or
       ``rework_rate * case_count`` gives an absolute rework count).

    When ``expression`` is absent the traditional ``metric`` enum path is used.
    ``python eval()`` is never called.
    """
    import os
    import pandas as pd

    from app.models import EventLog
    from app.services.mining_engine import mining_engine
    from app.services.ingestion import CASE_COL, ACTIVITY_COL, TIMESTAMP_COL

    result = await db.execute(select(CustomKPI).where(CustomKPI.id == kpi_id))
    kpi = result.scalar_one_or_none()
    if not kpi:
        raise HTTPException(status_code=404, detail="KPI not found")
    await assert_project_access(kpi.project_id, db, current_user)
    await assert_event_log_access(event_log_id, db, current_user)

    el_result = await db.execute(select(EventLog).where(EventLog.id == event_log_id))
    event_log = el_result.scalar_one_or_none()
    if not event_log or not event_log.file_path or not os.path.exists(event_log.file_path):
        raise HTTPException(status_code=404, detail="Event log not found")

    df = mining_engine.load_event_log(
        file_path=event_log.file_path,
        case_id_col=event_log.case_id_column,
        activity_col=event_log.activity_column,
        timestamp_col=event_log.timestamp_column,
        resource_col=event_log.resource_column,
        cost_col=event_log.cost_column,
    )

    # ── Expression path ────────────────────────────────────────────────────
    # When an expression is stored we evaluate it instead of (or in addition
    # to) the metric enum.  The metric enum is still the fallback when no
    # expression is present.
    expression_warnings: list[str] = []
    value: float | None = None

    if kpi.expression:
        expr = kpi.expression.strip()

        if _FILTER_DSL_RE.search(expr):
            # ── Path 1: process-aware filter DSL ──────────────────────────
            # Import only what we need from the services layer (the engine
            # used to live in competitive.py — a router-imports-router smell).
            from app.services.filter_engine import _evaluate_filter

            all_case_ids = set(str(c) for c in df[CASE_COL].unique())
            try:
                matched_ids, expression_warnings = _evaluate_filter(expr, df, all_case_ids)
                value = float(len(matched_ids))
            except Exception as exc:  # pragma: no cover
                raise HTTPException(
                    status_code=400,
                    detail=f"Filter expression error: {exc}",
                )
        else:
            # ── Path 2: arithmetic formula over base metrics ───────────────
            # Build a one-row DataFrame whose columns are the nine base
            # metric names, then let safe_eval resolve them as Series/scalar.
            from app.services.infra.safe_expression import safe_eval, UnsafeExpressionError

            base = _compute_base_metrics(df, mining_engine)
            metrics_df = pd.DataFrame([base])
            try:
                result_val = safe_eval(expr, metrics_df)
                # safe_eval may return a Series (one-row) or a scalar.
                if isinstance(result_val, pd.Series):
                    if result_val.empty:
                        raise HTTPException(
                            status_code=400, detail="Expression produced an empty result"
                        )
                    value = float(result_val.iloc[0])
                else:
                    value = float(result_val)
            except UnsafeExpressionError as exc:
                raise HTTPException(status_code=400, detail=f"Expression error: {exc}")
            except Exception as exc:  # pragma: no cover
                raise HTTPException(
                    status_code=400,
                    detail=f"Expression evaluation failed: {exc}",
                )

    # ── Enum/hardcoded path (fallback when no expression is given) ─────────
    if value is None:
        metric = kpi.metric
        if metric == "avg_case_duration":
            durations = df.groupby(CASE_COL)[TIMESTAMP_COL].apply(
                lambda x: (x.max() - x.min()).total_seconds()
            )
            value = float(durations.mean()) if len(durations) > 0 else 0
        elif metric == "case_count":
            value = float(df[CASE_COL].nunique())
        elif metric == "event_count":
            value = float(len(df))
        elif metric == "activity_count":
            value = float(df[ACTIVITY_COL].nunique())
        elif metric == "rework_rate":
            rework = mining_engine.get_rework(df)
            value = float(rework.get("overall_rework_rate", 0))
        elif metric == "variant_count":
            variants = mining_engine.run_variant_analysis(df)
            value = float(variants.get("total_variants", 0))
        elif metric == "conformance_fitness":
            conf = mining_engine.run_conformance(df)
            value = float(conf.get("fitness", 0))
        elif metric == "bottleneck_count":
            bn = mining_engine.run_bottleneck_analysis(df)
            value = float(len([b for b in bn.get("bottlenecks", []) if b.get("is_bottleneck")]))
        elif metric == "median_case_duration":
            durations = df.groupby(CASE_COL)[TIMESTAMP_COL].apply(
                lambda x: (x.max() - x.min()).total_seconds()
            )
            value = float(durations.median()) if len(durations) > 0 else 0
        elif metric == "custom_expression":
            # metric=custom_expression but expression field is empty/None
            raise HTTPException(
                status_code=400,
                detail="metric is 'custom_expression' but no expression was provided",
            )
        else:
            raise HTTPException(status_code=400, detail=f"Unknown metric: {metric}")

    # ── Persist and return ─────────────────────────────────────────────────
    kpi.last_value = value
    kpi.last_computed_at = datetime.now(timezone.utc)
    await db.commit()

    kpi_status = "ok"
    if kpi.critical_threshold is not None and value >= kpi.critical_threshold:
        kpi_status = "critical"
    elif kpi.warning_threshold is not None and value >= kpi.warning_threshold:
        kpi_status = "warning"

    return {
        "kpi_id": str(kpi.id),
        "name": kpi.name,
        "value": value,
        "unit": kpi.unit,
        "target_value": kpi.target_value,
        "status": kpi_status,
        "expression_warnings": expression_warnings,
    }
