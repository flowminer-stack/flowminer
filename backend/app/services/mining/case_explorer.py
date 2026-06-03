"""Case-level exploration views: case lists, case detail, timeline, dotted chart, activity detail."""

import logging
from typing import Optional

import numpy as np
import pandas as pd

from app.services.ingestion import (
    CASE_COL,
    ACTIVITY_COL,
    TIMESTAMP_COL,
    RESOURCE_COL,
    COST_COL,
)
from app.services.rust_accel import (
    discover_performance_dfg as _rs_perf_dfg,
    compute_efg as _rs_efg,
    compute_temporal_profile as _rs_temporal,
    compute_sna as _rs_sna,
    compute_case_overlap as _rs_case_overlap,
    compute_rework as _rs_rework,
    compute_edge_stats as _rs_edge_stats,
)

logger = logging.getLogger(__name__)


def get_cases(df: pd.DataFrame, limit: int = 1000) -> dict:
    """
    Return summary information for each case in the event log.

    For each case computes event count, duration, start/end activity,
    start/end time, and the activity variant (sequence joined by " → ").
    Results are limited to the first `limit` cases for performance.

    Returns:
        dict with keys: cases (list of case dicts), total_cases (int)
    """
    total_cases = df[CASE_COL].nunique()
    grouped = df.groupby(CASE_COL, sort=False)

    cases = []
    for case_id, group in grouped:
        group = group.sort_values(TIMESTAMP_COL)
        activities = group[ACTIVITY_COL].tolist()
        timestamps = group[TIMESTAMP_COL].tolist()

        start_ts = timestamps[0]
        end_ts = timestamps[-1]

        try:
            duration = (end_ts - start_ts).total_seconds()
        except Exception:
            duration = None

        cases.append({
            "case_id": str(case_id),
            "event_count": len(group),
            "duration_seconds": duration,
            "start_activity": str(activities[0]),
            "end_activity": str(activities[-1]),
            "start_time": pd.Timestamp(start_ts).isoformat(),
            "end_time": pd.Timestamp(end_ts).isoformat(),
            "variant": " \u2192 ".join(str(a) for a in activities),
        })

        if len(cases) >= limit:
            break

    return {"cases": cases, "total_cases": total_cases}


def get_case_detail(df: pd.DataFrame, case_id: str) -> Optional[dict]:
    """
    Return all events for a specific case, including duration to the next
    event and resource attribute if available.

    Returns:
        dict with keys: case_id, events (list), total_duration — or None if
        the case does not exist in the log.
    """
    case_df = df[df[CASE_COL] == case_id].sort_values(TIMESTAMP_COL)
    if case_df.empty:
        return None

    has_resource = RESOURCE_COL in case_df.columns
    timestamps = case_df[TIMESTAMP_COL].tolist()
    activities = case_df[ACTIVITY_COL].tolist()
    resources = case_df[RESOURCE_COL].tolist() if has_resource else [None] * len(case_df)

    events = []
    for i, (activity, ts, resource) in enumerate(zip(activities, timestamps, resources)):
        if i < len(timestamps) - 1:
            try:
                duration_to_next = (timestamps[i + 1] - ts).total_seconds()
            except Exception:
                duration_to_next = None
        else:
            duration_to_next = None

        resource_val = str(resource) if resource is not None and not pd.isna(resource) else None

        events.append({
            "activity": str(activity),
            "timestamp": pd.Timestamp(ts).isoformat(),
            "resource": resource_val,
            "duration_to_next": duration_to_next,
        })

    try:
        total_duration = (timestamps[-1] - timestamps[0]).total_seconds()
    except Exception:
        total_duration = None

    return {
        "case_id": case_id,
        "events": events,
        "total_duration": total_duration,
    }


def get_timeline(df: pd.DataFrame, limit: int = 5000) -> dict:
    """
    Return events sorted by timestamp for animation replay, including the
    previous activity for each case so the caller knows which process-map
    edge a token is traversing.

    Results are limited to the first `limit` events for performance.

    Returns:
        dict with keys: events (list), start_time (str), end_time (str),
        total_events (int)
    """
    sorted_df = df.sort_values(TIMESTAMP_COL).reset_index(drop=True)
    total_events = len(sorted_df)

    # Track the last seen activity per case
    last_activity: dict[str, str] = {}
    events = []

    for _, row in sorted_df.head(limit).iterrows():
        case_id = str(row[CASE_COL])
        activity = str(row[ACTIVITY_COL])
        ts = pd.Timestamp(row[TIMESTAMP_COL]).isoformat()

        source = last_activity.get(case_id)
        last_activity[case_id] = activity

        events.append({
            "timestamp": ts,
            "case_id": case_id,
            "activity": activity,
            "source": source,
        })

    start_time = pd.Timestamp(sorted_df[TIMESTAMP_COL].iloc[0]).isoformat() if total_events else ""
    end_time = pd.Timestamp(sorted_df[TIMESTAMP_COL].iloc[-1]).isoformat() if total_events else ""

    return {
        "events": events,
        "start_time": start_time,
        "end_time": end_time,
        "total_events": total_events,
    }


def get_dotted_chart(df: pd.DataFrame, limit: int = 10000) -> dict:
    """
    Return event data for a dotted chart visualization.

    Sorts by timestamp and assigns a numeric case_index to each case based
    on first-occurrence order. Includes resource if the org:resource column
    is present. Results are capped at `limit` events.

    Returns:
        dict with keys: events, activities, resources, case_count, time_range
    """
    if df.empty:
        return {
            "events": [],
            "activities": [],
            "resources": [],
            "case_count": 0,
            "time_range": {"start": "", "end": ""},
        }

    sorted_df = df.sort_values(TIMESTAMP_COL).reset_index(drop=True)
    has_resource = RESOURCE_COL in sorted_df.columns

    # Build case_index by first-occurrence order
    case_index_map: dict[str, int] = {}
    next_index = 0
    for case_id in sorted_df[CASE_COL]:
        key = str(case_id)
        if key not in case_index_map:
            case_index_map[key] = next_index
            next_index += 1

    activities = sorted(df[ACTIVITY_COL].dropna().unique().tolist(), key=str)
    resources: list[str] = []
    if has_resource:
        resources = sorted(
            [str(r) for r in df[RESOURCE_COL].dropna().unique().tolist()],
            key=str,
        )

    events = []
    for _, row in sorted_df.head(limit).iterrows():
        case_id = str(row[CASE_COL])
        resource_val = None
        if has_resource:
            r = row[RESOURCE_COL]
            resource_val = str(r) if r is not None and not pd.isna(r) else None
        events.append({
            "timestamp": pd.Timestamp(row[TIMESTAMP_COL]).isoformat(),
            "case_id": case_id,
            "activity": str(row[ACTIVITY_COL]),
            "resource": resource_val,
            "case_index": case_index_map[case_id],
        })

    start_time = pd.Timestamp(sorted_df[TIMESTAMP_COL].iloc[0]).isoformat()
    end_time = pd.Timestamp(sorted_df[TIMESTAMP_COL].iloc[-1]).isoformat()

    return {
        "events": events,
        "activities": [str(a) for a in activities],
        "resources": resources,
        "case_count": df[CASE_COL].nunique(),
        "time_range": {"start": start_time, "end": end_time},
    }


def get_activity_detail(engine, df: pd.DataFrame, activity_name: str) -> dict:
    """
    Return detailed statistics for a single activity.

    Computes duration (time to next event in same case), a 10-bin histogram,
    resource distribution, predecessor/successor frequencies from the DFG,
    and start/end flags.

    Returns:
        dict compatible with ActivityDetailResponse, or raises ValueError if
        the activity does not exist in the log.
    """
    import numpy as np

    activity_df = df[df[ACTIVITY_COL] == activity_name]
    if activity_df.empty:
        raise ValueError(f"Activity '{activity_name}' not found in event log")

    frequency = int(len(activity_df))
    case_count = int(activity_df[CASE_COL].nunique())

    # Compute duration (time to next event in same case)
    from app.services.transition_cache import get_transitions
    _t = get_transitions(df)
    if _t is not None:
        df["_duration"] = _t.duration_secs
        df.loc[_t.is_last, "_duration"] = np.nan
    else:
        sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL]).copy()
        sorted_df["_next_ts"] = sorted_df.groupby(CASE_COL)[TIMESTAMP_COL].shift(-1)
        sorted_df["_duration"] = (sorted_df["_next_ts"] - sorted_df[TIMESTAMP_COL]).dt.total_seconds()
        df = sorted_df

    activity_rows = df[df[ACTIVITY_COL] == activity_name].dropna(subset=["_duration"])
    durations = activity_rows["_duration"].tolist()

    avg_duration: float | None = None
    median_duration: float | None = None
    min_duration: float | None = None
    max_duration: float | None = None
    duration_histogram: list[dict] = []

    if durations:
        dur_series = pd.Series(durations)
        avg_duration = float(dur_series.mean())
        median_duration = float(dur_series.median())
        min_duration = float(dur_series.min())
        max_duration = float(dur_series.max())

        counts, bin_edges = np.histogram(durations, bins=10)
        duration_histogram = [
            {
                "bin_start": float(bin_edges[i]),
                "bin_end": float(bin_edges[i + 1]),
                "count": int(counts[i]),
            }
            for i in range(len(counts))
        ]

    # Resource distribution
    resources_out: list[dict] = []
    if RESOURCE_COL in df.columns:
        res_counts = (
            activity_df[RESOURCE_COL]
            .dropna()
            .astype(str)
            .value_counts()
        )
        resources_out = [
            {"name": str(r), "count": int(c)}
            for r, c in res_counts.items()
        ]

    # Predecessor / successor from DFG
    dfg_result = engine.discovery_service.discover_dfg(df)
    edges = dfg_result.get("edges", [])

    predecessors: list[dict] = []
    successors: list[dict] = []

    # DFG edge source/target use sanitized IDs — rebuild a label→id mapping
    node_label_to_id = {n["label"]: n["id"] for n in dfg_result.get("nodes", [])}
    act_id = node_label_to_id.get(activity_name, "")

    for edge in edges:
        if edge["target"] == act_id:
            # find label for source
            src_label = next(
                (n["label"] for n in dfg_result.get("nodes", []) if n["id"] == edge["source"]),
                edge["source"],
            )
            predecessors.append({"activity": src_label, "frequency": edge["frequency"]})
        if edge["source"] == act_id:
            tgt_label = next(
                (n["label"] for n in dfg_result.get("nodes", []) if n["id"] == edge["target"]),
                edge["target"],
            )
            successors.append({"activity": tgt_label, "frequency": edge["frequency"]})

    predecessors.sort(key=lambda x: -x["frequency"])
    successors.sort(key=lambda x: -x["frequency"])

    # Start / end
    start_acts = set(engine.discovery_service._get_start_end_activities(df)[0].keys())
    end_acts = set(engine.discovery_service._get_start_end_activities(df)[1].keys())

    return {
        "activity": activity_name,
        "frequency": frequency,
        "case_count": case_count,
        "avg_duration": avg_duration,
        "median_duration": median_duration,
        "min_duration": min_duration,
        "max_duration": max_duration,
        "duration_histogram": duration_histogram,
        "resources": resources_out,
        "predecessors": predecessors,
        "successors": successors,
        "is_start": activity_name in start_acts,
        "is_end": activity_name in end_acts,
    }
