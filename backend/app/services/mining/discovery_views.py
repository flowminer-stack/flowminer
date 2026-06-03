"""Process-graph / edge-level discovery views: edge stats, performance DFG, EFG, rework, performance spectrum, process comparison."""

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


def get_edge_stats(df: pd.DataFrame,
    source: str,
    target: str,
    bins: int = 20,
) -> dict:
    """
    Return statistics for a single (source → target) transition.

    Walks each case in time order and collects the duration whenever
    activity ``source`` is immediately followed by activity
    ``target``. Returns frequency, coverage, duration quantiles, a
    histogram, and the cases that contain the transition — what
    the Edge Detail popover renders.

    **ID vs label matching**. The discovery service sanitises
    activity names into node IDs (lowercase, spaces →
    underscores — see ``app.services.discovery._sanitize_id``).
    The frontend sends those sanitised IDs when a user clicks an
    edge on the process map, so we sanitise both sides before
    comparing — otherwise every edge on a heuristic / inductive
    miner's output reports zero traversals because the labels in
    the log are ``"Place in Stock"`` but the edge carries
    ``"place_in_stock"``.

    **Eventually-follows fallback**. Inductive / heuristic miners
    produce edges that represent abstracted control flow rather
    than direct ``A→B`` transitions in the log. If no direct
    transitions are found for the requested pair, we compute
    eventually-follows stats for the same pair and return those
    instead, flagged via ``is_eventually_follows=True`` so the UI
    can label the numbers appropriately.

    Returns:
        dict with keys: source, target, frequency, case_count_with,
        case_count_without, coverage_pct, avg_duration,
        median_duration, p95_duration, min_duration, max_duration,
        histogram, is_eventually_follows.
    """
    # Rust fast path (~180-250x faster)
    rs_result = _rs_edge_stats(df, source, target, bins)
    if rs_result is not None:
        return rs_result

    def _sanitize(name: object) -> str:
        return (
            str(name)
            .replace(" ", "_")
            .replace("/", "_")
            .replace("\\", "_")
            .lower()
        )

    src_key = _sanitize(source)
    tgt_key = _sanitize(target)
    total_cases = int(df[CASE_COL].nunique())
    durations: list[float] = []
    cases_with: set[str] = set()

    # Pre-sanitise the activity column once rather than re-running
    # _sanitize on every group iteration. This keeps the hot loop
    # tight when the log has thousands of cases.
    sanitised_df = df.sort_values(TIMESTAMP_COL).copy()
    sanitised_df["_activity_key"] = sanitised_df[ACTIVITY_COL].map(_sanitize)
    grouped = sanitised_df.groupby(CASE_COL, sort=False)

    for case_id, group in grouped:
        activities = group["_activity_key"].tolist()
        timestamps = group[TIMESTAMP_COL].tolist()
        hit = False
        for i in range(len(activities) - 1):
            if activities[i] == src_key and activities[i + 1] == tgt_key:
                try:
                    delta = (
                        pd.Timestamp(timestamps[i + 1]) - pd.Timestamp(timestamps[i])
                    ).total_seconds()
                    if delta >= 0:
                        durations.append(float(delta))
                except Exception:
                    pass
                hit = True
        if hit:
            cases_with.add(str(case_id))

    # Eventually-follows fallback — only runs if the direct search
    # returned nothing. Walks each case, finds every source
    # occurrence, and pairs it with the next target occurrence.
    is_eventually_follows = False
    if not durations:
        ef_durations: list[float] = []
        ef_cases: set[str] = set()
        for case_id, group in grouped:
            activities = group["_activity_key"].tolist()
            timestamps = group[TIMESTAMP_COL].tolist()
            hit = False
            for i, a in enumerate(activities):
                if a != src_key:
                    continue
                for j in range(i + 1, len(activities)):
                    if activities[j] == tgt_key:
                        try:
                            delta = (
                                pd.Timestamp(timestamps[j])
                                - pd.Timestamp(timestamps[i])
                            ).total_seconds()
                            if delta >= 0:
                                ef_durations.append(float(delta))
                        except Exception:
                            pass
                        hit = True
                        break  # first following target per src
            if hit:
                ef_cases.add(str(case_id))
        if ef_durations:
            durations = ef_durations
            cases_with = ef_cases
            is_eventually_follows = True

    frequency = len(durations)
    case_count_with = len(cases_with)
    case_count_without = max(0, total_cases - case_count_with)
    coverage_pct = (
        (case_count_with / total_cases * 100.0) if total_cases else 0.0
    )

    if durations:
        series = pd.Series(durations)
        avg_duration = float(series.mean())
        median_duration = float(series.median())
        p95_duration = float(series.quantile(0.95))
        min_duration = float(series.min())
        max_duration = float(series.max())
    else:
        avg_duration = median_duration = p95_duration = 0.0
        min_duration = max_duration = 0.0

    # Histogram: fixed-width bins between min and p99 (clip outliers)
    histogram: list[dict] = []
    if durations:
        upper = float(pd.Series(durations).quantile(0.99)) or max_duration
        lower = min_duration
        if upper <= lower:
            upper = lower + 1.0
        width = (upper - lower) / bins
        counts = [0] * bins
        for d in durations:
            if d > upper:
                counts[-1] += 1
                continue
            idx = int((d - lower) / width) if width else 0
            idx = min(max(idx, 0), bins - 1)
            counts[idx] += 1
        for i, c in enumerate(counts):
            histogram.append(
                {
                    "bin_start": lower + i * width,
                    "bin_end": lower + (i + 1) * width,
                    "count": int(c),
                }
            )

    return {
        "source": source,
        "target": target,
        "frequency": int(frequency),
        "case_count_with": int(case_count_with),
        "case_count_without": int(case_count_without),
        "coverage_pct": float(coverage_pct),
        "avg_duration": avg_duration,
        "median_duration": median_duration,
        "p95_duration": p95_duration,
        "min_duration": min_duration,
        "max_duration": max_duration,
        "histogram": histogram,
        "is_eventually_follows": is_eventually_follows,
    }


def get_performance_dfg(df: pd.DataFrame) -> dict:
    """
    Discover a performance DFG where edge weights are average transition
    durations in seconds.

    Returns:
        dict with keys: edges (list of {source, target, avg_duration}),
        activities (sorted list of activity names)
    """
    perf_dfg, _sa, _ea = _rs_perf_dfg(df)

    edges = []
    for (src, tgt), dur in perf_dfg.items():
        if isinstance(dur, dict):
            avg = dur.get("mean", dur.get("avg", 0))
        else:
            avg = dur
        try:
            avg = float(avg)
        except (TypeError, ValueError):
            avg = 0.0
        edges.append({"source": str(src), "target": str(tgt), "avg_duration": avg})

    activities = sorted({node for edge in edges for node in (edge["source"], edge["target"])})

    return {"edges": edges, "activities": activities}


def get_efg(df: pd.DataFrame) -> dict:
    """
    Discover the Eventually-Follows Graph: all pairs (a, b) where a
    eventually precedes b within a case, with occurrence counts.

    Complexity: O(N·k) where N is total events and k is the alphabet
    size. The suffix-count trick below is ~100–500× faster than
    pm4py's O(N·m̄) implementation where m̄ is the average trace
    length — which blows up on pathological logs like the Forklift
    flatten (3 cases × ~2579 events each).

    How it works: walk each case's trace right-to-left. Maintain a
    Counter `suffix` of activities we've seen so far. For each event
    at position i, every activity in `suffix` is an event that
    *eventually follows* acts[i] — so we add counts[(acts[i], b)] += n
    for each b,n in suffix, then record acts[i] itself in suffix.

    Ties on timestamps are broken by the dataframe's existing row
    order — callers normalise via ingestion_service.load_event_log
    which sorts by (CASE_COL, TIMESTAMP_COL) with pandas' stable
    mergesort, so this matches pm4py's default ordering.

    Returns:
        dict with keys: pairs (list of {source, target, frequency}),
        activities (sorted list)
    """
    # Rust fast path (~90-136x faster)
    rs_counts = _rs_efg(df)
    if rs_counts is not None:
        counts = rs_counts
    else:
        from collections import Counter, defaultdict
        counts: "defaultdict[tuple[str, str], int]" = defaultdict(int)
        for _case_id, group in df.groupby(CASE_COL, sort=False):
            acts = group[ACTIVITY_COL].tolist()
            suffix: Counter = Counter()
            for j in range(len(acts) - 1, -1, -1):
                a = acts[j]
                for b, n in suffix.items():
                    counts[(a, b)] += n
                suffix[a] += 1

    pairs = [
        {"source": str(a), "target": str(b), "frequency": int(n)}
        for (a, b), n in counts.items()
    ]

    activities = sorted(
        {node for (a, b) in counts.keys() for node in (a, b)}
    )

    return {"pairs": pairs, "activities": activities}


def get_rework(df: pd.DataFrame) -> dict:
    """
    Detect rework (activity repeated within the same case) and self-loops
    (consecutive identical activities).

    Returns:
        dict with keys: activities, overall_rework_rate, cases_with_rework,
        total_cases, self_loops
    """
    total_cases = df[CASE_COL].nunique()
    if total_cases == 0:
        return {
            "activities": [],
            "overall_rework_rate": 0.0,
            "cases_with_rework": 0,
            "total_cases": 0,
            "self_loops": [],
        }

    # Rust fast path (~400-550x faster)
    rs_result = _rs_rework(df)
    if rs_result is not None:
        return rs_result

    # Per-case activity counts and self-loop detection
    activity_case_rework: dict[str, set] = {}   # activity -> set of case IDs with rework
    activity_total_occ: dict[str, int] = {}      # activity -> total occurrences across all cases
    activity_repetitions: dict[str, list] = {}  # activity -> list of repetition counts per rework case
    self_loop_count: dict[str, int] = {}
    cases_with_any_rework: set = set()

    for case_id, group in df.groupby(CASE_COL, sort=False):
        group = group.sort_values(TIMESTAMP_COL)
        activities_in_case = group[ACTIVITY_COL].tolist()

        # Count occurrences per activity in this case
        counts: dict[str, int] = {}
        for act in activities_in_case:
            a = str(act)
            counts[a] = counts.get(a, 0) + 1
            activity_total_occ[a] = activity_total_occ.get(a, 0) + 1

        for act, cnt in counts.items():
            if act not in activity_case_rework:
                activity_case_rework[act] = set()
                activity_repetitions[act] = []
            if cnt > 1:
                activity_case_rework[act].add(str(case_id))
                activity_repetitions[act].append(cnt)
                cases_with_any_rework.add(str(case_id))

        # Self-loops: consecutive identical activities
        for i in range(len(activities_in_case) - 1):
            a = str(activities_in_case[i])
            b = str(activities_in_case[i + 1])
            if a == b:
                self_loop_count[a] = self_loop_count.get(a, 0) + 1

    activities_out = []
    for act in sorted(activity_total_occ):
        rework_cases = activity_case_rework.get(act, set())
        repetitions = activity_repetitions.get(act, [])
        rework_case_count = len(rework_cases)
        avg_reps = float(pd.Series(repetitions).mean()) if repetitions else 1.0
        activities_out.append({
            "activity": act,
            "total_occurrences": activity_total_occ[act],
            "cases_with_rework": rework_case_count,
            "total_cases": total_cases,
            "rework_rate": round(100.0 * rework_case_count / total_cases, 2),
            "avg_repetitions": round(avg_reps, 3),
        })

    self_loops_out = [
        {"activity": act, "count": cnt}
        for act, cnt in sorted(self_loop_count.items(), key=lambda x: -x[1])
    ]
    overall_rework_rate = round(100.0 * len(cases_with_any_rework) / total_cases, 2)

    return {
        "activities": activities_out,
        "overall_rework_rate": overall_rework_rate,
        "cases_with_rework": len(cases_with_any_rework),
        "total_cases": total_cases,
        "self_loops": self_loops_out,
    }


def get_performance_spectrum(df: pd.DataFrame, limit: int = 100) -> dict:
    """
    Return per-case activity timelines for performance spectrum visualization.
    Limited to the first `limit` cases.

    Returns:
        dict with key: cases (list of {case_id, events: [{activity, timestamp}]})
    """
    cases = []
    grouped = df.groupby(CASE_COL, sort=False)
    count = 0
    for case_id, group in grouped:
        group = group.sort_values(TIMESTAMP_COL)
        events = [
            {
                "activity": str(row[ACTIVITY_COL]),
                "timestamp": pd.Timestamp(row[TIMESTAMP_COL]).isoformat(),
            }
            for _, row in group.iterrows()
        ]
        cases.append({"case_id": str(case_id), "events": events})
        count += 1
        if count >= limit:
            break

    return {"cases": cases}


def compare_process(engine, df: pd.DataFrame,
    split_attribute: str,
    split_value_a: str,
    split_value_b: str,
) -> dict:
    """
    Compare two subsets of the event log split by an attribute column.

    Runs DFG discovery on each subset, merges nodes and edges, and
    computes frequency diffs. Edge status is one of: added, removed,
    increased, decreased, unchanged.

    Returns:
        dict with keys: nodes, edges, stats_a, stats_b
    """
    if split_attribute not in df.columns:
        raise ValueError(f"Column '{split_attribute}' not found in event log")

    df_a = df[df[split_attribute].astype(str) == split_value_a]
    df_b = df[df[split_attribute].astype(str) == split_value_b]

    def _group_stats(sub_df: pd.DataFrame) -> dict:
        if sub_df.empty:
            return {"total_cases": 0, "total_events": 0, "avg_duration": None}
        total_cases = sub_df[CASE_COL].nunique()
        total_events = len(sub_df)
        durations = []
        for _, grp in sub_df.groupby(CASE_COL, sort=False):
            grp = grp.sort_values(TIMESTAMP_COL)
            ts = grp[TIMESTAMP_COL].tolist()
            if len(ts) >= 2:
                try:
                    durations.append((ts[-1] - ts[0]).total_seconds())
                except Exception:
                    pass
        avg_dur = float(pd.Series(durations).mean()) if durations else None
        return {
            "total_cases": int(total_cases),
            "total_events": int(total_events),
            "avg_duration": avg_dur,
        }

    def _dfg_freq(sub_df: pd.DataFrame) -> dict[tuple[str, str], int]:
        if sub_df.empty:
            return {}
        result = engine.discovery_service.discover_dfg(sub_df)
        return {
            (e["source"], e["target"]): e["frequency"]
            for e in result.get("edges", [])
        }

    def _activity_freq(sub_df: pd.DataFrame) -> dict[str, int]:
        if sub_df.empty:
            return {}
        return {
            str(a): int(c)
            for a, c in sub_df[ACTIVITY_COL].value_counts().items()
        }

    freq_a = _dfg_freq(df_a)
    freq_b = _dfg_freq(df_b)
    act_a = _activity_freq(df_a)
    act_b = _activity_freq(df_b)

    all_edge_keys = set(freq_a) | set(freq_b)
    all_activities = set(act_a) | set(act_b)

    nodes = []
    for a in sorted(all_activities):
        fa = act_a.get(a, 0)
        fb = act_b.get(a, 0)
        if fa == 0:
            node_status = "added"
        elif fb == 0:
            node_status = "removed"
        elif fb > fa * 1.2:
            node_status = "increased"
        elif fb < fa * 0.8:
            node_status = "decreased"
        else:
            node_status = "unchanged"
        nodes.append({
            "id": a,
            "label": a,
            "frequency_a": fa,
            "frequency_b": fb,
            "diff": fb - fa,
            "status": node_status,
        })

    edges = []
    for (src, tgt) in sorted(all_edge_keys):
        fa = freq_a.get((src, tgt), 0)
        fb = freq_b.get((src, tgt), 0)
        diff = fb - fa
        if fa == 0:
            edge_status = "added"
        elif fb == 0:
            edge_status = "removed"
        elif diff > 0:
            edge_status = "increased"
        elif diff < 0:
            edge_status = "decreased"
        else:
            edge_status = "unchanged"
        edges.append({
            "source": src,
            "target": tgt,
            "frequency_a": fa,
            "frequency_b": fb,
            "diff": diff,
            "status": edge_status,
        })

    return {
        "nodes": nodes,
        "edges": edges,
        "stats_a": _group_stats(df_a),
        "stats_b": _group_stats(df_b),
    }
