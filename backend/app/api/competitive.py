"""Competitive-parity analytics endpoints.

Routes that back the Wave 2/3 UX features from the competitor audit.
Kept in a separate file so the main mining router stays reviewable.
"""

from __future__ import annotations

import logging
from uuid import UUID

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_active_user
from app.api._mining_deps import _assert_event_log_access, _load_event_log_and_df
from app.database import get_db
from app.models import User
from app.services.ingestion import (
    ACTIVITY_COL,
    CASE_COL,
    COST_COL,
    RESOURCE_COL,
    TIMESTAMP_COL,
)
from app.services.transition_cache import get_transitions

router = APIRouter()


def _add_dwell(df: pd.DataFrame) -> pd.DataFrame:
    """Add a _dwell column (seconds to next event in same case) without
    copying the DataFrame.  Uses the Rust transition cache when
    available — avoids the sort+copy+shift pattern that creates a full
    DataFrame copy (~1.3x memory overhead per call)."""
    _t = get_transitions(df)
    if _t is not None:
        df["_dwell"] = _t.duration_secs
        df["_next_act"] = pd.Categorical.from_codes(
            _t.next_act_code.clip(0), categories=_t.act_labels,
        ).astype(object)
        # Mark last events as NaN for downstream dropna compat
        df.loc[_t.is_last, "_dwell"] = np.nan
        df.loc[_t.is_last, "_next_act"] = np.nan
        return df
    # Fallback: pandas copy+shift
    sdf = df.sort_values([CASE_COL, TIMESTAMP_COL]).copy()
    sdf["_next_ts"] = sdf.groupby(CASE_COL)[TIMESTAMP_COL].shift(-1)
    sdf["_dwell"] = (sdf["_next_ts"] - sdf[TIMESTAMP_COL]).dt.total_seconds()
    sdf["_next_act"] = sdf.groupby(CASE_COL)[ACTIVITY_COL].shift(-1)
    return sdf
logger = logging.getLogger(__name__)


# ─── 1. What-if bottleneck sensitivity slider (Minit / IBM) ───────────────


class WhatIfBottleneckRequest(BaseModel):
    event_log_id: UUID
    activity: str
    speedup_pct: float  # 0–100 — how much faster we assume this activity becomes


class WhatIfBottleneckResponse(BaseModel):
    original_case_avg_seconds: float
    new_case_avg_seconds: float
    saving_per_case_seconds: float
    total_saving_seconds: float
    pct_improvement: float
    # Activity-level detail so the frontend can show what's actually
    # happening instead of just two near-identical global numbers.
    activity_avg_dwell_seconds: float
    activity_new_dwell_seconds: float
    activity_occurrences: int
    cases_affected: int
    cases_total: int


@router.post("/whatif-bottleneck", response_model=WhatIfBottleneckResponse)
async def whatif_bottleneck(
    body: WhatIfBottleneckRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Simulate cycle-time impact of speeding up one activity.

    Computes current avg case duration, subtracts the share of time
    that activity contributes (based on its avg dwell × occurrences per
    case), and scales that contribution down by ``speedup_pct``. Returns
    the projected new avg and the saved time per case / across the log.
    """
    await _assert_event_log_access(body.event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(body.event_log_id, db, current_user)

    if df.empty:
        raise HTTPException(status_code=400, detail="Event log is empty")

    # Per-case duration
    case_times = df.groupby(CASE_COL)[TIMESTAMP_COL].agg(["min", "max"])
    case_times["_dur"] = (case_times["max"] - case_times["min"]).dt.total_seconds()
    orig_avg = float(case_times["_dur"].mean())

    # Dwell time contribution from the target activity, averaged per case.
    # Use Rust-cached transition data to avoid DataFrame copy+shift.
    _t = get_transitions(df)
    if _t is not None:
        df["_dwell"] = _t.duration_secs
        act_rows = df[df[ACTIVITY_COL] == body.activity]
    else:
        sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL]).copy()
        sorted_df["_next_ts"] = sorted_df.groupby(CASE_COL)[TIMESTAMP_COL].shift(-1)
        sorted_df["_dwell"] = (sorted_df["_next_ts"] - sorted_df[TIMESTAMP_COL]).dt.total_seconds()
        act_rows = sorted_df[sorted_df[ACTIVITY_COL] == body.activity]
    if act_rows.empty:
        raise HTTPException(
            status_code=404,
            detail=f"Activity '{body.activity}' not found in the event log",
        )

    act_dwell_valid = act_rows.dropna(subset=["_dwell"])
    activity_avg_dwell = float(act_dwell_valid["_dwell"].mean()) if len(act_dwell_valid) else 0.0
    activity_occurrences = int(len(act_rows))
    cases_affected = int(act_rows[CASE_COL].nunique())
    cases_total = int(len(case_times))

    dwell_per_case = (
        act_dwell_valid
        .groupby(CASE_COL)["_dwell"]
        .sum()
        .reindex(case_times.index, fill_value=0)
    )
    contrib_avg = float(dwell_per_case.mean())
    saving_per_case = contrib_avg * (body.speedup_pct / 100.0)
    new_avg = max(0.0, orig_avg - saving_per_case)
    total_saving = saving_per_case * cases_total
    activity_new_dwell = activity_avg_dwell * (1.0 - body.speedup_pct / 100.0)

    return WhatIfBottleneckResponse(
        original_case_avg_seconds=orig_avg,
        new_case_avg_seconds=new_avg,
        saving_per_case_seconds=saving_per_case,
        total_saving_seconds=total_saving,
        pct_improvement=(saving_per_case / orig_avg * 100) if orig_avg > 0 else 0,
        activity_avg_dwell_seconds=activity_avg_dwell,
        activity_new_dwell_seconds=activity_new_dwell,
        activity_occurrences=activity_occurrences,
        cases_affected=cases_affected,
        cases_total=cases_total,
    )


# ─── 2. Automation candidates scorer (IBM / UiPath) ──────────────────────


class AutomationCandidate(BaseModel):
    activity: str
    frequency: int
    avg_duration_seconds: float
    total_time_seconds: float
    score: float
    estimated_hours_saved: float
    estimated_cost_saved: float


class AutomationCandidatesResponse(BaseModel):
    candidates: list[AutomationCandidate]
    hourly_cost_used: float
    automation_rate_used: float


@router.get("/automation-candidates/{event_log_id}", response_model=AutomationCandidatesResponse)
async def automation_candidates(
    event_log_id: UUID,
    hourly_cost: float = Query(50.0, description="Loaded hourly cost per resource in your currency"),
    automation_rate: float = Query(0.7, description="Fraction of the activity that can be automated (0–1)"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Rank activities by their automation ROI.

    Score = frequency × avg_dwell × automation_rate × hourly_cost.
    Returns the top 20 candidates, each with editable assumption inputs
    so the caller can re-run with different cost/rate values and see
    projected savings update in real time.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    df = _add_dwell(df)
    agg = df.dropna(subset=["_dwell"]).groupby(ACTIVITY_COL).agg(
        frequency=("_dwell", "count"),
        avg_duration=("_dwell", "mean"),
        total_time=("_dwell", "sum"),
    )
    agg["score"] = agg["frequency"] * agg["avg_duration"]
    agg = agg.sort_values("score", ascending=False).head(20)

    candidates: list[AutomationCandidate] = []
    for act, row in agg.iterrows():
        total_sec = float(row["total_time"])
        hours_saved = (total_sec / 3600.0) * automation_rate
        cost_saved = hours_saved * hourly_cost
        candidates.append(
            AutomationCandidate(
                activity=str(act),
                frequency=int(row["frequency"]),
                avg_duration_seconds=float(row["avg_duration"]),
                total_time_seconds=total_sec,
                score=float(row["score"]),
                estimated_hours_saved=hours_saved,
                estimated_cost_saved=cost_saved,
            )
        )

    return AutomationCandidatesResponse(
        candidates=candidates,
        hourly_cost_used=hourly_cost,
        automation_rate_used=automation_rate,
    )


# ─── 3. Variant evolution over time (Minit) ──────────────────────────────


class VariantEvolutionBucket(BaseModel):
    period: str
    total_cases: int
    top_variants: list[dict]  # [{rank, signature, case_count}]


class VariantEvolutionResponse(BaseModel):
    buckets: list[VariantEvolutionBucket]
    granularity: str


@router.get("/variant-evolution/{event_log_id}", response_model=VariantEvolutionResponse)
async def variant_evolution(
    event_log_id: UUID,
    granularity: str = Query("month", pattern="^(day|week|month|quarter)$"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Bucket cases by their start time and show how the top-5 variant
    mix shifts over time — the core Minit 'variant evolution' view."""
    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    if df.empty:
        return VariantEvolutionResponse(buckets=[], granularity=granularity)

    sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL])
    case_start = sorted_df.groupby(CASE_COL)[TIMESTAMP_COL].min()
    case_seq = sorted_df.groupby(CASE_COL)[ACTIVITY_COL].apply(tuple)

    freq_code = {
        "day": "D",
        "week": "W",
        "month": "ME",
        "quarter": "QE",
    }[granularity]
    periods = case_start.dt.to_period(freq_code[:1] if freq_code != "ME" and freq_code != "QE" else freq_code[0])
    # The above is brittle — use a cleaner to_period call instead:
    periods = case_start.dt.to_period(
        {"day": "D", "week": "W", "month": "M", "quarter": "Q"}[granularity]
    )

    out: list[VariantEvolutionBucket] = []
    for period, case_ids in case_start.groupby(periods).groups.items():
        bucket_seqs = case_seq.reindex(case_ids)
        counts = bucket_seqs.value_counts().head(5)
        top = [
            {
                "rank": i + 1,
                "signature": " → ".join(seq[:8]) + (" …" if len(seq) > 8 else ""),
                "case_count": int(cnt),
            }
            for i, (seq, cnt) in enumerate(counts.items())
        ]
        out.append(
            VariantEvolutionBucket(
                period=str(period),
                total_cases=len(case_ids),
                top_variants=top,
            )
        )

    return VariantEvolutionResponse(buckets=out, granularity=granularity)


# ─── 4. Attribute histogram for filter popover (Apromore) ────────────────


class AttributeHistogramResponse(BaseModel):
    attribute: str
    buckets: list[dict]  # [{label, count}]
    min: float | None = None
    max: float | None = None
    is_numeric: bool


@router.get("/attribute-histogram/{event_log_id}", response_model=AttributeHistogramResponse)
async def attribute_histogram(
    event_log_id: UUID,
    attribute: str = Query(..., description="Column name to histogram"),
    bins: int = Query(15, ge=2, le=60),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Return a histogram of an attribute's distribution.

    Used by the Apromore-style filter popover that lets users drag-range
    over a mini histogram to filter cases by numeric attribute, and by
    the categorical value-list for non-numeric attributes.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    if attribute not in df.columns:
        raise HTTPException(status_code=404, detail=f"Attribute '{attribute}' not found")

    series = df[attribute].dropna()
    if pd.api.types.is_numeric_dtype(series):
        counts, edges = np.histogram(series.astype(float), bins=bins)
        buckets = [
            {
                "label": f"{edges[i]:.2f}–{edges[i+1]:.2f}",
                "count": int(counts[i]),
                "min": float(edges[i]),
                "max": float(edges[i + 1]),
            }
            for i in range(len(counts))
        ]
        return AttributeHistogramResponse(
            attribute=attribute,
            buckets=buckets,
            min=float(series.min()),
            max=float(series.max()),
            is_numeric=True,
        )

    counts = series.value_counts().head(bins)
    buckets = [
        {"label": str(v), "count": int(c), "min": None, "max": None}
        for v, c in counts.items()
    ]
    return AttributeHistogramResponse(
        attribute=attribute,
        buckets=buckets,
        min=None,
        max=None,
        is_numeric=False,
    )


# ─── 5. Activity treemap breakdown (ABBYY Timeline) ──────────────────────


class TreemapCell(BaseModel):
    label: str
    value: int
    avg_duration_seconds: float | None


class ActivityTreemapResponse(BaseModel):
    activity: str
    split_by: str
    cells: list[TreemapCell]


@router.get("/activity-treemap/{event_log_id}", response_model=ActivityTreemapResponse)
async def activity_treemap(
    event_log_id: UUID,
    activity: str = Query(..., description="Activity to split"),
    split_by: str = Query("org:resource", description="Attribute column to split by"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Within one activity, break down occurrences by a chosen attribute
    and report the volume + avg dwell per cell. Powers the mid-map
    treemap drill-down copied from ABBYY Timeline."""
    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    subset = df[df[ACTIVITY_COL] == activity]
    if subset.empty:
        raise HTTPException(status_code=404, detail="Activity not found in log")
    if split_by not in df.columns:
        raise HTTPException(status_code=404, detail=f"Attribute '{split_by}' not in log")

    df = _add_dwell(df)
    sub = df[df[ACTIVITY_COL] == activity].dropna(subset=[split_by])
    grouped = sub.groupby(split_by).agg(
        count=(split_by, "size"),
        avg_dwell=("_dwell", "mean"),
    ).sort_values("count", ascending=False).head(20)

    cells = [
        TreemapCell(
            label=str(k),
            value=int(row["count"]),
            avg_duration_seconds=float(row["avg_dwell"]) if not pd.isna(row["avg_dwell"]) else None,
        )
        for k, row in grouped.iterrows()
    ]
    return ActivityTreemapResponse(activity=activity, split_by=split_by, cells=cells)


# ─── 6. Case Gantt (Disco) — ordered event timelines per case ────────────


class CaseGanttCase(BaseModel):
    case_id: str
    start: str
    end: str
    events: list[dict]  # [{activity, start, end}]


class CaseGanttResponse(BaseModel):
    cases: list[CaseGanttCase]
    total: int


@router.get("/case-gantt/{event_log_id}", response_model=CaseGanttResponse)
async def case_gantt(
    event_log_id: UUID,
    limit: int = Query(30, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Return per-case Gantt data: one lane per case, each event a
    horizontal block with start/end timestamps computed from the
    between-event dwell time."""
    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL])
    cases: list[CaseGanttCase] = []
    for cid, g in sorted_df.groupby(CASE_COL, sort=False):
        if len(cases) >= limit:
            break
        events = []
        ts = g[TIMESTAMP_COL].tolist()
        acts = g[ACTIVITY_COL].tolist()
        for i, (a, t) in enumerate(zip(acts, ts)):
            nxt = ts[i + 1] if i + 1 < len(ts) else t
            events.append(
                {
                    "activity": str(a),
                    "start": pd.Timestamp(t).isoformat(),
                    "end": pd.Timestamp(nxt).isoformat(),
                }
            )
        if events:
            cases.append(
                CaseGanttCase(
                    case_id=str(cid),
                    start=events[0]["start"],
                    end=events[-1]["end"],
                    events=events,
                )
            )

    return CaseGanttResponse(cases=cases, total=int(df[CASE_COL].nunique()))


# ─── 7. Cohort significance p-values (Apromore) ──────────────────────────


class CohortSignificanceRequest(BaseModel):
    event_log_id: UUID
    cohort_a_cases: list[str]
    cohort_b_cases: list[str]


class SignificanceResult(BaseModel):
    metric: str
    cohort_a_value: float
    cohort_b_value: float
    p_value: float | None
    significant: bool


class CohortSignificanceResponse(BaseModel):
    results: list[SignificanceResult]


@router.post("/cohort-significance", response_model=CohortSignificanceResponse)
async def cohort_significance(
    body: CohortSignificanceRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Compare two case cohorts on a few standard metrics (avg case
    duration, rework rate, cost if present). Uses Mann-Whitney U for
    each continuous metric since distributions are rarely normal in
    process data."""
    try:
        from scipy import stats as scistats  # type: ignore
    except Exception:
        scistats = None  # type: ignore

    await _assert_event_log_access(body.event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(body.event_log_id, db, current_user)

    a_set = set(body.cohort_a_cases)
    b_set = set(body.cohort_b_cases)
    case_times = df.groupby(CASE_COL)[TIMESTAMP_COL].agg(["min", "max"])
    case_times["_dur"] = (case_times["max"] - case_times["min"]).dt.total_seconds()
    dur_a = case_times.loc[case_times.index.isin(a_set), "_dur"].dropna()
    dur_b = case_times.loc[case_times.index.isin(b_set), "_dur"].dropna()

    def _p(x: pd.Series, y: pd.Series) -> float | None:
        if scistats is None or len(x) < 2 or len(y) < 2:
            return None
        try:
            _, p = scistats.mannwhitneyu(x, y, alternative="two-sided")
            return float(p)
        except Exception:
            return None

    results: list[SignificanceResult] = []
    if len(dur_a) > 0 and len(dur_b) > 0:
        p = _p(dur_a, dur_b)
        results.append(
            SignificanceResult(
                metric="avg_case_duration_seconds",
                cohort_a_value=float(dur_a.mean()),
                cohort_b_value=float(dur_b.mean()),
                p_value=p,
                significant=(p is not None and p < 0.05),
            )
        )

    # Rework rate = fraction of cases with a repeated activity
    def rework_rate(case_ids: set[str]) -> float:
        sub = df[df[CASE_COL].isin(case_ids)]
        if sub.empty:
            return 0.0
        cnt = sub.groupby([CASE_COL, ACTIVITY_COL]).size().reset_index(name="n")
        rework = cnt[cnt["n"] > 1][CASE_COL].nunique()
        return rework / max(len(case_ids), 1)

    ra = rework_rate(a_set)
    rb = rework_rate(b_set)
    # No Mann-Whitney on a single fraction — use chi-squared on the 2x2.
    if scistats is not None and len(a_set) > 0 and len(b_set) > 0:
        try:
            from scipy.stats import chi2_contingency
            a_rw = int(round(ra * len(a_set)))
            b_rw = int(round(rb * len(b_set)))
            chi_p = float(
                chi2_contingency(
                    [[a_rw, len(a_set) - a_rw], [b_rw, len(b_set) - b_rw]]
                )[1]
            )
        except Exception:
            chi_p = None
    else:
        chi_p = None

    results.append(
        SignificanceResult(
            metric="rework_rate",
            cohort_a_value=ra,
            cohort_b_value=rb,
            p_value=chi_p,
            significant=(chi_p is not None and chi_p < 0.05),
        )
    )

    if COST_COL in df.columns:
        case_cost = df.groupby(CASE_COL)[COST_COL].sum()
        ca = case_cost[case_cost.index.isin(a_set)]
        cb = case_cost[case_cost.index.isin(b_set)]
        if len(ca) > 0 and len(cb) > 0:
            p = _p(ca, cb)
            results.append(
                SignificanceResult(
                    metric="total_case_cost",
                    cohort_a_value=float(ca.mean()),
                    cohort_b_value=float(cb.mean()),
                    p_value=p,
                    significant=(p is not None and p < 0.05),
                )
            )

    return CohortSignificanceResponse(results=results)


# ─── 8. Compliance matrix (Minit / ARIS) ─────────────────────────────────


class ComplianceCell(BaseModel):
    rule: str
    segment: str
    pass_rate: float
    cases: int


class ComplianceMatrixResponse(BaseModel):
    segments: list[str]
    rules: list[str]
    cells: list[ComplianceCell]


@router.get("/compliance-matrix/{event_log_id}", response_model=ComplianceMatrixResponse)
async def compliance_matrix(
    event_log_id: UUID,
    segment_by: str = Query(..., description="Attribute to segment cases by"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Rule × segment heatmap of pass rates.

    Rules are inferred from the log's DECLARE-style structure: every
    case must touch a required activity, end at a valid end activity,
    and avoid rework above some threshold. Segments come from the
    chosen attribute column's distinct values.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    if segment_by not in df.columns:
        raise HTTPException(status_code=404, detail=f"Segment column '{segment_by}' not found")

    # Define a small set of structural rules we can check generically.
    # Real deployments would plug in the DECLARE model here.
    top_activities = df[ACTIVITY_COL].value_counts().head(5).index.tolist()
    required_activity = top_activities[0] if top_activities else None
    rules: list[str] = []
    if required_activity:
        rules.append(f"Has activity: {required_activity}")
    rules.append("No self-loop rework")
    rules.append("Completes within 30 days")

    segments = df[segment_by].dropna().astype(str).unique().tolist()[:12]

    case_times = df.groupby(CASE_COL)[TIMESTAMP_COL].agg(["min", "max"])
    case_times["_dur"] = (case_times["max"] - case_times["min"]).dt.total_seconds()
    case_seg = df.groupby(CASE_COL)[segment_by].first()

    cells: list[ComplianceCell] = []
    for seg in segments:
        seg_cases = case_seg[case_seg == seg].index
        if len(seg_cases) == 0:
            continue
        sub = df[df[CASE_COL].isin(seg_cases)]

        # Rule 1: touches required activity
        if required_activity:
            touched = sub[sub[ACTIVITY_COL] == required_activity][CASE_COL].nunique()
            cells.append(
                ComplianceCell(
                    rule=f"Has activity: {required_activity}",
                    segment=str(seg),
                    pass_rate=touched / len(seg_cases),
                    cases=int(len(seg_cases)),
                )
            )

        # Rule 2: no activity repeats in a single case
        rep = sub.groupby([CASE_COL, ACTIVITY_COL]).size().reset_index(name="n")
        bad = rep[rep["n"] > 1][CASE_COL].nunique()
        cells.append(
            ComplianceCell(
                rule="No self-loop rework",
                segment=str(seg),
                pass_rate=1.0 - (bad / len(seg_cases)),
                cases=int(len(seg_cases)),
            )
        )

        # Rule 3: completes within 30 days
        dur_seg = case_times.loc[case_times.index.isin(seg_cases), "_dur"].dropna()
        within = (dur_seg <= 30 * 86400).sum()
        cells.append(
            ComplianceCell(
                rule="Completes within 30 days",
                segment=str(seg),
                pass_rate=float(within / len(dur_seg)) if len(dur_seg) > 0 else 0.0,
                cases=int(len(seg_cases)),
            )
        )

    return ComplianceMatrixResponse(
        segments=[str(s) for s in segments],
        rules=rules,
        cells=cells,
    )


# ─── 9. Inter-app path graph (Workfellow) ────────────────────────────────


class InterAppEdge(BaseModel):
    source_app: str
    target_app: str
    count: int
    avg_dwell_seconds: float


class InterAppGraphResponse(BaseModel):
    apps: list[str]
    edges: list[InterAppEdge]


@router.get("/inter-app-graph/{event_log_id}", response_model=InterAppGraphResponse)
async def inter_app_graph(
    event_log_id: UUID,
    app_column: str = Query("application", description="Column carrying the application name"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Directed graph of worker navigation between applications.

    Each case's events are walked in order; every time the app column
    changes, we record a transition from app A to app B. Edge count =
    transition count, avg dwell = time spent on the source app
    segment before switching.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    if app_column not in df.columns:
        raise HTTPException(
            status_code=404,
            detail=f"No '{app_column}' column — enable task mining to populate it",
        )

    sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL])
    sorted_df["_prev_app"] = sorted_df.groupby(CASE_COL)[app_column].shift(1)
    sorted_df["_prev_ts"] = sorted_df.groupby(CASE_COL)[TIMESTAMP_COL].shift(1)
    transitions = sorted_df.dropna(subset=["_prev_app"])
    transitions = transitions[transitions["_prev_app"] != transitions[app_column]]
    transitions["_dwell"] = (
        transitions[TIMESTAMP_COL] - transitions["_prev_ts"]
    ).dt.total_seconds()

    grouped = transitions.groupby(["_prev_app", app_column]).agg(
        count=("_dwell", "size"),
        avg_dwell=("_dwell", "mean"),
    )
    edges: list[InterAppEdge] = [
        InterAppEdge(
            source_app=str(src),
            target_app=str(tgt),
            count=int(row["count"]),
            avg_dwell_seconds=float(row["avg_dwell"]) if not pd.isna(row["avg_dwell"]) else 0.0,
        )
        for (src, tgt), row in grouped.iterrows()
    ]
    apps = sorted({e.source_app for e in edges} | {e.target_app for e in edges})

    return InterAppGraphResponse(apps=apps, edges=edges)


# ─── 10. App × team time heatmap (Workfellow) ────────────────────────────


class HeatmapCell(BaseModel):
    team: str
    app: str
    seconds: float


class AppTeamHeatmapResponse(BaseModel):
    teams: list[str]
    apps: list[str]
    cells: list[HeatmapCell]


@router.get("/app-team-heatmap/{event_log_id}", response_model=AppTeamHeatmapResponse)
async def app_team_heatmap(
    event_log_id: UUID,
    app_column: str = Query("application"),
    team_column: str = Query(RESOURCE_COL),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Heatmap of time spent per (team, application) cell."""
    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    for col in (app_column, team_column):
        if col not in df.columns:
            raise HTTPException(status_code=404, detail=f"Column '{col}' not found")

    df = _add_dwell(df)
    sub = df.dropna(subset=["_dwell", app_column, team_column])
    grouped = sub.groupby([team_column, app_column])["_dwell"].sum()

    cells: list[HeatmapCell] = [
        HeatmapCell(team=str(t), app=str(a), seconds=float(v))
        for (t, a), v in grouped.items()
    ]
    teams = sorted({c.team for c in cells})
    apps = sorted({c.app for c in cells})
    return AppTeamHeatmapResponse(teams=teams, apps=apps, cells=cells)


# ─── 11. Filter expression language (Apromore power-user parity) ─────────
#
# Text-input DSL that looks like SQL but binds to the DataFrame:
#
#   case.duration > 3d and (activity = "Approve" or activity = "Reject")
#   case.start > "2024-01-01" and attr.amount > 500
#
# Supported:
#   - case.duration (seconds), case.start, case.end
#   - activity, resource, org:resource
#   - attr.<column> for any column in the DataFrame
#   - ops: = != > < >= <= contains
#   - durations: 30s / 5m / 2h / 7d
#   - dates: "2024-01-15" (ISO)
#   - combiners: and / or
#   - parentheses for grouping
#
# Implemented as a tiny recursive-descent parser over a hand-tokenised
# stream. Returns the intersection (or union) of case_id masks the
# caller can push into the filter chip store.


class FilterExpressionRequest(BaseModel):
    event_log_id: UUID
    expression: str


class FilterExpressionResponse(BaseModel):
    case_ids: list[str]
    total_matched: int
    total_in_log: int
    warnings: list[str]


# The filter-expression DSL engine now lives in the services layer
# (``app.services.filter_engine``) so other routers (e.g. custom_kpis) can
# evaluate filter expressions without importing from this sibling router.
from app.services.filter_engine import _evaluate_filter  # noqa: E402


@router.post("/filter-expression", response_model=FilterExpressionResponse)
async def filter_expression(
    body: FilterExpressionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Evaluate a filter expression against the event log.

    Grammar:
      <expr>  := <or>
      <or>    := <and> ( "or" <and> )*
      <and>   := <atom> ( "and" <atom> )*
      <atom>  := "(" <expr> ")" | <cmp>
      <cmp>   := <metric> <op> <value>

    Metrics: ``case.duration``, ``case.start``, ``case.end``,
    ``activity``, ``resource``, ``org:resource``, ``attr.<column>``.
    Ops: ``=``, ``!=``, ``>``, ``<``, ``>=``, ``<=``, ``contains``.
    Values: quoted strings, numbers, durations (``30s``/``5m``/``2h``/
    ``7d``), ISO dates inside quotes.

    Returns matching case_ids which the caller pushes into the filter
    chip store as a single ``case`` chip.
    """
    await _assert_event_log_access(body.event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(body.event_log_id, db, current_user)

    total_cases = int(df[CASE_COL].nunique())
    all_case_ids = set(str(c) for c in df[CASE_COL].unique())

    matched, warnings = _evaluate_filter(body.expression.strip(), df, all_case_ids)

    return FilterExpressionResponse(
        case_ids=sorted(matched),
        total_matched=len(matched),
        total_in_log=total_cases,
        warnings=warnings,
    )


# ─── 12. BPMN-Q pattern query (Apromore) ─────────────────────────────────
#
# Small structural query engine on the discovered directly-follows
# graph. Patterns supported:
#   loops: "A -> B -> A"
#   skip:  "A -> ?"  (any activity following A)
#   dead-end: "A -> <end>"


class BpmnQRequest(BaseModel):
    event_log_id: UUID
    pattern: str  # e.g. "Approve -> Pay" or "Approve -> ?"


class BpmnQResponse(BaseModel):
    matches: list[dict]
    pattern: str


@router.post("/bpmn-q", response_model=BpmnQResponse)
async def bpmn_q(
    body: BpmnQRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Evaluate a small structural pattern against the DFG of the log.

    Minimal grammar: `<src> -> <dst>` where `<dst>` can be `?` (any) or
    `<end>` (a terminal activity). Returns matching edges with their
    frequency so the caller can rank them.
    """
    await _assert_event_log_access(body.event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(body.event_log_id, db, current_user)

    parts = [p.strip() for p in body.pattern.split("->")]
    if len(parts) != 2:
        raise HTTPException(status_code=400, detail="Pattern must be 'A -> B'")
    src, dst = parts[0], parts[1]

    sorted_df = _add_dwell(df)
    sorted_df = sorted_df.dropna(subset=["_next_act"]).rename(columns={"_next_act": "_next"})

    mask = sorted_df[ACTIVITY_COL] == src
    if dst == "?":
        pass  # any successor
    elif dst == "<end>":
        ends = set(df.groupby(CASE_COL)[ACTIVITY_COL].last().unique())
        mask &= sorted_df["_next"].isin(ends)
    else:
        mask &= sorted_df["_next"] == dst

    matched = sorted_df[mask]
    grouped = matched.groupby([ACTIVITY_COL, "_next"]).size().reset_index(name="count")
    results = [
        {"source": str(r[ACTIVITY_COL]), "target": str(r["_next"]), "count": int(r["count"])}
        for _, r in grouped.iterrows()
    ]
    return BpmnQResponse(matches=results, pattern=body.pattern)


# ─── 13. Hierarchical activity drill (IBM) ───────────────────────────────
#
# Group activity labels into higher-level buckets using user-supplied
# regex rules, then return aggregated DFG. Enables multi-level drill
# from a high-level P2P view down to detailed steps.


class HierarchyRule(BaseModel):
    pattern: str  # regex
    bucket: str


class HierarchyRequest(BaseModel):
    event_log_id: UUID
    rules: list[HierarchyRule]


class HierarchyBucket(BaseModel):
    bucket: str
    activity_count: int
    total_events: int
    avg_duration_seconds: float


class HierarchyResponse(BaseModel):
    buckets: list[HierarchyBucket]


@router.post("/hierarchy", response_model=HierarchyResponse)
async def hierarchy(
    body: HierarchyRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Aggregate activities into higher-level buckets via regex rules.

    The first rule whose pattern matches an activity name assigns that
    activity to the rule's bucket. Activities with no matching rule land
    in a synthetic ``other`` bucket. Returns volume + avg dwell per
    bucket so the caller can render a collapsed DFG.
    """
    import re

    await _assert_event_log_access(body.event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(body.event_log_id, db, current_user)

    compiled = [(re.compile(r.pattern, re.IGNORECASE), r.bucket) for r in body.rules]

    def bucket_for(act: str) -> str:
        for pat, b in compiled:
            if pat.search(act):
                return b
        return "other"

    sorted_df = _add_dwell(df)
    sorted_df["_bucket"] = sorted_df[ACTIVITY_COL].astype(str).apply(bucket_for)

    agg = sorted_df.groupby("_bucket").agg(
        total_events=("_bucket", "size"),
        avg_dwell=("_dwell", "mean"),
        unique_acts=(ACTIVITY_COL, "nunique"),
    )
    buckets = [
        HierarchyBucket(
            bucket=str(b),
            activity_count=int(row["unique_acts"]),
            total_events=int(row["total_events"]),
            avg_duration_seconds=(
                float(row["avg_dwell"]) if not pd.isna(row["avg_dwell"]) else 0.0
            ),
        )
        for b, row in agg.iterrows()
    ]
    return HierarchyResponse(buckets=buckets)
