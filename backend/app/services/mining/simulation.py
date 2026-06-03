"""What-if simulation on real traces, plus the comprehensive process summary."""

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


def run_simulation(df: pd.DataFrame, modifications: list[dict], num_traces: int = 500
) -> dict:
    """
    Run a what-if process simulation.

    Works directly on the original event log: copies all traces (or a
    random sample of ``num_traces`` if the log is larger), applies the
    requested modifications (duration scaling, activity removal, frequency
    adjustment), and returns side-by-side statistics.

    Previous implementation used pm4py Petri-net playout which generates
    synthetic traces with 1-second inter-event gaps, making duration
    scaling meaningless (always showed ~-100%).  Operating on real traces
    preserves the actual timing so percentage changes are accurate.

    Args:
        df: Original event log as a normalised DataFrame.
        modifications: List of modification dicts, each with keys:
            - type: "duration_scale" | "remove_activity" | "adjust_frequency"
            - activity: Target activity name.
            - value: Scale factor, or percentage for adjust_frequency.
        num_traces: Max traces to include in the simulation (default 500).

    Returns:
        dict with keys: original (SimulationStats), simulated (SimulationStats),
        improvement (dict).
    """
    # 1. Compute stats on the full original log
    original_stats = _compute_sim_stats(df)

    # 2. Sample traces from the original log if it has more than
    #    num_traces cases, so the simulation stays responsive.
    case_ids = df[CASE_COL].unique()
    if len(case_ids) > num_traces:
        rng = np.random.default_rng(42)
        sampled = rng.choice(case_ids, size=num_traces, replace=False)
        sim_df = df[df[CASE_COL].isin(set(sampled))].copy()
    else:
        sim_df = df.copy()

    # Ensure timestamp column is datetime
    if TIMESTAMP_COL in sim_df.columns:
        sim_df[TIMESTAMP_COL] = pd.to_datetime(sim_df[TIMESTAMP_COL], utc=True)

    # 3. Apply user modifications to the copied log
    for mod in modifications:
        mod_type = mod["type"]
        activity = mod["activity"]
        value = mod["value"]

        if mod_type == "duration_scale":
            sim_df = _apply_duration_scale(sim_df, activity, value)

        elif mod_type == "remove_activity":
            # Remove events of this activity and close the time gap
            sim_df = _apply_remove_activity(sim_df, activity)

        elif mod_type == "adjust_frequency":
            # Keep only value% of cases that go through this activity;
            # cases that don't use the activity are always kept.
            cases_with = sim_df[sim_df[ACTIVITY_COL] == activity][CASE_COL].unique()
            keep_count = max(1, int(len(cases_with) * value / 100))
            rng = np.random.default_rng(42)
            cases_to_keep = set(rng.choice(cases_with, size=keep_count, replace=False))
            cases_without = sim_df[~sim_df[CASE_COL].isin(set(cases_with))][CASE_COL].unique()
            all_keep = cases_to_keep | set(cases_without)
            sim_df = sim_df[sim_df[CASE_COL].isin(all_keep)]

    # 4. Compute stats on the modified log
    simulated_stats = _compute_sim_stats(sim_df)

    # 5. Compute improvement metrics
    orig_dur = original_stats["avg_case_duration"]
    sim_dur = simulated_stats["avg_case_duration"]
    dur_change_pct = ((sim_dur - orig_dur) / orig_dur * 100) if orig_dur > 0 else 0.0

    return {
        "original": original_stats,
        "simulated": simulated_stats,
        "improvement": {
            "avg_duration_change_pct": round(dur_change_pct, 2),
            "case_count_change": (
                simulated_stats["total_cases"] - original_stats["total_cases"]
            ),
            "activities_removed": [
                m["activity"]
                for m in modifications
                if m["type"] == "remove_activity"
            ],
        },
    }


def _compute_sim_stats(df: pd.DataFrame) -> dict:
    """
    Compute summary statistics for simulation comparison.

    Returns a dict compatible with the SimulationStats schema.
    """
    if df.empty:
        return {
            "total_cases": 0,
            "total_events": 0,
            "avg_case_duration": 0.0,
            "median_case_duration": 0.0,
            "avg_events_per_case": 0.0,
            "activities": [],
        }

    cases = df.groupby(CASE_COL)
    durations = cases[TIMESTAMP_COL].apply(
        lambda x: (x.max() - x.min()).total_seconds()
    )

    activity_stats = []
    for act, grp in df.groupby(ACTIVITY_COL):
        activity_stats.append(
            {
                "name": str(act),
                "frequency": len(grp),
                "avg_duration": 0,  # could compute per-activity if needed
            }
        )

    return {
        "total_cases": int(df[CASE_COL].nunique()),
        "total_events": int(len(df)),
        "avg_case_duration": float(durations.mean()) if len(durations) > 0 else 0.0,
        "median_case_duration": float(durations.median()) if len(durations) > 0 else 0.0,
        "avg_events_per_case": float(df.groupby(CASE_COL).size().mean()) if len(df) > 0 else 0.0,
        "activities": sorted(activity_stats, key=lambda x: x["frequency"], reverse=True),
    }


def _apply_duration_scale(df: pd.DataFrame, activity: str, scale_factor: float
) -> pd.DataFrame:
    """
    Scale the time gap that follows each occurrence of `activity` within a case.

    For each event of the given activity, the gap to the next event is
    multiplied by `scale_factor`. All subsequent events in the same case are
    shifted accordingly so that the overall case timeline stays consistent.

    NOTE: This implementation iterates per-case and per-matching-event, which
    is intentionally straightforward for correctness. It is acceptable for
    simulated logs of typical size (num_traces ~ 500). For very large logs
    a vectorised approach would be needed.
    """
    df = df.sort_values([CASE_COL, TIMESTAMP_COL]).copy()

    for case_id in df[CASE_COL].unique():
        case_mask = df[CASE_COL] == case_id
        case_df = df[case_mask]
        indices = case_df.index.tolist()

        for i, idx in enumerate(indices):
            if df.loc[idx, ACTIVITY_COL] == activity and i + 1 < len(indices):
                next_idx = indices[i + 1]
                gap = df.loc[next_idx, TIMESTAMP_COL] - df.loc[idx, TIMESTAMP_COL]
                shift = gap * scale_factor - gap  # net change (can be negative)
                # Shift this event and all subsequent events in the case
                for j in range(i + 1, len(indices)):
                    df.loc[indices[j], TIMESTAMP_COL] += shift

    return df


def _apply_remove_activity(df: pd.DataFrame, activity: str
) -> pd.DataFrame:
    """Remove all events of ``activity`` and collapse the time gap.

    For each case the events of the target activity are dropped and the
    timestamps of subsequent events are shifted earlier by the duration
    that was occupied by the removed events, keeping the rest of the
    case timeline proportional.
    """
    df = df.sort_values([CASE_COL, TIMESTAMP_COL]).copy()

    for case_id in df[CASE_COL].unique():
        case_mask = df[CASE_COL] == case_id
        case_df = df[case_mask]
        indices = case_df.index.tolist()

        # Walk through events and accumulate the time to subtract
        cumulative_shift = pd.Timedelta(0)
        prev_idx = None
        remove_indices = []
        for idx in indices:
            if df.loc[idx, ACTIVITY_COL] == activity:
                # Record the gap this event occupies
                if prev_idx is not None:
                    cumulative_shift += (
                        df.loc[idx, TIMESTAMP_COL] - df.loc[prev_idx, TIMESTAMP_COL]
                    )
                remove_indices.append(idx)
            else:
                if cumulative_shift > pd.Timedelta(0):
                    df.loc[idx, TIMESTAMP_COL] -= cumulative_shift
            prev_idx = idx

        if remove_indices:
            df = df.drop(remove_indices)

    return df


def generate_summary(engine, df: pd.DataFrame) -> dict:
    """
    Generate a comprehensive process summary by running DFG discovery,
    variant analysis (top 10), bottleneck analysis, and statistics.

    Returns:
        dict compatible with the ProcessSummary schema, containing:
        - statistics: ProcessStatistics dict
        - top_variants: list of up to 10 Variant dicts
        - bottlenecks: list of Bottleneck dicts (only those flagged as bottlenecks)
        - process_map: DiscoveryResponse dict (DFG)
    """
    try:
        # Run all analyses
        statistics = engine.compute_statistics(df)
        discovery_result = engine.run_discovery(df, algorithm="dfg")
        variant_result = engine.run_variant_analysis(df)
        bottleneck_result = engine.run_bottleneck_analysis(df)

        # Extract top 10 variants
        top_variants = variant_result.get("variants", [])[:10]

        # Extract only activities classified as bottlenecks
        all_bottlenecks = bottleneck_result.get("bottlenecks", [])
        active_bottlenecks = [
            b for b in all_bottlenecks if b.get("is_bottleneck", False)
        ]

        return {
            "statistics": statistics,
            "top_variants": top_variants,
            "bottlenecks": active_bottlenecks,
            "process_map": discovery_result,
        }

    except Exception as e:
        logger.error(f"Error generating process summary: {e}", exc_info=True)
        raise
