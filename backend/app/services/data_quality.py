"""
Data quality service.

Pure computation logic for the event-log data-quality report, extracted out
of ``app.api.mining`` (the ``GET /mining/quality/{event_log_id}`` route still
owns access checks, caching, and event-log loading and calls into here).

Checks for missing values, duplicate events, timestamp anomalies,
single-event cases, high-frequency catch-all activities, and rare activities,
then returns a scored summary with individual issues.

The returned ``issues`` are plain ``dict`` payloads (already ``model_dump``-ed)
so the result dict is JSON-serializable for caching and can be fed straight
into ``DataQualityResponse(**result)`` by the caller.
"""

import logging

import pandas as pd

from app.schemas.discovery import DataQualityIssue
from app.services.ingestion import CASE_COL, ACTIVITY_COL, TIMESTAMP_COL

logger = logging.getLogger(__name__)

# Score: start at 100, subtract per severity.
_DEDUCTIONS = {"error": 20, "warning": 10, "info": 5}


def compute_data_quality(df: pd.DataFrame) -> dict:
    """Run the data-quality checks on an event-log DataFrame.

    Returns a dict shaped exactly like the ``DataQualityResponse`` payload:
    ``{"overall_score", "total_events", "issues"}`` where ``issues`` is a list
    of ``DataQualityIssue.model_dump()`` payloads.
    """
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
    # Skip the O(n log n) sort when timestamps are already globally monotonic —
    # global monotonicity implies per-case monotonicity, so out_of_order == 0.
    try:
        ts_col_full = df[TIMESTAMP_COL].dropna()
        if ts_col_full.is_monotonic_increasing:
            out_of_order = 0
        else:
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
    score = 100.0
    for issue in issues:
        score -= _DEDUCTIONS.get(issue.severity, 0)
    score = max(0.0, score)

    return {
        "overall_score": round(score, 1),
        "total_events": total_events,
        "issues": [i.model_dump() for i in issues],
    }
