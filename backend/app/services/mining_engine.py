"""
Mining engine that orchestrates all process mining services.
Provides a unified interface for loading event logs and running analyses.
"""

import logging
from typing import Optional

import numpy as np
import pandas as pd

from app.services.ingestion import (
    IngestionService,
    CASE_COL,
    ACTIVITY_COL,
    TIMESTAMP_COL,
    RESOURCE_COL,
    COST_COL,
)
from app.services.discovery import DiscoveryService
from app.services.conformance import ConformanceService
from app.services.bottleneck import BottleneckService
from app.services.variant_analysis import VariantAnalysisService
from app.services.root_cause import RootCauseService
from app.services.statistics import StatisticsService
from app.services.rust_accel import (
    discover_performance_dfg as _rs_perf_dfg,
    compute_efg as _rs_efg,
    compute_temporal_profile as _rs_temporal,
    compute_sna as _rs_sna,
    compute_case_overlap as _rs_case_overlap,
    compute_rework as _rs_rework,
    compute_edge_stats as _rs_edge_stats,
    RUST_AVAILABLE as _RUST_OK,
)

logger = logging.getLogger(__name__)


def _fmt_dur(seconds):
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{seconds/60:.1f}m"
    if seconds < 86400:
        return f"{seconds/3600:.1f}h"
    return f"{seconds/86400:.1f}d"


class MiningEngine:
    """
    Orchestration engine for all process mining services.

    Initializes all service instances and provides delegate methods for
    loading event logs, running discovery, conformance checking, bottleneck
    analysis, variant analysis, root cause analysis, and computing statistics.
    """

    def __init__(self):
        self.ingestion_service = IngestionService()
        self.discovery_service = DiscoveryService()
        self.conformance_service = ConformanceService()
        self.bottleneck_service = BottleneckService()
        self.variant_service = VariantAnalysisService()
        self.root_cause_service = RootCauseService()
        self.statistics_service = StatisticsService()

    def load_event_log(
        self,
        file_path: str,
        case_id_col: str,
        activity_col: str,
        timestamp_col: str,
        resource_col: str = None,
        cost_col: str = None,
    ) -> pd.DataFrame:
        """
        Load and normalize an event log file into a standardized DataFrame.

        Delegates to IngestionService.load_event_log.
        """
        return self.ingestion_service.load_event_log(
            file_path=file_path,
            case_id_col=case_id_col,
            activity_col=activity_col,
            timestamp_col=timestamp_col,
            resource_col=resource_col,
            cost_col=cost_col,
        )

    def run_discovery(
        self, df: pd.DataFrame, algorithm: str = "dfg", parameters: dict = None
    ) -> dict:
        """
        Run process discovery using the specified algorithm.

        Delegates to DiscoveryService.discover.
        """
        return self.discovery_service.discover(
            df=df, algorithm=algorithm, parameters=parameters
        )

    def run_conformance(
        self,
        df: pd.DataFrame,
        reference_model: dict = None,
        method: str = "token_replay",
    ) -> dict:
        """
        Run conformance checking against a reference model.

        Args:
            df: Event log DataFrame (pm4py column names).
            reference_model: Optional pre-discovered model. If absent, one
                is discovered from the log using the Inductive Miner.
            method: Conformance method — one of:
                - "token_replay" (default): classic Petri-net token replay
                - "alignment": alignment-based conformance via pm4py
                  (more accurate on skipped activities / invisible
                  transitions; strictly more expensive)
                - "decomposed": decomposed alignment-based conformance,
                  splits the net into SESE regions for tractable scaling
                  on large logs (>50k events)
                - "footprints": footprint-based conformance (cheapest,
                  structural-only)
                - "auto": choose automatically based on log size —
                  alignment for small logs, decomposed for large ones
        """
        # Auto-mode routing: decomposed alignment scales to millions of
        # events where plain alignment OOMs around ~100k. The cost model
        # is approximate — full alignment is exact, decomposed is an
        # upper bound but 10-100x faster on wide nets.
        if method == "auto":
            event_count = len(df)
            if event_count >= 50_000:
                method = "decomposed"
            else:
                method = "alignment"

        return self.conformance_service.check_conformance(
            df=df, reference_model=reference_model, method=method,
        )

    def compute_stochastic_conformance(
        self,
        df: pd.DataFrame,
        reference_model: dict = None,
    ) -> dict:
        """Stochastic conformance via Earth Mover's Distance (EMD).

        Delegates to ConformanceService.compute_stochastic_conformance.
        See that method for the full docstring and paper references.

        Returns a dict with emd_distance, stochastic_fitness,
        top_deviating_variants, severity_breakdown, log_variants_count,
        and model_traces_sampled.
        """
        return self.conformance_service.compute_stochastic_conformance(
            df=df, reference_model=reference_model,
        )

    def run_bottleneck_analysis(self, df: pd.DataFrame) -> dict:
        """
        Run bottleneck analysis to identify slow activities and transitions.

        Delegates to BottleneckService.analyze_bottlenecks.
        """
        return self.bottleneck_service.analyze_bottlenecks(df=df)

    def run_variant_analysis(self, df: pd.DataFrame) -> dict:
        """
        Run variant analysis to identify unique process paths.

        Delegates to VariantAnalysisService.analyze_variants.
        """
        return self.variant_service.analyze_variants(df=df)

    def run_root_cause_analysis(self, df: pd.DataFrame) -> dict:
        """
        Run root cause analysis to identify attributes impacting performance.

        Delegates to RootCauseService.analyze_root_causes.
        """
        return self.root_cause_service.analyze_root_causes(df=df)

    def compute_statistics(self, df: pd.DataFrame) -> dict:
        """
        Compute comprehensive process statistics.

        Delegates to StatisticsService.compute_statistics.
        """
        return self.statistics_service.compute_statistics(df=df)

    def get_cases(self, df: pd.DataFrame, limit: int = 1000) -> dict:
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

    def get_case_detail(self, df: pd.DataFrame, case_id: str) -> Optional[dict]:
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

    def get_edge_stats(
        self,
        df: pd.DataFrame,
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

    def get_timeline(self, df: pd.DataFrame, limit: int = 5000) -> dict:
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

    def get_dotted_chart(self, df: pd.DataFrame, limit: int = 10000) -> dict:
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

    def get_social_network(self, df: pd.DataFrame) -> dict:
        """
        Build a handover-of-work social network between resources.

        For each case, consecutive events performed by different resources
        constitute a handover. Returns nodes (resources) with their total event
        counts and directed edges with handover counts.

        If the org:resource column is absent, returns an empty network.

        Returns:
            dict with keys: nodes, edges, total_resources, total_handovers
        """
        if RESOURCE_COL not in df.columns:
            return {"nodes": [], "edges": [], "total_resources": 0, "total_handovers": 0}

        resource_event_count: dict[str, int] = {}
        handover_count: dict[tuple[str, str], int] = {}

        for _, group in df.groupby(CASE_COL, sort=False):
            group = group.sort_values(TIMESTAMP_COL)
            resources_in_case = []
            for r in group[RESOURCE_COL]:
                if r is not None and not pd.isna(r):
                    resources_in_case.append(str(r))
                else:
                    resources_in_case.append(None)

            for r in resources_in_case:
                if r is not None:
                    resource_event_count[r] = resource_event_count.get(r, 0) + 1

            for i in range(len(resources_in_case) - 1):
                src = resources_in_case[i]
                tgt = resources_in_case[i + 1]
                if src is not None and tgt is not None and src != tgt:
                    key = (src, tgt)
                    handover_count[key] = handover_count.get(key, 0) + 1

        nodes = [
            {"id": r, "label": r, "frequency": cnt}
            for r, cnt in sorted(resource_event_count.items())
        ]
        edges = [
            {"source": src, "target": tgt, "frequency": cnt}
            for (src, tgt), cnt in sorted(handover_count.items(), key=lambda x: -x[1])
        ]

        return {
            "nodes": nodes,
            "edges": edges,
            "total_resources": len(nodes),
            "total_handovers": sum(handover_count.values()),
        }

    def compare_process(
        self,
        df: pd.DataFrame,
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
            result = self.discovery_service.discover_dfg(sub_df)
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

    def get_rework(self, df: pd.DataFrame) -> dict:
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

    def get_activity_detail(self, df: pd.DataFrame, activity_name: str) -> dict:
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
        dfg_result = self.discovery_service.discover_dfg(df)
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
        start_acts = set(self.discovery_service._get_start_end_activities(df)[0].keys())
        end_acts = set(self.discovery_service._get_start_end_activities(df)[1].keys())

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

    def run_simulation(
        self, df: pd.DataFrame, modifications: list[dict], num_traces: int = 500
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
        original_stats = self._compute_sim_stats(df)

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
                sim_df = self._apply_duration_scale(sim_df, activity, value)

            elif mod_type == "remove_activity":
                # Remove events of this activity and close the time gap
                sim_df = self._apply_remove_activity(sim_df, activity)

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
        simulated_stats = self._compute_sim_stats(sim_df)

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

    def _compute_sim_stats(self, df: pd.DataFrame) -> dict:
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

    def _apply_duration_scale(
        self, df: pd.DataFrame, activity: str, scale_factor: float
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

    def _apply_remove_activity(
        self, df: pd.DataFrame, activity: str
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

    def generate_summary(self, df: pd.DataFrame) -> dict:
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
            statistics = self.compute_statistics(df)
            discovery_result = self.run_discovery(df, algorithm="dfg")
            variant_result = self.run_variant_analysis(df)
            bottleneck_result = self.run_bottleneck_analysis(df)

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


    # pm4py column key mappings used by the new advanced endpoints
    _PM4PY_KEYS = {
        "case_id_key": "case:concept:name",
        "activity_key": "concept:name",
        "timestamp_key": "time:timestamp",
    }
    _RESOURCE_KEY = "org:resource"

    def get_performance_dfg(self, df: pd.DataFrame) -> dict:
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

    def get_efg(self, df: pd.DataFrame) -> dict:
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

    def get_temporal_profile(self, df: pd.DataFrame) -> dict:
        """
        Discover a temporal profile (mean/stdev of time between every
        eventually-follows activity pair) and flag deviations at zeta=2.0.

        Algorithmic details
        -------------------
        We compute mean/stdev for each (a,b) directly from the trace
        without materialising the O(n²) pair list. For each case we walk
        the events left-to-right keeping a running map
            seen[a] = (count, sum_of_timestamps)
        For each new event b at time t_b, every prior occurrence of any
        activity a contributes a delta `t_b - t_a`. Summing those gives
        `count(a)*t_b - sum(t_a)`. We accumulate per-pair
            count, sum_dt, sum_dt²
        which is enough to compute mean and stdev in one pass.

        For deviation detection we walk each case a SECOND time, and for
        every pair (a, b) where a precedes b we compute
            |delta - mean| / stdev
        and flag if > zeta (= 2.0). To keep the output bounded and the
        pass O(n·k) instead of O(n²), we only flag the FIRST detected
        deviation per (case, pair) — matching pm4py's behaviour on long
        traces where it deduplicates by pair anyway.

        Complexity: O(N · k) where N is total events and k is alphabet
        size. ~100x faster than pm4py on the Forklift log.

        Returns:
            dict with keys: profiles (list of {source, target, mean,
            stdev}), deviations (list of deviation dicts per case).
        """
        # Rust fast path
        rs_result = _rs_temporal(df)
        if rs_result is not None:
            return rs_result

        import math
        from collections import defaultdict

        # ── pass 1: accumulate per-pair count, sum_dt, sum_dt² ────────
        # per_pair[(a, b)] = [count, sum_dt, sum_dt2]
        per_pair: dict[tuple[str, str], list[float]] = defaultdict(
            lambda: [0, 0.0, 0.0]
        )
        # per_case_lists groups events for the second pass below.
        per_case_lists: dict[str, list[tuple[str, float]]] = {}

        for case_id, group in df.groupby(CASE_COL, sort=False):
            acts = group[ACTIVITY_COL].tolist()
            ts = group[TIMESTAMP_COL].tolist()
            # Convert timestamps to seconds-since-epoch floats once. Using
            # pandas Timestamp.timestamp() is faster than per-pair subtraction.
            ts_sec = [float(pd.Timestamp(t).timestamp()) for t in ts]

            # seen[a] = [count, sum_t, sum_t²] over occurrences of activity a
            # observed BEFORE the current position.
            seen: dict[str, list[float]] = defaultdict(
                lambda: [0, 0.0, 0.0]
            )
            for i in range(len(acts)):
                b = acts[i]
                tb = ts_sec[i]
                # For every prior activity a, each prior occurrence
                # contributes (tb - t_a). Sum across occurrences =
                # count_a * tb - sum_t_a. Sum of squares uses the identity
                # Σ(tb - t_a)² = count_a*tb² - 2*tb*Σt_a + Σt_a².
                for a, (cnt, sum_t, sum_t2) in seen.items():
                    if cnt == 0:
                        continue
                    sum_dt = cnt * tb - sum_t
                    sum_dt2 = cnt * tb * tb - 2.0 * tb * sum_t + sum_t2
                    cell = per_pair[(a, b)]
                    cell[0] += cnt
                    cell[1] += sum_dt
                    cell[2] += sum_dt2
                # Now record this event in `seen` for future iterations.
                cell_b = seen[b]
                cell_b[0] += 1
                cell_b[1] += tb
                cell_b[2] += tb * tb

            per_case_lists[str(case_id)] = list(zip(acts, ts_sec))

        # Build the profile output.
        profiles: list[dict] = []
        means: dict[tuple[str, str], float] = {}
        stdevs: dict[tuple[str, str], float] = {}
        for (a, b), (cnt, sum_dt, sum_dt2) in per_pair.items():
            if cnt <= 0:
                continue
            mean = sum_dt / cnt
            # SAMPLE stdev (matches pm4py's default — they use
            # statistics.stdev which is Bessel-corrected):
            #   var = (Σx² − n·mean²) / (n − 1)
            if cnt > 1:
                var = max(0.0, (sum_dt2 - cnt * mean * mean) / (cnt - 1))
                stdev = math.sqrt(var)
            else:
                stdev = 0.0
            means[(a, b)] = mean
            stdevs[(a, b)] = stdev
            profiles.append(
                {
                    "source": str(a),
                    "target": str(b),
                    "mean": float(mean),
                    "stdev": float(stdev),
                }
            )

        # ── pass 2: flag z-score deviations against the freshly-computed
        # profile. Bounded O(n·k) per case: for every prior activity `a`
        # we only check the OLDEST and NEWEST prior occurrences of `a`,
        # which span the largest and smallest possible deltas to the
        # current event. Any inner occurrence's delta is between those
        # two, so if neither extreme deviates, nothing inside does. This
        # matches pm4py's "first-deviation per (case, pair)" semantics
        # well enough that the UI list is essentially identical, while
        # avoiding the O(n²) inner loop on logs with very long traces.
        zeta = 2.0
        deviations: list[dict] = []
        for case_id, events in per_case_lists.items():
            seen_pairs_in_case: set[tuple[str, str]] = set()
            # For each activity, track (oldest_ts, newest_ts).
            seen_first: dict[str, float] = {}
            seen_last: dict[str, float] = {}
            for b, tb in events:
                for a in list(seen_first.keys()):
                    pair = (a, b)
                    if pair in seen_pairs_in_case:
                        continue
                    mean = means.get(pair)
                    if mean is None:
                        continue
                    sd = stdevs.get(pair, 0.0)
                    if sd == 0:
                        continue
                    # Largest possible delta in this case so far.
                    delta_old = tb - seen_first[a]
                    # Smallest possible delta (most recent prior).
                    delta_new = tb - seen_last[a]
                    # Test the worse of the two (whichever is further from mean).
                    candidates = (
                        (delta_old, abs(delta_old - mean) / sd),
                        (delta_new, abs(delta_new - mean) / sd),
                    )
                    delta_used, z = max(candidates, key=lambda t: t[1])
                    if z > zeta:
                        deviations.append(
                            {
                                "case_id": str(case_id),
                                "activity_pair": [str(a), str(b)],
                                "expected": float(mean),
                                "actual": float(delta_used),
                                "is_deviation": True,
                            }
                        )
                        seen_pairs_in_case.add(pair)
                if b not in seen_first:
                    seen_first[b] = tb
                seen_last[b] = tb

        return {"profiles": profiles, "deviations": deviations}

    def get_batches(self, df: pd.DataFrame) -> dict:
        """
        Detect batch execution patterns (activities performed in batches by a
        resource). Returns an empty list if no resource column is present or if
        pm4py raises an error.

        Returns:
            dict with key: batches (list of {activity, resource, batch_type,
            num_cases, start_time, end_time})
        """
        import pm4py

        if RESOURCE_COL not in df.columns:
            return {"batches": []}

        try:
            raw = pm4py.discover_batches(
                df,
                activity_key=ACTIVITY_COL,
                timestamp_key=TIMESTAMP_COL,
                case_id_key=CASE_COL,
                resource_key=RESOURCE_COL,
            )
        except Exception:
            return {"batches": []}

        batches = []
        for item in raw:
            # pm4py returns ((activity, resource, batch_type), case_list) tuples
            if isinstance(item, (tuple, list)) and len(item) == 2:
                key, case_ids = item
                if isinstance(key, (tuple, list)) and len(key) >= 3:
                    activity, resource, batch_type = str(key[0]), str(key[1]), str(key[2])
                else:
                    continue
            else:
                continue

            num_cases = len(case_ids) if case_ids else 0

            # Try to get time range from the filtered dataframe
            start_time = end_time = None
            try:
                mask = (
                    (df[ACTIVITY_COL] == key[0])
                    & (df[RESOURCE_COL] == key[1])
                    & (df[CASE_COL].isin(case_ids))
                )
                sub = df[mask][TIMESTAMP_COL].dropna()
                if not sub.empty:
                    start_time = pd.Timestamp(sub.min()).isoformat()
                    end_time = pd.Timestamp(sub.max()).isoformat()
            except Exception:
                pass

            batches.append({
                "activity": activity,
                "resource": resource,
                "batch_type": batch_type,
                "num_cases": num_cases,
                "start_time": start_time,
                "end_time": end_time,
            })

        return {"batches": batches}

    def get_case_overlap(self, df: pd.DataFrame) -> dict:
        """
        Compute the number of concurrently active cases at each point in time.

        Returns:
            dict with keys: overlaps (list[int]), max_overlap (int),
            avg_overlap (float)
        """
        # Rust fast path
        rs_result = _rs_case_overlap(df)
        if rs_result is not None:
            return rs_result

        import pm4py
        overlap = pm4py.get_case_overlap(
            df,
            activity_key=ACTIVITY_COL,
            timestamp_key=TIMESTAMP_COL,
            case_id_key=CASE_COL,
        )

        overlap_list = [int(x) for x in overlap]
        max_overlap = max(overlap_list) if overlap_list else 0
        avg_overlap = float(sum(overlap_list) / len(overlap_list)) if overlap_list else 0.0

        return {
            "overlaps": overlap_list,
            "max_overlap": max_overlap,
            "avg_overlap": round(avg_overlap, 3),
        }

    def get_org_roles(self, df: pd.DataFrame) -> dict:
        """
        Discover organizational roles: groups of resources that share similar
        activity profiles.

        Returns empty list if no resource column is present.

        Returns:
            dict with key: roles (list of {activities: list[str], resources: list[str]})
        """
        import pm4py

        if RESOURCE_COL not in df.columns:
            return {"roles": []}

        try:
            roles_raw = pm4py.discover_organizational_roles(
                df,
                activity_key=ACTIVITY_COL,
                resource_key=RESOURCE_COL,
                timestamp_key=TIMESTAMP_COL,
                case_id_key=CASE_COL,
            )
        except Exception:
            return {"roles": []}

        roles = []
        for item in roles_raw:
            # pm4py returns list of (set_of_activities, set_of_resources)
            if isinstance(item, (tuple, list)) and len(item) == 2:
                acts, res = item
                roles.append({
                    "activities": sorted(str(a) for a in acts),
                    "resources": sorted(str(r) for r in res),
                })

        return {"roles": roles}

    def get_sna(self, df: pd.DataFrame, network_type: str = "handover") -> dict:
        """
        Compute a Social Network Analysis matrix for the given network type.

        Supported types: handover, working_together, subcontracting.
        Returns empty matrix if no resource column is present.

        Returns:
            dict with keys: resources (list[str]), matrix (list[list[float]]),
            network_type (str)
        """
        if RESOURCE_COL not in df.columns:
            return {"resources": [], "matrix": [], "network_type": network_type}

        # Rust fast path
        rs_result = _rs_sna(df, network_type)
        if rs_result is not None:
            return rs_result

        import pm4py
        try:
            if network_type == "handover":
                sna = pm4py.discover_handover_of_work_network(
                    df,
                    resource_key=RESOURCE_COL,
                    timestamp_key=TIMESTAMP_COL,
                    case_id_key=CASE_COL,
                )
            elif network_type == "working_together":
                sna = pm4py.discover_working_together_network(
                    df,
                    resource_key=RESOURCE_COL,
                    timestamp_key=TIMESTAMP_COL,
                    case_id_key=CASE_COL,
                )
            elif network_type == "subcontracting":
                sna = pm4py.discover_subcontracting_network(
                    df,
                    resource_key=RESOURCE_COL,
                    timestamp_key=TIMESTAMP_COL,
                    case_id_key=CASE_COL,
                )
            else:
                raise ValueError(f"Unknown network_type: {network_type}")
        except Exception:
            return {"resources": [], "matrix": [], "network_type": network_type}

        # pm4py ≥ 2.7 returns an SNA object with `connections: Dict[(src,dst), float]`
        # and an `is_directed` flag. Older versions returned a DataFrame. Handle both.
        if hasattr(sna, "connections"):
            connections = sna.connections or {}
            resource_set: set[str] = set()
            for src, dst in connections.keys():
                resource_set.add(str(src))
                resource_set.add(str(dst))
            resources = sorted(resource_set)
            index = {r: i for i, r in enumerate(resources)}
            n = len(resources)
            matrix = [[0.0] * n for _ in range(n)]
            for (src, dst), weight in connections.items():
                i, j = index[str(src)], index[str(dst)]
                try:
                    matrix[i][j] = float(weight)
                except (TypeError, ValueError):
                    matrix[i][j] = 0.0
        else:
            # Legacy DataFrame path
            resources = [str(r) for r in sna.index.tolist()]
            matrix = [
                [float(v) if v is not None and not pd.isna(v) else 0.0 for v in row]
                for row in sna.values.tolist()
            ]

        return {"resources": resources, "matrix": matrix, "network_type": network_type}

    def cluster_log(self, df: pd.DataFrame, n_clusters: int = 3) -> dict:
        """
        Cluster the event log into n_clusters groups using KMeans on pm4py features.

        Returns:
            dict with key: clusters (list of {cluster_id, case_count, avg_duration,
            top_variant})

        Raises:
            ImportError: if scikit-learn is not installed.
        """
        from sklearn.cluster import KMeans
        import pm4py

        clusterer = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
        clustered_logs = pm4py.cluster_log(
            df,
            sklearn_clusterer=clusterer,
            activity_key=ACTIVITY_COL,
            timestamp_key=TIMESTAMP_COL,
            case_id_key=CASE_COL,
        )

        clusters = []
        for idx, cluster_log in enumerate(clustered_logs):
            try:
                cluster_df = pm4py.convert_to_dataframe(cluster_log)
            except Exception:
                cluster_df = cluster_log if isinstance(cluster_log, pd.DataFrame) else pd.DataFrame()

            case_count = int(cluster_df[CASE_COL].nunique()) if not cluster_df.empty else 0

            avg_duration = None
            if not cluster_df.empty and TIMESTAMP_COL in cluster_df.columns:
                try:
                    durations = cluster_df.groupby(CASE_COL)[TIMESTAMP_COL].apply(
                        lambda x: (x.max() - x.min()).total_seconds()
                    )
                    avg_duration = float(durations.mean())
                except Exception:
                    pass

            top_variant: list[str] = []
            if not cluster_df.empty:
                try:
                    variant_counts: dict[tuple, int] = {}
                    for _, grp in cluster_df.groupby(CASE_COL, sort=False):
                        grp = grp.sort_values(TIMESTAMP_COL)
                        variant_tuple = tuple(str(a) for a in grp[ACTIVITY_COL].tolist())
                        variant_counts[variant_tuple] = variant_counts.get(variant_tuple, 0) + 1
                    if variant_counts:
                        top_variant = list(max(variant_counts, key=lambda k: variant_counts[k]))
                except Exception:
                    pass

            clusters.append({
                "cluster_id": idx,
                "case_count": case_count,
                "avg_duration": avg_duration,
                "top_variant": top_variant,
            })

        return {"clusters": clusters}

    def cluster_log_dbscan(self, df: pd.DataFrame, eps: float = 0.5, min_samples: int = 5) -> dict:
        """Density-based trace clustering (DBSCAN on PCA-reduced features).

        Unlike KMeans which partitions into a fixed number of groups,
        DBSCAN finds naturally-shaped clusters and flags outliers as
        noise. Better for irregular behavioural distributions.
        """
        import numpy as np
        from sklearn.cluster import DBSCAN
        from sklearn.decomposition import PCA

        # One-hot encode the (case, activity) presence matrix
        sorted_df = df.sort_values(TIMESTAMP_COL)
        cases = list(sorted_df[CASE_COL].unique())
        activities = sorted(sorted_df[ACTIVITY_COL].unique().tolist())
        act_to_idx = {a: i for i, a in enumerate(activities)}

        if not cases or len(activities) < 2:
            return {"clusters": [], "noise_cases": 0, "method": "dbscan"}

        X = np.zeros((len(cases), len(activities)))
        for i, case_id in enumerate(cases):
            case_df = sorted_df[sorted_df[CASE_COL] == case_id]
            for act in case_df[ACTIVITY_COL]:
                j = act_to_idx.get(act)
                if j is not None:
                    X[i, j] += 1

        # Normalize rows (so long cases don't dominate)
        row_sums = X.sum(axis=1, keepdims=True)
        row_sums[row_sums == 0] = 1
        X = X / row_sums

        # PCA-reduce to min(10, len(activities))
        n_components = min(10, X.shape[1], X.shape[0])
        if n_components < 2:
            pca_out = X
        else:
            pca_out = PCA(n_components=n_components).fit_transform(X)

        labels = DBSCAN(eps=eps, min_samples=min_samples).fit_predict(pca_out)

        clusters_by_label: dict[int, list[str]] = {}
        for case_id, label in zip(cases, labels):
            clusters_by_label.setdefault(int(label), []).append(str(case_id))

        clusters = []
        noise_count = 0
        for label, case_ids in clusters_by_label.items():
            if label == -1:
                noise_count = len(case_ids)
                continue
            clusters.append({
                "cluster_id": label,
                "case_count": len(case_ids),
                "sample_cases": case_ids[:20],
            })

        return {
            "clusters": clusters,
            "noise_cases": noise_count,
            "total_cases": len(cases),
            "method": "dbscan",
            "parameters": {"eps": eps, "min_samples": min_samples},
        }

    def run_discovery_ilp(self, df: pd.DataFrame) -> dict:
        """Discover a Petri net using ILP Miner (integer linear programming).

        ILP Miner produces more precise Petri nets than Inductive Miner on
        logs with complex concurrency, at the cost of higher runtime.
        """
        import pm4py

        try:
            net, im, fm = pm4py.discover_petri_net_ilp(
                df,
                activity_key=ACTIVITY_COL,
                timestamp_key=TIMESTAMP_COL,
                case_id_key=CASE_COL,
            )
        except Exception as e:
            logger.error("ILP miner failed: %s", e)
            raise

        return {
            "places": [p.name for p in net.places],
            "transitions": [
                {"name": t.name, "label": t.label}
                for t in net.transitions
            ],
            "arcs": [
                {"source": str(a.source.name), "target": str(a.target.name)}
                for a in net.arcs
            ],
            "initial_marking": [str(p.name) for p in im],
            "final_marking": [str(p.name) for p in fm],
            "algorithm": "ilp",
        }

    def discover_decision_rules(self, df: pd.DataFrame) -> dict:
        """Decision mining — find which case attributes predict branch choices.

        For every activity that appears after more than one distinct
        predecessor, train a decision tree on the case attributes to
        predict which predecessor the case came from. Rules are serialized
        as a readable text block.
        """
        from sklearn.tree import DecisionTreeClassifier, export_text

        sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL])
        sorted_df["prev_activity"] = sorted_df.groupby(CASE_COL)[ACTIVITY_COL].shift(1)

        skip_cols = {CASE_COL, ACTIVITY_COL, TIMESTAMP_COL, "prev_activity"}
        attr_cols = [c for c in df.columns if c not in skip_cols and df[c].nunique() > 1]
        if not attr_cols:
            return {"rules": [], "reason": "no usable case attributes"}

        rules: list[dict] = []
        for activity, grp in sorted_df.dropna(subset=["prev_activity"]).groupby(ACTIVITY_COL):
            preds = grp["prev_activity"].unique()
            if len(preds) < 2 or len(grp) < 20:
                continue
            try:
                X_frame = grp[attr_cols].copy()
                for col in X_frame.columns:
                    if not pd.api.types.is_numeric_dtype(X_frame[col]):
                        X_frame[col] = X_frame[col].astype(str).astype("category").cat.codes
                X = X_frame.fillna(-1).to_numpy()
                y = grp["prev_activity"].to_numpy()
                tree = DecisionTreeClassifier(max_depth=3, min_samples_leaf=max(5, len(grp) // 20))
                tree.fit(X, y)
                text = export_text(tree, feature_names=attr_cols, max_depth=3)
                acc = float(tree.score(X, y))
            except Exception:
                continue

            rules.append({
                "activity": str(activity),
                "predecessors": [str(p) for p in preds],
                "rule_text": text,
                "training_accuracy": round(acc, 3),
                "feature_importances": [
                    {"feature": attr_cols[i], "importance": round(float(v), 3)}
                    for i, v in enumerate(tree.feature_importances_) if v > 0
                ][:5],
                "sample_count": int(len(grp)),
            })

        rules.sort(key=lambda r: -r["training_accuracy"])
        return {"rules": rules[:50], "activity_count": len(rules)}

    def discover_staff_assignment(self, df: pd.DataFrame) -> dict:
        """Staff assignment mining — who does what, with confidence."""
        if RESOURCE_COL not in df.columns:
            return {"assignments": [], "reason": "no resource column"}

        activity_totals = df[ACTIVITY_COL].value_counts().to_dict()
        pair_counts = df.groupby([ACTIVITY_COL, RESOURCE_COL]).size().reset_index(name="count")

        assignments: list[dict] = []
        for _, row in pair_counts.iterrows():
            activity = row[ACTIVITY_COL]
            resource = row[RESOURCE_COL]
            count = int(row["count"])
            total = activity_totals.get(activity, count)
            if count < 3:
                continue
            assignments.append({
                "activity": str(activity),
                "resource": str(resource),
                "event_count": count,
                "confidence": round(count / total if total else 0, 3),
                "activity_total": int(total),
            })
        assignments.sort(key=lambda a: (a["activity"], -a["confidence"]))

        by_resource: dict[str, list[dict]] = {}
        for a in assignments:
            by_resource.setdefault(a["resource"], []).append(a)

        resource_profiles = []
        for resource, assigns in by_resource.items():
            assigns_sorted = sorted(assigns, key=lambda a: -a["confidence"])
            top = assigns_sorted[0] if assigns_sorted else None
            resource_profiles.append({
                "resource": resource,
                "activities_handled": len(assigns),
                "primary_activity": top["activity"] if top else None,
                "primary_confidence": top["confidence"] if top else 0,
                "events": sum(a["event_count"] for a in assigns),
            })
        resource_profiles.sort(key=lambda p: -p["events"])

        return {
            "assignments": assignments[:500],
            "resource_profiles": resource_profiles[:100],
        }

    def digital_twin_parameters(self, df: pd.DataFrame) -> dict:
        """Auto-discover resource-aware simulation parameters from a log.

        Extracts:
          - per-activity duration distribution (mean + stdev of wait time
            to next event)
          - inter-arrival distribution (mean + stdev of time between case
            starts)
          - resource availability calendar (which hour-of-day each
            resource is active and at what rate)
          - per-activity branching probabilities (for the decision tree
            in simulation)

        This is what IBM calls "Digital Twin of an Organization" — a
        richer simulation input than the usual "fixed duration per
        activity" approach.
        """
        import statistics

        # Activity duration distributions
        from app.services.transition_cache import get_transitions
        _t = get_transitions(df)
        if _t is not None:
            df["dur"] = _t.duration_secs
            df.loc[_t.is_last, "dur"] = np.nan
        else:
            sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL]).copy()
            sorted_df["next_ts"] = sorted_df.groupby(CASE_COL)[TIMESTAMP_COL].shift(-1)
            sorted_df["dur"] = (sorted_df["next_ts"] - sorted_df[TIMESTAMP_COL]).dt.total_seconds()
            df = sorted_df

        activity_stats = []
        for activity, grp in df.dropna(subset=["dur"]).groupby(ACTIVITY_COL):
            durs = grp["dur"].tolist()
            if not durs:
                continue
            try:
                mean = statistics.mean(durs)
                stdev = statistics.stdev(durs) if len(durs) > 1 else 0
            except Exception:
                mean = 0
                stdev = 0
            activity_stats.append({
                "activity": str(activity),
                "mean_seconds": round(mean, 1),
                "stdev_seconds": round(stdev, 1),
                "sample_size": len(durs),
            })
        activity_stats.sort(key=lambda a: -a["sample_size"])

        # Inter-arrival of case starts
        starts = sorted_df.groupby(CASE_COL)[TIMESTAMP_COL].min().sort_values()
        if len(starts) > 1:
            diffs = starts.diff().dt.total_seconds().dropna().tolist()
            inter_arrival = {
                "mean_seconds": round(statistics.mean(diffs), 1) if diffs else 0,
                "stdev_seconds": round(statistics.stdev(diffs), 1) if len(diffs) > 1 else 0,
                "sample_size": len(diffs),
            }
        else:
            inter_arrival = {"mean_seconds": 0, "stdev_seconds": 0, "sample_size": 0}

        # Resource calendar: rate per (resource, hour-of-day)
        resource_calendar = []
        if RESOURCE_COL in df.columns:
            df2 = df.copy()
            df2["hour"] = df2[TIMESTAMP_COL].dt.hour
            calendar_counts = df2.groupby([RESOURCE_COL, "hour"]).size().reset_index(name="count")
            for resource, grp in calendar_counts.groupby(RESOURCE_COL):
                by_hour = {int(row["hour"]): int(row["count"]) for _, row in grp.iterrows()}
                resource_calendar.append({
                    "resource": str(resource),
                    "hourly_counts": by_hour,
                    "peak_hour": int(grp.loc[grp["count"].idxmax(), "hour"]) if len(grp) > 0 else None,
                    "total_events": int(grp["count"].sum()),
                })
            resource_calendar.sort(key=lambda r: -r["total_events"])

        # Branching probabilities per activity
        branches: list[dict] = []
        sorted_df["next_activity"] = sorted_df.groupby(CASE_COL)[ACTIVITY_COL].shift(-1)
        for activity, grp in sorted_df.dropna(subset=["next_activity"]).groupby(ACTIVITY_COL):
            counts = grp["next_activity"].value_counts()
            total = int(counts.sum())
            if len(counts) < 2:
                continue
            branches.append({
                "activity": str(activity),
                "next": [
                    {"target": str(t), "probability": round(int(c) / total, 3)}
                    for t, c in counts.items()
                ],
            })

        return {
            "activity_distributions": activity_stats[:100],
            "inter_arrival": inter_arrival,
            "resource_calendar": resource_calendar[:50],
            "branching": branches[:100],
        }

    def discover_dcr_rules(self, df: pd.DataFrame) -> dict:
        """Discover a minimal DCR graph (conditions + responses) from the log.

        - Condition(A, B): every trace containing B also contains A strictly
          before it. "B requires A."
        - Response(A, B): every trace containing A also contains B strictly
          after it. "A obliges B."
        """
        trace_count = 0
        trace_contains: dict[str, int] = {}
        pair_count: dict[tuple[str, str], int] = {}

        for _, grp in df.sort_values(TIMESTAMP_COL).groupby(CASE_COL, sort=False):
            trace_count += 1
            acts = [str(a) for a in grp[ACTIVITY_COL].tolist()]
            for a in set(acts):
                trace_contains[a] = trace_contains.get(a, 0) + 1
            for i, a in enumerate(acts):
                for b in acts[i + 1:]:
                    if a != b:
                        pair_count[(a, b)] = pair_count.get((a, b), 0) + 1

        conditions = []
        responses = []
        for (a, b), count in pair_count.items():
            if trace_contains.get(b, 0) > 0 and count == trace_contains[b]:
                conditions.append({"trigger": b, "condition": a, "trace_support": count})
            if trace_contains.get(a, 0) > 0 and count == trace_contains[a]:
                responses.append({"trigger": a, "response": b, "trace_support": count})

        conditions.sort(key=lambda r: -r["trace_support"])
        responses.sort(key=lambda r: -r["trace_support"])

        return {
            "total_cases": trace_count,
            "conditions": conditions[:100],
            "responses": responses[:100],
        }

    def check_ltl(self, df: pd.DataFrame, formula: str) -> dict:
        """Evaluate a small LTL-f dialect against every case in the log.

        This is a lightweight, custom evaluator tailored to the most
        common compliance patterns. Full LTL is not supported — users
        who need that should use the log skeleton endpoint.

        Supported operators (case-insensitive):
          - ``ACTIVITY BEFORE ACTIVITY`` : first must appear before second
          - ``ACTIVITY AFTER ACTIVITY``  : first must appear after second
          - ``ACTIVITY ALWAYS_WITH ACTIVITY`` : presence implies presence
          - ``ACTIVITY NEVER_WITH ACTIVITY``  : mutually exclusive
          - ``ACTIVITY AT_LEAST_ONCE``
          - ``ACTIVITY EXACTLY_ONCE``
          - ``NOT <expr>``, ``<expr> AND <expr>``, ``<expr> OR <expr>``
        Parentheses group expressions.

        Case IDs and activity names are matched against the literal
        string in the formula.
        """
        import re

        compiled = self._compile_ltl(formula)

        compliant = 0
        total = 0
        violations: list[dict] = []
        for case_id, grp in df.sort_values(TIMESTAMP_COL).groupby(CASE_COL, sort=False):
            acts = grp[ACTIVITY_COL].tolist()
            total += 1
            if compiled(acts):
                compliant += 1
            else:
                if len(violations) < 200:
                    violations.append({"case_id": str(case_id), "activities": [str(a) for a in acts]})

        return {
            "formula": formula,
            "total_cases": total,
            "compliant_cases": compliant,
            "compliance_rate": round(compliant / total, 3) if total else 0.0,
            "sample_violations": violations,
        }

    def _compile_ltl(self, formula: str):
        """Compile a subset of LTL-f into a callable (acts: list[str]) -> bool."""
        import re

        tokens = re.findall(
            r"\(|\)|AND|OR|NOT|BEFORE|AFTER|ALWAYS_WITH|NEVER_WITH|AT_LEAST_ONCE|EXACTLY_ONCE|[A-Za-z_][\w\-\s]*",
            formula,
            flags=re.IGNORECASE,
        )
        # Normalize: strip whitespace from activity tokens
        tokens = [t.strip() for t in tokens if t.strip()]

        def parse(idx=0):
            # simple recursive-descent: expr := atom ( (AND|OR) atom )*
            def atom(i):
                if i >= len(tokens):
                    return (lambda _a: True), i
                t = tokens[i]
                up = t.upper()
                if up == "(":
                    fn, i2 = parse(i + 1)
                    # Expect close paren
                    if i2 < len(tokens) and tokens[i2] == ")":
                        return fn, i2 + 1
                    return fn, i2
                if up == "NOT":
                    sub, i2 = atom(i + 1)
                    return (lambda a, sub=sub: not sub(a)), i2
                # Otherwise treat t as an activity name, then look ahead for
                # a binary operator.
                if i + 1 >= len(tokens):
                    name = t
                    return (lambda a, n=name: n in a), i + 1
                op = tokens[i + 1].upper()
                if op in ("BEFORE", "AFTER", "ALWAYS_WITH", "NEVER_WITH"):
                    if i + 2 >= len(tokens):
                        return (lambda _a: True), i + 2
                    lhs, rhs = t, tokens[i + 2]
                    if op == "BEFORE":
                        fn = lambda a, l=lhs, r=rhs: (l in a and r in a and a.index(l) < a.index(r))
                    elif op == "AFTER":
                        fn = lambda a, l=lhs, r=rhs: (l in a and r in a and a.index(l) > a.index(r))
                    elif op == "ALWAYS_WITH":
                        fn = lambda a, l=lhs, r=rhs: (l not in a) or (r in a)
                    else:  # NEVER_WITH
                        fn = lambda a, l=lhs, r=rhs: not (l in a and r in a)
                    return fn, i + 3
                if op in ("AT_LEAST_ONCE", "EXACTLY_ONCE"):
                    name = t
                    if op == "AT_LEAST_ONCE":
                        fn = lambda a, n=name: a.count(n) >= 1
                    else:
                        fn = lambda a, n=name: a.count(n) == 1
                    return fn, i + 2
                # No binary operator — just activity presence
                return (lambda a, n=t: n in a), i + 1

            fn, i = atom(idx)
            while i < len(tokens) and tokens[i].upper() in ("AND", "OR"):
                op = tokens[i].upper()
                rhs, i = atom(i + 1)
                if op == "AND":
                    fn = (lambda a, l=fn, r=rhs: l(a) and r(a))
                else:
                    fn = (lambda a, l=fn, r=rhs: l(a) or r(a))
            return fn, i

        fn, _ = parse()
        return fn

    def run_correlation_mining(self, df: pd.DataFrame) -> dict:
        """Correlation-miner discovery for logs without explicit case IDs.

        Attempts to reconstruct cases from timestamps and attributes using
        pm4py's correlation-mining plugin. Useful for raw logs where the
        case column is unreliable or missing.
        """
        import pm4py

        try:
            # The correlation miner is a separate pm4py submodule
            from pm4py.algo.discovery.correlation_mining import algorithm as cm
            dfg, perf = cm.apply(df)
            nodes = sorted({n for pair in dfg for n in pair})
            edges = [
                {"source": s, "target": t, "frequency": int(v)}
                for (s, t), v in dfg.items()
            ]
            return {
                "nodes": nodes,
                "edges": edges,
                "total_edges": len(edges),
                "algorithm": "correlation_mining",
            }
        except Exception as e:
            logger.warning("correlation mining unavailable: %s", e)
            return {
                "nodes": [],
                "edges": [],
                "algorithm": "correlation_mining",
                "error": str(e),
            }

    def get_log_skeleton(self, df: pd.DataFrame) -> dict:
        """
        Discover the log skeleton — six families of declarative constraints
        matching pm4py's `discover_log_skeleton` output exactly (noise=0).

        Faithful O(N·k) replacement
        ────────────────────────────
        pm4py's reference implementation calls `trace_skel.after` / `before`
        which generate every (i,j) pair in a trace — O(n²) per trace. On the
        Forklift log (3 cases × ~2579 events) that's ~20M Python tuples.

        This implementation builds the after-set for each unique trace
        variant in O(n·k) by walking left-to-right with a running "seen"
        set. Before-set is derived by swapping; combos (for
        never_together) by taking k² pairs from the activity set;
        directly-follows by a single adjacent-pair scan. All family
        accumulators use the exact same `>= all_activs[x]` threshold that
        pm4py uses, so the output set is byte-identical to pm4py's.

        Families (pm4py semantics, reproduced verbatim):
          - equivalence:     (x,y) where every trace has freq[x] == freq[y]
          - always_after:    (A,B) where every trace has exactly one A and
                             ≥1 B after it, OR no A (strict pm4py rule)
          - always_before:   symmetric
          - never_together:  (x,y) where no trace contains both
          - directly_follows: (A,B) where total count of "A→B consecutive"
                             pairs across log ≥ total events of A (i.e.
                             every A is directly followed by B)
          - activ_freq:      per-activity, set of per-trace occurrence counts
        """
        from collections import Counter

        # Trace variants: matches pm4py.util.pandas_utils.get_traces.
        # NB: default groupby sorts by case_id, which matches pm4py.
        traces = [
            tuple(x)
            for x in df.groupby(CASE_COL)[ACTIVITY_COL].agg(list).to_dict().values()
        ]
        logs_traces: "Counter[tuple]" = Counter(traces)
        all_activs: "Counter[str]" = Counter()
        for trace_variant, variant_freq in logs_traces.items():
            for act in trace_variant:
                all_activs[act] += variant_freq
        events_count = sum(len(t) * f for t, f in logs_traces.items())

        equiv_sum: "Counter[tuple]" = Counter()
        after_count: "Counter[tuple]" = Counter()
        before_count: "Counter[tuple]" = Counter()
        df_count: "Counter[tuple]" = Counter()
        never_dec: "Counter[tuple]" = Counter()
        activ_freq_raw: dict[str, "Counter[int]"] = {
            act: Counter() for act in all_activs
        }

        for trace_variant, variant_freq in logs_traces.items():
            n = len(trace_variant)
            freq = Counter(trace_variant)

            # equivalence per-trace: Σ over (x,y) with freq[x]==freq[y] of freq[x]
            for x, fx in freq.items():
                for y, fy in freq.items():
                    if x != y and fx == fy:
                        equiv_sum[(x, y)] += fx * variant_freq

            # after-set in O(n·k): left-to-right, track "seen so far".
            # Inner loop naturally emits (a,a) the second time a is seen.
            after_set: set[tuple] = set()
            seen_left: set = set()
            for act in trace_variant:
                for prev in seen_left:
                    after_set.add((prev, act))
                seen_left.add(act)
            for pair in after_set:
                after_count[pair] += variant_freq
                # before-set is just the swap; pm4py's trace_skel.before
                # yields (trace[i], trace[j]) with j<i so its set is the
                # reverse of after-set's tuples.
                before_count[(pair[1], pair[0])] += variant_freq

            # directly-follows counter (counts duplicate consecutive pairs)
            for i in range(n - 1):
                df_count[(trace_variant[i], trace_variant[i + 1])] += variant_freq

            # never_together decrement: one hit per (x,y) with x!=y both
            # present in the trace — pm4py's combos() returns a set.
            acts_in_trace = list(freq.keys())
            for x in acts_in_trace:
                for y in acts_in_trace:
                    if x != y:
                        never_dec[(x, y)] += variant_freq

            # activ_freq: per-trace activity count (pad missing with 0)
            for a in all_activs:
                activ_freq_raw[a][freq.get(a, 0)] += variant_freq

        equivalence_set = {
            (x, y) for (x, y), s in equiv_sum.items() if s >= all_activs[x]
        }
        always_after_set = {
            (A, B) for (A, B), s in after_count.items() if s >= all_activs[A]
        }
        always_before_set = {
            (A, B) for (A, B), s in before_count.items() if s >= all_activs[A]
        }
        never_together_set = {
            (x, y)
            for x in all_activs
            for y in all_activs
            if x != y and (x, y) not in never_dec
        }
        directly_follows_set = {
            (A, B) for (A, B), s in df_count.items() if s >= all_activs[A]
        }

        # activ_freq: faithful port of pm4py's truncation loop at
        # noise_threshold=0. The loop rarely truncates anything because
        # the accumulator is in "trace counts" units and the threshold
        # is in "event counts" units — but we reproduce it exactly so
        # any edge case behaves identically.
        activ_freq_out: dict[str, set] = {}
        for act, cnt_counter in activ_freq_raw.items():
            sorted_items = sorted(
                cnt_counter.items(), key=lambda x: x[1], reverse=True
            )
            added = 0
            i = 0
            while i < len(sorted_items):
                added += sorted_items[i][1]
                if added >= events_count:
                    sorted_items = sorted_items[: min(i + 1, len(sorted_items))]
                i += 1
            activ_freq_out[act] = set(v for (v, _) in sorted_items)

        skeleton = {
            "equivalence": equivalence_set,
            "always_after": always_after_set,
            "always_before": always_before_set,
            "never_together": never_together_set,
            "directly_follows": directly_follows_set,
            "activ_freq": activ_freq_out,
        }

        def _convert(obj):
            if isinstance(obj, dict):
                return {str(k): _convert(v) for k, v in obj.items()}
            if isinstance(obj, (set, frozenset)):
                return [_convert(i) for i in sorted(str(x) for x in obj)]
            if isinstance(obj, (tuple, list)):
                return [_convert(i) for i in obj]
            return obj

        return {"constraints": _convert(skeleton)}

    def get_declare(self, df: pd.DataFrame) -> dict:
        """
        Discover DECLARE constraints from the event log.

        Returns:
            dict with key: rules (list of {template, activity_a, activity_b, support})
        """
        import pm4py

        declare_model = pm4py.discover_declare(
            df,
            activity_key=ACTIVITY_COL,
            case_id_key=CASE_COL,
            timestamp_key=TIMESTAMP_COL,
        )

        rules = []
        for template_name, pairs in declare_model.items():
            if isinstance(pairs, dict):
                for pair_key, support in pairs.items():
                    if isinstance(pair_key, (tuple, list)) and len(pair_key) == 2:
                        act_a, act_b = str(pair_key[0]), str(pair_key[1])
                    else:
                        act_a = str(pair_key)
                        act_b = None
                    if isinstance(support, dict):
                        sup_val = support.get("support", support.get("confidence", 0))
                    else:
                        sup_val = support
                    try:
                        sup_val = float(sup_val)
                    except (TypeError, ValueError):
                        sup_val = 0.0
                    rules.append({
                        "template": str(template_name),
                        "activity_a": act_a,
                        "activity_b": act_b,
                        "support": sup_val,
                    })
            elif isinstance(pairs, (int, float)):
                # Unary template — no pair
                rules.append({
                    "template": str(template_name),
                    "activity_a": "",
                    "activity_b": None,
                    "support": float(pairs),
                })

        return {"rules": rules}

    def check_four_eyes(
        self, df: pd.DataFrame, activity1: str, activity2: str
    ) -> dict:
        """
        Find cases that violate the four-eyes principle: cases where the same
        resource performs both activity1 and activity2.

        Returns:
            dict with keys: violations (list of {case_id, resource}),
            total_cases (int), violating_cases (int)
        """
        import pm4py

        if RESOURCE_COL not in df.columns:
            total_cases = int(df[CASE_COL].nunique())
            return {
                "violations": [],
                "total_cases": total_cases,
                "violating_cases": 0,
            }

        total_cases = int(df[CASE_COL].nunique())

        try:
            filtered = pm4py.filter_four_eyes_principle(
                df,
                activity1,
                activity2,
                activity_key=ACTIVITY_COL,
                resource_key=RESOURCE_COL,
                case_id_key=CASE_COL,
            )
        except Exception:
            return {
                "violations": [],
                "total_cases": total_cases,
                "violating_cases": 0,
            }

        violations = []
        if not filtered.empty:
            for case_id, group in filtered.groupby(CASE_COL, sort=False):
                # Collect resources that appear in both activities for this case
                res_a = set(
                    group[group[ACTIVITY_COL] == activity1][RESOURCE_COL]
                    .dropna().astype(str)
                )
                res_b = set(
                    group[group[ACTIVITY_COL] == activity2][RESOURCE_COL]
                    .dropna().astype(str)
                )
                for res in res_a & res_b:
                    violations.append({"case_id": str(case_id), "resource": res})

        return {
            "violations": violations,
            "total_cases": total_cases,
            "violating_cases": int(filtered[CASE_COL].nunique()) if not filtered.empty else 0,
        }

    def get_performance_spectrum(self, df: pd.DataFrame, limit: int = 100) -> dict:
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

    def get_features(self, df: pd.DataFrame) -> dict:
        """
        Extract a feature DataFrame from the event log (one row per case).

        Returns:
            dict with keys: columns (list[str]), rows (list[dict]), total_cases (int)
        """
        import pm4py

        features_df = pm4py.extract_features_dataframe(
            df,
            activity_key=ACTIVITY_COL,
            case_id_key=CASE_COL,
            timestamp_key=TIMESTAMP_COL,
        )

        columns = features_df.columns.tolist()
        total_cases = len(features_df)

        # Convert to JSON-serialisable dicts; replace NaN with None
        rows = []
        for _, row in features_df.iterrows():
            row_dict = {}
            for col in columns:
                val = row[col]
                if pd.isna(val):
                    row_dict[col] = None
                elif isinstance(val, (int, float)):
                    row_dict[col] = float(val)
                else:
                    row_dict[col] = str(val)
            rows.append(row_dict)

        return {
            "columns": [str(c) for c in columns],
            "rows": rows,
            "total_cases": total_cases,
        }

    def generate_insights(self, df: pd.DataFrame) -> dict:
        """
        Run multiple analyses on the DataFrame and generate plain-language insights.

        Calls existing analysis methods and synthesises the results into actionable
        Insight dicts, sorted by severity (critical → warning → info).

        Returns:
            dict with keys: insights (list of insight dicts), summary (str)
        """
        insights: list[dict] = []

        # ── 1. Basic stats (used by many blocks below) ───────────────────────
        total_cases = int(df[CASE_COL].nunique())
        total_events = len(df)
        total_activities = int(df[ACTIVITY_COL].nunique())

        # Case durations — computed early so downstream blocks can reference it
        try:
            case_durations = df.groupby(CASE_COL)[TIMESTAMP_COL].apply(
                lambda x: (x.max() - x.min()).total_seconds()
            )
            avg_case_duration = float(case_durations.mean()) if len(case_durations) > 0 else 0.0
        except Exception:
            case_durations = pd.Series(dtype=float)
            avg_case_duration = 0.0

        # Track results from early analyses so later blocks can cross-reference
        bottleneck_result: dict | None = None
        rework_result: dict | None = None
        overall_rework_rate = 0.0

        # ── 2. Bottleneck insights ───────────────────────────────────────────
        try:
            bottleneck_result = self.run_bottleneck_analysis(df)
            bottlenecks = bottleneck_result.get('bottlenecks', [])
            critical = [b for b in bottlenecks if b.get('is_bottleneck')]
            if critical:
                worst = max(critical, key=lambda b: b.get('avg_duration', 0))
                avg_dur = worst['avg_duration']
                dur_str = _fmt_dur(avg_dur)
                median_all = sorted([b['avg_duration'] for b in bottlenecks])
                median_val = median_all[len(median_all) // 2] if median_all else avg_dur
                pct_above = ((avg_dur - median_val) / median_val * 100) if median_val > 0 else 0
                half_saved = avg_dur * 0.5

                insights.append({
                    'category': 'bottleneck',
                    'severity': 'critical',
                    'title': f'"{worst["activity"]}" is your biggest bottleneck',
                    'description': f'This activity takes {dur_str} on average, which is {pct_above:.0f}% longer than the median activity duration.',
                    'metric_value': avg_dur,
                    'recommendation': f'Focus optimization efforts on "{worst["activity"]}". Consider automating parts of this step, adding resources, or redesigning the workflow to reduce time spent here.',
                    'related_activities': [worst['activity']],
                    'impact_estimate': f'Reducing duration by 50% would save ~{_fmt_dur(half_saved)} per occurrence.',
                })

            if len(critical) > 1:
                insights.append({
                    'category': 'bottleneck',
                    'severity': 'warning',
                    'title': f'{len(critical)} activities flagged as bottlenecks',
                    'description': f'Activities {", ".join(b["activity"] for b in critical[:3])} are all taking significantly longer than average.',
                    'metric_value': len(critical),
                    'recommendation': 'Prioritize the slowest bottleneck first, then work through the list.',
                    'related_activities': [b['activity'] for b in critical[:5]],
                })
        except Exception:
            pass

        # ── 3. Waiting time / handoff bottleneck ─────────────────────────────
        try:
            if bottleneck_result and avg_case_duration > 0:
                waiting_times = bottleneck_result.get('waiting_times', [])
                if waiting_times:
                    top_wait = waiting_times[0]  # already sorted desc by avg_waiting
                    avg_wait = top_wait['avg_waiting']
                    wait_pct = (avg_wait / avg_case_duration * 100) if avg_case_duration > 0 else 0
                    if wait_pct > 25:
                        sev = 'critical' if wait_pct > 50 else 'warning'
                        half_wait = avg_wait / 2
                        insights.append({
                            'category': 'waiting_time',
                            'severity': sev,
                            'title': f'Cases wait longest between "{top_wait["source"]}" and "{top_wait["target"]}"',
                            'description': f'The handoff between these steps averages {_fmt_dur(avg_wait)} — {wait_pct:.0f}% of total case duration. The worst case waited {_fmt_dur(top_wait["max_waiting"])}.',
                            'metric_value': avg_wait,
                            'recommendation': f'This idle time is not processing — it is waiting. Investigate whether it is queue buildup, email-based handoffs, or a capacity issue on "{top_wait["target"]}".',
                            'related_activities': [top_wait['source'], top_wait['target']],
                            'impact_estimate': f'Cutting this waiting time by half would reduce avg case duration by ~{_fmt_dur(half_wait)}.',
                        })
        except Exception:
            pass

        # ── 4. Variant insights ──────────────────────────────────────────────
        variant_result: dict | None = None
        try:
            variant_result = self.run_variant_analysis(df)
            variants = variant_result.get('variants', [])
            total_variants = variant_result.get('total_variants', len(variants))
            if variants:
                top_coverage = variants[0].get('percentage', 0)
                if top_coverage < 50:
                    insights.append({
                        'category': 'variant',
                        'severity': 'warning',
                        'title': 'Highly variable process',
                        'description': f'The most common execution path covers only {top_coverage:.1f}% of cases. There are {total_variants} unique variants.',
                        'metric_value': top_coverage,
                        'recommendation': 'High variability may indicate ad-hoc workarounds or lack of standardization. Review less common variants to see if they can be eliminated or standardized.',
                    })
                elif total_variants == 1:
                    insights.append({
                        'category': 'variant',
                        'severity': 'info',
                        'title': 'Perfectly standardized process',
                        'description': 'All cases follow the exact same execution path.',
                        'metric_value': 100.0,
                        'recommendation': 'Great consistency! Monitor for future deviations.',
                    })

                if len(variants) >= 2:
                    fast = variants[0].get('avg_duration')
                    slow = max((v.get('avg_duration') or 0 for v in variants), default=0)
                    if fast and slow and fast > 0 and slow / fast > 3:
                        insights.append({
                            'category': 'duration',
                            'severity': 'warning',
                            'title': 'Large duration spread between variants',
                            'description': f'The slowest variant takes {_fmt_dur(slow)}, while the fastest takes {_fmt_dur(fast)} — a {slow/fast:.1f}x difference.',
                            'metric_value': slow / fast,
                            'recommendation': 'Investigate what causes slower variants. They may involve additional approval steps, rework, or waiting times.',
                        })
        except Exception:
            pass

        # ── 5. Happy path narrative ──────────────────────────────────────────
        try:
            if variant_result:
                variants = variant_result.get('variants', [])
                if len(variants) >= 3:
                    happy = variants[0]
                    happy_dur = happy.get('avg_duration') or 0
                    happy_pct = happy.get('percentage', 0)
                    happy_acts = happy.get('activities', [])
                    if happy_dur > 0 and happy_pct >= 20:
                        # Weighted avg duration of non-happy variants
                        other_total_cases = 0
                        other_weighted_dur = 0.0
                        for v in variants[1:]:
                            vc = v.get('case_count', 0)
                            vd = v.get('avg_duration') or 0
                            other_total_cases += vc
                            other_weighted_dur += vc * vd
                        other_avg_dur = (other_weighted_dur / other_total_cases) if other_total_cases > 0 else 0
                        extra_time = other_avg_dur - happy_dur
                        if extra_time > 0 and other_total_cases > 0:
                            deviating_pct = 100 - happy_pct
                            # If 50% of deviating cases followed the happy path
                            saved_per_case = (extra_time * 0.5 * (deviating_pct / 100))
                            path_str = ' → '.join(happy_acts[:6])
                            if len(happy_acts) > 6:
                                path_str += ' → …'
                            insights.append({
                                'category': 'variant',
                                'severity': 'info',
                                'title': f'Happy path completes in {_fmt_dur(happy_dur)}; detours add {_fmt_dur(extra_time)} on average',
                                'description': f'The most common path ({path_str}) covers {happy_pct:.0f}% of cases and completes in {_fmt_dur(happy_dur)}. The remaining {deviating_pct:.0f}% follow {len(variants) - 1} other variants averaging {_fmt_dur(other_avg_dur)}.',
                                'metric_value': extra_time,
                                'recommendation': f'Investigate what causes cases to deviate from the happy path. Standardizing more cases to the main path could significantly reduce cycle time.',
                                'related_activities': happy_acts[:5],
                                'impact_estimate': f'If 50% of deviating cases followed the happy path, avg case duration would drop by ~{_fmt_dur(saved_per_case)}.',
                            })
        except Exception:
            pass

        # ── 6. Rework insights ───────────────────────────────────────────────
        try:
            rework_result = self.get_rework(df)
            overall_rework_rate = rework_result.get('overall_rework_rate', 0)
            if overall_rework_rate > 20:
                rework_acts = rework_result.get('activities', [])
                worst_rework = max(rework_acts, key=lambda a: a.get('rework_rate', 0)) if rework_acts else None
                insights.append({
                    'category': 'rework',
                    'severity': 'critical' if overall_rework_rate > 40 else 'warning',
                    'title': f'{overall_rework_rate:.0f}% of cases involve rework',
                    'description': (
                        f'{rework_result.get("cases_with_rework", 0)} out of {total_cases} cases have at least one repeated activity.'
                        + (f' The most reworked activity is "{worst_rework["activity"]}" ({worst_rework["rework_rate"]:.0f}% rework rate).' if worst_rework else '')
                    ),
                    'metric_value': overall_rework_rate,
                    'recommendation': 'Rework often indicates errors, incomplete work, or unclear requirements. Investigate the root cause of repeated activities and consider adding quality checks earlier in the process.',
                    'related_activities': [a['activity'] for a in rework_acts[:3]] if rework_acts else None,
                })

            self_loops = rework_result.get('self_loops', [])
            if self_loops:
                insights.append({
                    'category': 'rework',
                    'severity': 'info',
                    'title': f'{len(self_loops)} self-loop{"s" if len(self_loops) != 1 else ""} detected',
                    'description': f'Activities that immediately repeat: {", ".join(s["activity"] for s in self_loops[:3])}.',
                    'metric_value': len(self_loops),
                    'recommendation': 'Self-loops may indicate retry behavior, data entry corrections, or system issues.',
                    'related_activities': [s['activity'] for s in self_loops[:5]],
                })
        except Exception:
            pass

        # ── 7. Conformance insights ──────────────────────────────────────────
        try:
            conf_result = self.run_conformance(df)
            fitness = conf_result.get('fitness', 1.0)
            if fitness < 0.8:
                conformant = conf_result.get('conformant_cases', 0)
                total = conf_result.get('total_cases', total_cases)
                dev_pct = ((total - conformant) / total * 100) if total > 0 else 0
                insights.append({
                    'category': 'conformance',
                    'severity': 'critical' if fitness < 0.6 else 'warning',
                    'title': f'Low process conformance ({fitness*100:.0f}%)',
                    'description': f'{dev_pct:.0f}% of cases deviate from the expected process model. {len(conf_result.get("deviations", []))} individual deviations detected.',
                    'metric_value': fitness,
                    'recommendation': 'Review the most common deviations. They may indicate training gaps, system workarounds, or legitimate process exceptions that should be modeled.',
                })
        except Exception:
            pass

        # ── 8. Resource concentration ────────────────────────────────────────
        try:
            if RESOURCE_COL in df.columns:
                resource_activity = df.groupby([ACTIVITY_COL, RESOURCE_COL]).size().reset_index(name='count')
                activity_totals = df.groupby(ACTIVITY_COL).size().reset_index(name='total')
                merged = resource_activity.merge(activity_totals, on=ACTIVITY_COL)
                merged['pct'] = merged['count'] / merged['total'] * 100
                concentrated = merged[merged['pct'] > 60].sort_values('pct', ascending=False)
                if len(concentrated) > 0:
                    top = concentrated.iloc[0]
                    insights.append({
                        'category': 'resource',
                        'severity': 'warning',
                        'title': f'Resource concentration on "{top[ACTIVITY_COL]}"',
                        'description': f'Resource "{top[RESOURCE_COL]}" handles {top["pct"]:.0f}% of all "{top[ACTIVITY_COL]}" events. This creates a single point of failure.',
                        'metric_value': top['pct'],
                        'recommendation': f'Cross-train additional resources on "{top[ACTIVITY_COL]}" to reduce dependency and improve resilience.',
                        'related_activities': [top[ACTIVITY_COL]],
                    })
        except Exception:
            pass

        # ── 9. Automation opportunity ────────────────────────────────────────
        try:
            if bottleneck_result:
                bottlenecks = bottleneck_result.get('bottlenecks', [])
                critical_names = {b['activity'] for b in bottlenecks if b.get('is_bottleneck')}
                avg_freq = total_events / max(total_activities, 1)
                candidates = [
                    b for b in bottlenecks
                    if b.get('avg_duration', 999) < 300
                    and b.get('frequency', 0) > avg_freq
                    and b['activity'] not in critical_names
                ]
                if candidates:
                    best = max(candidates, key=lambda b: b.get('frequency', 0))
                    freq = best['frequency']
                    dur = best['avg_duration']
                    hours_saved = (freq * dur) / 3600
                    insights.append({
                        'category': 'automation',
                        'severity': 'info',
                        'title': f'"{best["activity"]}" is a strong automation candidate',
                        'description': f'This activity occurs {freq:,} times with an average duration of {_fmt_dur(dur)} — high-frequency, low-complexity, and consumes significant resource time.',
                        'metric_value': hours_saved,
                        'recommendation': f'Activities like this are well-suited for RPA or workflow automation. Automating "{best["activity"]}" at current frequency would free up substantial capacity.',
                        'related_activities': [best['activity']],
                        'impact_estimate': f'Estimated {hours_saved:.1f} hours saved per period ({freq:,} occurrences × {_fmt_dur(dur)}).',
                    })
        except Exception:
            pass

        # ── 10. Batch processing insight ─────────────────────────────────────
        try:
            batch_result = self.get_batches(df)
            batches = batch_result.get('batches', [])
            if batches:
                biggest = max(batches, key=lambda b: b.get('num_cases', 0))
                sev = 'warning' if biggest.get('num_cases', 0) > 20 else 'info'
                insights.append({
                    'category': 'batch',
                    'severity': sev,
                    'title': f'Batch processing detected on "{biggest["activity"]}"',
                    'description': f'Resource "{biggest.get("resource", "unknown")}" processes "{biggest["activity"]}" in {biggest.get("batch_type", "simultaneous")} batches, with up to {biggest["num_cases"]} cases at once.',
                    'metric_value': biggest['num_cases'],
                    'recommendation': 'Batching can hide individual case delays. Consider whether batch sizes are intentional or caused by queue buildup.',
                    'related_activities': [biggest['activity']],
                })
        except Exception:
            pass

        # ── 11. Concurrent case load ─────────────────────────────────────────
        try:
            overlap_result = self.get_case_overlap(df)
            max_overlap = overlap_result.get('max_overlap', 0)
            avg_overlap = overlap_result.get('avg_overlap', 0)
            if avg_overlap > 0 and max_overlap > 5 * avg_overlap:
                ratio = max_overlap / avg_overlap
                insights.append({
                    'category': 'workload',
                    'severity': 'warning',
                    'title': f'Peak concurrent load reaches {ratio:.1f}x the average',
                    'description': f'The process typically handles {avg_overlap:.0f} cases simultaneously, but peaks at {max_overlap} concurrent cases. This workload spike likely contributes to bottlenecks and waiting times.',
                    'metric_value': max_overlap,
                    'recommendation': 'Investigate whether these spikes are predictable (e.g., month-end). If so, pre-emptive resource allocation or case prioritization could smooth throughput.',
                })
        except Exception:
            pass

        # ── 12. Root cause attribute correlation ─────────────────────────────
        try:
            extra_cols = [c for c in df.columns if c not in {CASE_COL, ACTIVITY_COL, TIMESTAMP_COL, RESOURCE_COL}]
            if extra_cols:
                rc_result = self.run_root_cause_analysis(df)
                factors = rc_result.get('factors', [])
                for factor in factors[:1]:  # top factor only
                    dur_affected = factor.get('avg_duration_affected', 0)
                    dur_normal = factor.get('avg_duration_normal', 0)
                    case_count = factor.get('case_count', 0)
                    if dur_normal > 0 and case_count >= 10:
                        ratio = dur_affected / dur_normal
                        if ratio > 1.5:
                            diff = dur_affected - dur_normal
                            insights.append({
                                'category': 'root_cause',
                                'severity': 'critical' if ratio > 2 else 'warning',
                                'title': f'Cases with "{factor["attribute"]} = {factor["value"]}" take {ratio:.1f}x longer',
                                'description': f'The {case_count} cases where {factor["attribute"]} is "{factor["value"]}" average {_fmt_dur(dur_affected)}, versus {_fmt_dur(dur_normal)} for all other cases — a difference of {_fmt_dur(diff)}.',
                                'metric_value': ratio,
                                'recommendation': f'This attribute strongly predicts slow cases. Investigate what is different about "{factor["value"]}" — staffing, data quality, or process differences.',
                                'impact_estimate': f'~{_fmt_dur(diff)} extra per case, affecting {case_count} cases.',
                            })
        except Exception:
            pass

        # ── 13. Temporal deviation ───────────────────────────────────────────
        try:
            tp_result = self.get_temporal_profile(df)
            profiles = tp_result.get('profiles', [])
            deviations = tp_result.get('deviations', [])

            # Find highest coefficient of variation
            if profiles:
                best_cv = None
                for p in profiles:
                    mean = p.get('mean', 0)
                    stdev = p.get('stdev', 0)
                    if mean > 0:
                        cv = stdev / mean
                        if best_cv is None or cv > best_cv[0]:
                            best_cv = (cv, p)
                if best_cv and best_cv[0] > 1.0:
                    cv_val, p = best_cv
                    insights.append({
                        'category': 'timing_anomaly',
                        'severity': 'warning',
                        'title': f'Transition from "{p["source"]}" to "{p["target"]}" is highly unpredictable',
                        'description': f'This step averages {_fmt_dur(p["mean"])} but has a standard deviation of {_fmt_dur(p["stdev"])} (CV = {cv_val:.1f}). Some cases fly through in minutes; others take days.',
                        'metric_value': cv_val,
                        'recommendation': f'High variance suggests no consistent process for handling this step. Investigate whether routing rules, resource availability, or case complexity drive the spread.',
                        'related_activities': [p['source'], p['target']],
                    })

            # Deviation count
            if deviations:
                dev_count = len(deviations)
                insights.append({
                    'category': 'timing_anomaly',
                    'severity': 'info' if dev_count < 50 else 'warning',
                    'title': f'{dev_count} case{"s have" if dev_count != 1 else " has"} timing anomalies',
                    'description': f'{dev_count} case{"s show" if dev_count != 1 else " shows"} at least one activity transition that took more than 2 standard deviations from the expected time — either unusually fast or unusually slow.',
                    'metric_value': dev_count,
                    'recommendation': 'Review these cases for missed steps, data entry delays, or exceptional handling that inflated timestamps.',
                })
        except Exception:
            pass

        # ── 14. Resource cross-perspective: rework by resource ────────────────
        try:
            if RESOURCE_COL in df.columns and rework_result and overall_rework_rate > 0:
                cases_with_rework_set = set()
                for act in rework_result.get('activities', []):
                    for cid in act.get('case_ids', []):
                        cases_with_rework_set.add(cid)
                if not cases_with_rework_set:
                    # Derive from df: cases where any activity appears >1 time
                    case_act_counts = df.groupby([CASE_COL, ACTIVITY_COL]).size().reset_index(name='cnt')
                    cases_with_rework_set = set(case_act_counts[case_act_counts['cnt'] > 1][CASE_COL].unique())

                if cases_with_rework_set:
                    # Primary resource per case = most frequent resource in that case
                    case_resource = df.groupby(CASE_COL)[RESOURCE_COL].agg(lambda x: x.mode().iloc[0] if len(x.mode()) > 0 else x.iloc[0])
                    resource_cases = case_resource.groupby(case_resource).apply(lambda g: g.index.tolist())
                    worst_resource = None
                    worst_ratio = 0
                    for resource, case_ids in resource_cases.items():
                        if len(case_ids) < 10:
                            continue
                        rework_count = sum(1 for cid in case_ids if cid in cases_with_rework_set)
                        rate = (rework_count / len(case_ids)) * 100
                        ratio = rate / overall_rework_rate if overall_rework_rate > 0 else 0
                        if ratio > worst_ratio:
                            worst_ratio = ratio
                            worst_resource = (resource, len(case_ids), rate, rework_count)

                    if worst_resource and worst_ratio > 2:
                        res_name, res_cases, res_rate, res_rework = worst_resource
                        excess = res_rework - int(res_cases * overall_rework_rate / 100)
                        insights.append({
                            'category': 'resource',
                            'severity': 'warning',
                            'title': f'"{res_name}" has {worst_ratio:.1f}x the average rework rate',
                            'description': f'"{res_name}" handles {res_cases} cases with a {res_rate:.0f}% rework rate, compared to the process average of {overall_rework_rate:.0f}%. This may indicate a training issue or systematically harder case assignment.',
                            'metric_value': res_rate,
                            'recommendation': f'Investigate whether "{res_name}" handles a specific type of complex case, or whether targeted training would reduce rework.',
                            'impact_estimate': f'If this resource matched the average rate, ~{excess} rework incidents per period would be eliminated.',
                        })
        except Exception:
            pass

        # ── 15. Cost insights (conditional on COST_COL) ──────────────────────
        try:
            if COST_COL in df.columns:
                total_cost = df[COST_COL].sum()
                if total_cost > 0 and rework_result:
                    # Rework cost: derive cases with rework
                    case_act_counts = df.groupby([CASE_COL, ACTIVITY_COL]).size().reset_index(name='cnt')
                    rework_case_ids = set(case_act_counts[case_act_counts['cnt'] > 1][CASE_COL].unique())
                    case_costs = df.groupby(CASE_COL)[COST_COL].sum()
                    rework_cost = float(case_costs[case_costs.index.isin(rework_case_ids)].sum())
                    rework_pct = (rework_cost / total_cost * 100) if total_cost > 0 else 0
                    if rework_pct > 10:
                        avg_cost_rework = float(case_costs[case_costs.index.isin(rework_case_ids)].mean())
                        avg_cost_normal = float(case_costs[~case_costs.index.isin(rework_case_ids)].mean())
                        insights.append({
                            'category': 'cost',
                            'severity': 'warning',
                            'title': f'Rework accounts for {rework_pct:.0f}% of total cost',
                            'description': f'Cases with rework have an average cost of {avg_cost_rework:,.0f}, versus {avg_cost_normal:,.0f} for cases without rework — a {((avg_cost_rework / max(avg_cost_normal, 1)) - 1) * 100:.0f}% premium.',
                            'metric_value': rework_pct,
                            'recommendation': 'Reducing rework would directly lower costs. Target the activities with the highest rework rates for quality improvements.',
                            'impact_estimate': f'Eliminating rework could save up to {rework_cost:,.0f} in cost.',
                        })
        except Exception:
            pass

        # ── 16. Case duration insight (informational) ────────────────────────
        try:
            if avg_case_duration > 0 and len(case_durations) > 0:
                insights.append({
                    'category': 'performance',
                    'severity': 'info',
                    'title': f'Average case takes {_fmt_dur(avg_case_duration)}',
                    'description': f'Cases range from {_fmt_dur(case_durations.min())} to {_fmt_dur(case_durations.max())}. Median is {_fmt_dur(case_durations.median())}.',
                    'metric_value': avg_case_duration,
                    'recommendation': None,
                })
        except Exception:
            pass

        # ── 17. Long tail of slow cases (P90/P50 ratio) ──────────────────────
        # A few extreme outlier cases can distort every downstream metric.
        # Surface them separately so users can investigate stuck / abandoned
        # cases instead of writing off the whole process as "slow".
        try:
            if len(case_durations) >= 20:
                p50 = float(case_durations.quantile(0.5))
                p90 = float(case_durations.quantile(0.9))
                p99 = float(case_durations.quantile(0.99))
                if p50 > 0 and (p90 / p50) > 4:
                    pct_over_p90 = int((case_durations > p90).sum())
                    insights.append({
                        'category': 'duration',
                        'severity': 'warning' if p90 / p50 > 8 else 'info',
                        'title': f'Long tail: slowest 10% of cases take {p90/p50:.1f}x the median',
                        'description': (
                            f'Median case finishes in {_fmt_dur(p50)}; the 90th percentile is {_fmt_dur(p90)} '
                            f'and the 99th percentile reaches {_fmt_dur(p99)}. {pct_over_p90} cases exceed the P90 threshold.'
                        ),
                        'metric_value': p90 / p50,
                        'recommendation': 'Investigate the slowest cases individually — they are often stuck on a single step, waiting on external approval, or abandoned. Eliminating the tail is usually cheaper than speeding up the median.',
                    })
        except Exception:
            pass

        # ── 18. Off-hours / weekend work ─────────────────────────────────────
        # Operational work happening outside normal business hours usually
        # means on-call, emergency escalation, or batch scripts running at
        # night. Either way, it's worth knowing how much of the process
        # actually runs off-hours.
        try:
            ts = pd.to_datetime(df[TIMESTAMP_COL], errors='coerce').dropna()
            if len(ts) > 50:
                if getattr(ts.dt, 'tz', None) is not None:
                    ts = ts.dt.tz_convert('UTC').dt.tz_localize(None)
                hour = ts.dt.hour
                dow = ts.dt.dayofweek  # 0 = Mon
                off_hours = ((hour < 7) | (hour >= 19)).sum()
                weekend = (dow >= 5).sum()
                total = len(ts)
                off_pct = (off_hours / total) * 100
                wk_pct = (weekend / total) * 100
                if off_pct >= 20:
                    insights.append({
                        'category': 'workload',
                        'severity': 'warning' if off_pct >= 40 else 'info',
                        'title': f'{off_pct:.0f}% of events happen outside business hours',
                        'description': (
                            f'{int(off_hours):,} of {total:,} events land between 7pm and 7am. '
                            f'{wk_pct:.0f}% land on a weekend.'
                        ),
                        'metric_value': off_pct,
                        'recommendation': 'Off-hours activity usually means on-call work, batch jobs, or SLA escalations. Decide whether this is an automation pattern to keep or an overtime pattern to eliminate.',
                    })
        except Exception:
            pass

        # ── 19. Unusual start / end activities ───────────────────────────────
        # Healthy processes almost always start with one of a small set of
        # entry activities. A case that starts mid-process often means
        # missing upstream events or an incomplete extraction.
        try:
            per_case = df.sort_values(TIMESTAMP_COL).groupby(CASE_COL, sort=False)
            starts = per_case[ACTIVITY_COL].first().value_counts()
            ends = per_case[ACTIVITY_COL].last().value_counts()
            if total_cases >= 20 and len(starts) > 0:
                top_start = starts.iloc[0]
                top_start_pct = (top_start / total_cases) * 100
                distinct_starts = int((starts > 0).sum())
                if distinct_starts > 3 and top_start_pct < 60:
                    insights.append({
                        'category': 'structure',
                        'severity': 'warning',
                        'title': f'{distinct_starts} different activities kick off cases',
                        'description': (
                            f'Only {top_start_pct:.0f}% of cases start with the most common entry point '
                            f'("{starts.idxmax()}"). The remaining cases begin with {distinct_starts - 1} other activities.'
                        ),
                        'metric_value': float(distinct_starts),
                        'recommendation': 'Multiple start points usually mean (a) the log is incomplete (missing initial events) or (b) the process has several legitimate triggers. If the first, fix extraction; if the second, document each entry path.',
                    })
            if total_cases >= 20 and len(ends) > 0:
                top_end_pct = (ends.iloc[0] / total_cases) * 100
                if top_end_pct < 50 and int((ends > 0).sum()) > 5:
                    insights.append({
                        'category': 'structure',
                        'severity': 'warning',
                        'title': f'Cases end in {int((ends > 0).sum())} different activities',
                        'description': (
                            f'The most common end state ("{ends.idxmax()}") covers only {top_end_pct:.0f}% of cases. '
                            'Many cases may be abandoning, escalating, or terminating early.'
                        ),
                        'metric_value': float(int((ends > 0).sum())),
                        'recommendation': 'Look at the less common end activities. They often flag abandonments, returns, or unhappy-path exits that deserve their own follow-up.',
                    })
        except Exception:
            pass

        # ── 20. Variant Pareto concentration ─────────────────────────────────
        # Standardised processes usually obey a ~Pareto distribution: a
        # handful of variants cover most cases. We've already covered the
        # top-1 coverage case above; this block looks at the broader shape.
        try:
            if variant_result:
                variants = variant_result.get('variants', [])
                tv = variant_result.get('total_variants', len(variants))
                if tv >= 5 and total_cases > 0:
                    # How many variants to cover 80% of cases?
                    covered = 0
                    needed = 0
                    target = total_cases * 0.8
                    for v in variants:
                        covered += v.get('case_count', 0)
                        needed += 1
                        if covered >= target:
                            break
                    concentration = needed / tv
                    if concentration > 0.6:
                        insights.append({
                            'category': 'variant',
                            'severity': 'warning',
                            'title': f'No dominant path — {needed} variants needed to cover 80% of cases',
                            'description': (
                                f'Out of {tv} variants, {needed} are required to capture 80% of cases. '
                                'A well-standardised process usually needs 20% of variants to cover 80% of cases.'
                            ),
                            'metric_value': concentration,
                            'recommendation': 'A long, flat variant distribution signals ad-hoc process execution. Look for the common subsequences that appear across many variants and turn them into a documented happy path.',
                        })
        except Exception:
            pass

        # ── 21. Four-eyes principle compliance ───────────────────────────────
        # Generic four-eyes check: does any resource ever both request and
        # approve within the same case? We scan activity names for common
        # request/approve pairs so this works without explicit configuration.
        # If there's no `org:resource` column we skip entirely.
        try:
            if RESOURCE_COL in df.columns:
                acts_lower = {str(a).lower(): str(a) for a in df[ACTIVITY_COL].dropna().unique()}
                req_acts = [orig for low, orig in acts_lower.items() if 'request' in low or 'submit' in low or 'create' in low]
                app_acts = [orig for low, orig in acts_lower.items() if 'approve' in low or 'sign' in low or 'authorize' in low]
                if req_acts and app_acts:
                    res = self.check_four_eyes(df, req_acts[0], app_acts[0])
                    violations = res.get('violating_cases', 0)
                    total = res.get('total_cases', total_cases) or 1
                    viol_pct = (violations / total) * 100
                    if violations > 0:
                        insights.append({
                            'category': 'compliance',
                            'severity': 'critical' if viol_pct > 5 else 'warning',
                            'title': f'Four-eyes violations: {violations} case{"s" if violations != 1 else ""}',
                            'description': (
                                f'{violations} of {total} cases ({viol_pct:.1f}%) have the same resource performing both '
                                f'"{req_acts[0]}" and "{app_acts[0]}" — a segregation-of-duties break.'
                            ),
                            'metric_value': float(violations),
                            'recommendation': f'Enforce role separation in your workflow so the person requesting "{req_acts[0]}" cannot approve it. Each violation is an audit finding waiting to happen.',
                            'related_activities': [req_acts[0], app_acts[0]],
                        })
        except Exception:
            pass

        # ── 22. Concept drift (split-half comparison) ────────────────────────
        # Processes change over time — new variants appear, old ones die,
        # timing shifts. Split the log in half chronologically and compare
        # first-half vs second-half avg case duration. If the delta is
        # large it's worth flagging because most downstream analysis treats
        # the log as stationary.
        try:
            if len(case_durations) >= 40:
                case_starts = df.groupby(CASE_COL)[TIMESTAMP_COL].min().sort_values()
                midpoint = case_starts.iloc[len(case_starts) // 2]
                earlier = case_starts[case_starts <= midpoint].index
                later = case_starts[case_starts > midpoint].index
                if len(earlier) > 10 and len(later) > 10:
                    dur_early = float(case_durations.reindex(earlier).mean())
                    dur_late = float(case_durations.reindex(later).mean())
                    if dur_early > 0 and dur_late > 0:
                        drift = (dur_late - dur_early) / dur_early
                        if abs(drift) > 0.3:  # 30% shift
                            direction = 'slower' if drift > 0 else 'faster'
                            insights.append({
                                'category': 'drift',
                                'severity': 'warning' if abs(drift) > 0.5 else 'info',
                                'title': f'Process is getting {direction} over time',
                                'description': (
                                    f'The second half of the log averages {_fmt_dur(dur_late)} per case, '
                                    f'compared to {_fmt_dur(dur_early)} in the first half — a {abs(drift)*100:.0f}% shift.'
                                ),
                                'metric_value': drift,
                                'recommendation': 'Concept drift means the mining results mix two different process realities. Consider re-running the analyses on the later half only to see what the current process actually looks like.',
                            })
        except Exception:
            pass

        # ── 23. Data-quality timestamp problems ──────────────────────────────
        # Ties (multiple events at the same timestamp) and inversions
        # (earlier timestamp after a later one in the same case) corrupt
        # every downstream ordering. We report a quick count so users know
        # their log needs repair before trusting the mining output.
        try:
            ts = pd.to_datetime(df[TIMESTAMP_COL], errors='coerce')
            if ts.notna().sum() > 0:
                sorted_by_case = df.assign(_ts=ts).sort_values([CASE_COL, '_ts'])
                per_case_ts = sorted_by_case.groupby(CASE_COL)['_ts']
                # A "tie" within a case: two events at the same timestamp
                ties = int(per_case_ts.apply(lambda s: (s.diff() == pd.Timedelta(0)).sum()).sum())
                # Inversions shouldn't exist after sort; detect on the
                # ORIGINAL order instead (useful when the user uploaded
                # a log that isn't already sorted).
                original_order = df.assign(_ts=ts).groupby(CASE_COL)['_ts']
                inversions = int(original_order.apply(lambda s: (s.diff() < pd.Timedelta(0)).sum()).sum())
                if ties + inversions > 0 and (ties + inversions) / max(len(ts), 1) > 0.01:
                    pct = (ties + inversions) / max(len(ts), 1) * 100
                    insights.append({
                        'category': 'data_quality',
                        'severity': 'warning' if pct > 5 else 'info',
                        'title': f'Timestamp issues affect {pct:.1f}% of events',
                        'description': (
                            f'{ties:,} events share a timestamp with the previous event in the same case, '
                            f'and {inversions:,} events appear out of chronological order.'
                        ),
                        'metric_value': pct,
                        'recommendation': 'Run the timestamp-repair tool from the event log settings before trusting ordering-sensitive analyses (EFG, bottlenecks, temporal profile).',
                    })
        except Exception:
            pass

        # ── 24. Activity coverage by resource group ──────────────────────────
        # If a single resource group handles a wildly disproportionate
        # share of the total workload, that's a capacity risk.
        try:
            if RESOURCE_COL in df.columns and df[RESOURCE_COL].notna().sum() > 0:
                res_counts = df[RESOURCE_COL].value_counts()
                if len(res_counts) >= 3:
                    top_share = res_counts.iloc[0] / res_counts.sum() * 100
                    if top_share > 40:
                        insights.append({
                            'category': 'resource',
                            'severity': 'warning' if top_share > 60 else 'info',
                            'title': f'"{res_counts.index[0]}" handles {top_share:.0f}% of all events',
                            'description': (
                                f'Out of {len(res_counts)} resources, the top one is responsible for '
                                f'{int(res_counts.iloc[0]):,} of {int(res_counts.sum()):,} events.'
                            ),
                            'metric_value': top_share,
                            'recommendation': 'A single resource carrying most of the work is a single point of failure. Check whether this is a shared service account (normal) or a real person (capacity risk).',
                        })
        except Exception:
            pass

        # ── 25. Rare but slow variants (frequency-weighted impact) ───────────
        # A variant that only appears in 2% of cases but takes 10× longer
        # than the median drags the overall avg badly. Surface the worst
        # offender so it gets investigated.
        try:
            if variant_result:
                variants = variant_result.get('variants', [])
                if len(variants) >= 5:
                    median_dur = float(pd.Series([
                        v.get('avg_duration') or 0 for v in variants if v.get('avg_duration')
                    ]).median())
                    worst_rare = None
                    worst_score = 0.0
                    for v in variants:
                        pct = v.get('percentage', 0)
                        dur = v.get('avg_duration') or 0
                        if pct < 10 and dur > 0 and median_dur > 0 and dur / median_dur > 3:
                            # Score by total wasted time
                            score = v.get('case_count', 0) * (dur - median_dur)
                            if score > worst_score:
                                worst_score = score
                                worst_rare = v
                    if worst_rare:
                        ratio = (worst_rare.get('avg_duration') or 0) / max(median_dur, 1)
                        cc = worst_rare.get('case_count', 0)
                        insights.append({
                            'category': 'variant',
                            'severity': 'warning',
                            'title': f'Rare variant {ratio:.1f}x slower than the median',
                            'description': (
                                f'A variant covering only {worst_rare.get("percentage", 0):.1f}% of cases ({cc} cases) '
                                f'averages {_fmt_dur(worst_rare.get("avg_duration") or 0)} — '
                                f'{ratio:.1f}x the median variant.'
                            ),
                            'metric_value': ratio,
                            'recommendation': 'Rare-but-slow variants are usually exception-handling paths. Check whether they deserve their own SLA or can be eliminated by fixing the upstream trigger.',
                            'related_activities': (worst_rare.get('activities') or [])[:5],
                            'impact_estimate': f'Eliminating this variant would save ~{_fmt_dur(worst_score / max(cc, 1))} per affected case.',
                        })
        except Exception:
            pass

        # ── Sort & summarize ─────────────────────────────────────────────────
        severity_order = {'critical': 0, 'warning': 1, 'info': 2}
        insights.sort(key=lambda i: severity_order.get(i['severity'], 9))

        critical_count = sum(1 for i in insights if i['severity'] == 'critical')
        warning_count = sum(1 for i in insights if i['severity'] == 'warning')
        automation_count = sum(1 for i in insights if i['category'] == 'automation')
        root_cause_count = sum(1 for i in insights if i['category'] == 'root_cause')

        summary = f"Your process has {total_activities} activities across {total_cases:,} cases ({total_events:,} events)."
        if critical_count > 0:
            summary += f" We found {critical_count} critical issue{'s' if critical_count > 1 else ''}."
        if warning_count > 0:
            summary += f" {warning_count} warning{'s' if warning_count > 1 else ''} to review."
        if automation_count > 0:
            summary += f" {automation_count} automation opportunit{'ies' if automation_count > 1 else 'y'} identified."
        if root_cause_count > 0:
            summary += " Key root cause factor identified."
        if critical_count == 0 and warning_count == 0:
            summary += " No critical issues detected."

        return {'insights': insights, 'summary': summary}


# Module-level singleton instance
mining_engine = MiningEngine()
