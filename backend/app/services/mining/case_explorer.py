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
    # Stable sort: secondary key (CASE_COL) breaks timestamp ties deterministically.
    sorted_df = df.sort_values([TIMESTAMP_COL, CASE_COL]).reset_index(drop=True)
    total_events = len(sorted_df)

    # Vectorised: compute source (previous activity per case) via a per-case shift.
    # sort_values is already done; groupby(sort=False) preserves that order.
    sorted_df = sorted_df.assign(
        source=sorted_df.groupby(CASE_COL, sort=False)[ACTIVITY_COL].shift(1)
    )

    head = sorted_df.head(limit)

    # Produce isoformat strings (e.g. "2013-11-07T08:18:29+00:00") vectorially.
    # strftime %z gives "+0000"; insert colon to match pd.Timestamp.isoformat() output.
    _ts_raw = head[TIMESTAMP_COL].dt.strftime("%Y-%m-%dT%H:%M:%S%z")
    timestamps = [s[:-2] + ":" + s[-2:] if len(s) > 6 and s[-5] in "+-" else s
                  for s in _ts_raw]
    case_ids = head[CASE_COL].astype(str).tolist()
    activities = head[ACTIVITY_COL].astype(str).tolist()
    sources = head["source"].tolist()  # NaN becomes float nan — convert below

    events = [
        {
            "timestamp": ts,
            "case_id": cid,
            "activity": act,
            "source": None if (src != src) else str(src),  # NaN check via nan != nan
        }
        for ts, cid, act, src in zip(timestamps, case_ids, activities, sources)
    ]

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

    # Stable sort: secondary key (CASE_COL) breaks timestamp ties deterministically.
    sorted_df = df.sort_values([TIMESTAMP_COL, CASE_COL]).reset_index(drop=True)
    has_resource = RESOURCE_COL in sorted_df.columns

    # Vectorised case_index: rank cases by first occurrence (first row in sorted order).
    # drop_duplicates keeps the first row per case, giving a contiguous 0-based rank.
    first_occ = sorted_df[CASE_COL].astype(str).drop_duplicates()
    case_index_map: dict[str, int] = {cid: i for i, cid in enumerate(first_occ)}

    # Map case_index onto the full (sorted) frame vectorially.
    sorted_df = sorted_df.assign(
        _case_id_str=sorted_df[CASE_COL].astype(str),
        _case_index=sorted_df[CASE_COL].astype(str).map(case_index_map),
    )

    activities = sorted(df[ACTIVITY_COL].dropna().unique().tolist(), key=str)
    resources: list[str] = []
    if has_resource:
        resources = sorted(
            [str(r) for r in df[RESOURCE_COL].dropna().unique().tolist()],
            key=str,
        )

    head = sorted_df.head(limit)

    # Produce isoformat strings (e.g. "2013-11-07T08:18:29+00:00") vectorially.
    # strftime %z gives "+0000"; insert colon to match pd.Timestamp.isoformat() output.
    _ts_raw = head[TIMESTAMP_COL].dt.strftime("%Y-%m-%dT%H:%M:%S%z")
    timestamps = [s[:-2] + ":" + s[-2:] if len(s) > 6 and s[-5] in "+-" else s
                  for s in _ts_raw]
    case_ids = head["_case_id_str"].tolist()
    act_vals = head[ACTIVITY_COL].astype(str).tolist()
    case_idxs = head["_case_index"].tolist()

    if has_resource:
        raw_resources = head[RESOURCE_COL].tolist()
        events = [
            {
                "timestamp": ts,
                "case_id": cid,
                "activity": act,
                "resource": None if (r != r or r is None) else str(r),  # NaN via nan!=nan
                "case_index": int(ci),
            }
            for ts, cid, act, r, ci in zip(timestamps, case_ids, act_vals, raw_resources, case_idxs)
        ]
    else:
        events = [
            {
                "timestamp": ts,
                "case_id": cid,
                "activity": act,
                "resource": None,
                "case_index": int(ci),
            }
            for ts, cid, act, ci in zip(timestamps, case_ids, act_vals, case_idxs)
        ]

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
        # The DFG view identifies nodes by a *sanitized* id (lowercased, with
        # spaces/slashes collapsed to underscores). If the exact name doesn't
        # match, resolve that sanitized id back to the original activity name so
        # clicking a node never 404s. Only accept an unambiguous match.
        from app.services.discovery import _sanitize_id

        target = _sanitize_id(activity_name)
        candidates = [
            a for a in df[ACTIVITY_COL].dropna().unique()
            if _sanitize_id(a) == target
        ]
        if len(candidates) == 1:
            activity_name = candidates[0]
            activity_df = df[df[ACTIVITY_COL] == activity_name]
        if activity_df.empty:
            raise ValueError(f"Activity '{activity_name}' not found in event log")

    frequency = int(len(activity_df))
    case_count = int(activity_df[CASE_COL].nunique())

    # Resource distribution — cheap, over this activity's own rows only.
    resources_out: list[dict] = []
    if RESOURCE_COL in df.columns:
        res_counts = activity_df[RESOURCE_COL].dropna().astype(str).value_counts()
        resources_out = [{"name": str(r), "count": int(c)} for r, c in res_counts.items()]

    avg_duration: float | None = None
    median_duration: float | None = None
    min_duration: float | None = None
    max_duration: float | None = None
    duration_histogram: list[dict] = []
    predecessors: list[dict] = []
    successors: list[dict] = []
    is_start = False
    is_end = False

    def _fill_duration_stats(d: np.ndarray) -> None:
        nonlocal avg_duration, median_duration, min_duration, max_duration, duration_histogram
        if d.size == 0:
            return
        avg_duration = float(np.mean(d))
        median_duration = float(np.median(d))
        min_duration = float(np.min(d))
        max_duration = float(np.max(d))
        counts, bin_edges = np.histogram(d, bins=10)
        duration_histogram = [
            {"bin_start": float(bin_edges[i]), "bin_end": float(bin_edges[i + 1]), "count": int(counts[i])}
            for i in range(len(counts))
        ]

    from app.services.transition_cache import get_transitions
    _t = get_transitions(df)

    if _t is not None:
        # FAST PATH — derive durations, predecessors/successors and start/end
        # straight from the cached per-event transition arrays. This avoids
        # rebuilding the entire DFG and re-scanning start/end activities on every
        # click, which is what made this slow on large logs (e.g. BPIC).
        labels = _t.act_labels
        try:
            a_idx = labels.index(activity_name)
        except ValueError:
            a_idx = -1
        # Current-activity codes aligned to the same category order the cached
        # next_act_code uses, so masks line up across the arrays.
        cur = np.asarray(pd.Categorical(df[ACTIVITY_COL], categories=labels).codes)
        nxt = _t.next_act_code
        is_last = _t.is_last
        n_labels = len(labels)

        out_mask = (cur == a_idx) & (~is_last)
        if a_idx >= 0 and out_mask.any():
            _fill_duration_stats(_t.duration_secs[out_mask][np.isfinite(_t.duration_secs[out_mask])])
            succ_codes = nxt[out_mask]
            succ_codes = succ_codes[succ_codes >= 0]
            if succ_codes.size:
                sc = np.bincount(succ_codes, minlength=n_labels)
                successors = [
                    {"activity": labels[c], "frequency": int(sc[c])} for c in np.nonzero(sc)[0]
                ]
                successors.sort(key=lambda x: -x["frequency"])

        if a_idx >= 0:
            pred_mask = nxt == a_idx
            if pred_mask.any():
                pred_codes = cur[pred_mask]
                pred_codes = pred_codes[pred_codes >= 0]
                if pred_codes.size:
                    pc = np.bincount(pred_codes, minlength=n_labels)
                    predecessors = [
                        {"activity": labels[c], "frequency": int(pc[c])} for c in np.nonzero(pc)[0]
                    ]
                    predecessors.sort(key=lambda x: -x["frequency"])

            # In time-sorted order the first event of each case is the one right
            # after a case-final event (plus index 0). Compare to this activity's
            # codes — no second pm4py start/end scan.
            sidx = _t.sorted_idx
            last_sorted = is_last[sidx]
            cur_sorted = cur[sidx]
            first_sorted = np.empty_like(last_sorted)
            first_sorted[0] = True
            first_sorted[1:] = last_sorted[:-1]
            is_start = bool(np.any((cur_sorted == a_idx) & first_sorted))
            is_end = bool(np.any((cur_sorted == a_idx) & last_sorted))
    else:
        # FALLBACK (Rust accel unavailable) — pandas durations + a single DFG
        # discovery + one start/end scan (still avoids the old double call).
        sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL]).copy()
        sorted_df["_next_ts"] = sorted_df.groupby(CASE_COL)[TIMESTAMP_COL].shift(-1)
        sorted_df["_duration"] = (sorted_df["_next_ts"] - sorted_df[TIMESTAMP_COL]).dt.total_seconds()
        _fill_duration_stats(
            sorted_df.loc[sorted_df[ACTIVITY_COL] == activity_name, "_duration"].dropna().to_numpy()
        )

        dfg_result = engine.discovery_service.discover_dfg(df)
        node_label_to_id = {n["label"]: n["id"] for n in dfg_result.get("nodes", [])}
        id_to_label = {n["id"]: n["label"] for n in dfg_result.get("nodes", [])}
        act_id = node_label_to_id.get(activity_name, "")
        for edge in dfg_result.get("edges", []):
            if edge["target"] == act_id:
                predecessors.append(
                    {"activity": id_to_label.get(edge["source"], edge["source"]), "frequency": edge["frequency"]}
                )
            if edge["source"] == act_id:
                successors.append(
                    {"activity": id_to_label.get(edge["target"], edge["target"]), "frequency": edge["frequency"]}
                )
        predecessors.sort(key=lambda x: -x["frequency"])
        successors.sort(key=lambda x: -x["frequency"])

        start_acts, end_acts = engine.discovery_service._get_start_end_activities(df)
        is_start = activity_name in start_acts
        is_end = activity_name in end_acts

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
        "is_start": is_start,
        "is_end": is_end,
    }
