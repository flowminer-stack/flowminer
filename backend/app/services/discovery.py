"""
Process discovery service using pm4py high-level API (2.7+).
Supports DFG, Alpha Miner, Heuristic Miner, and Inductive Miner.
"""

import logging
from collections import defaultdict

import numpy as np
import pandas as pd
import pm4py

from app.services.rust_accel import (
    RUST_AVAILABLE,
    compute_activity_durations as _rs_activity_durations,
    compute_edge_durations as _rs_edge_durations,
    discover_dfg as _rs_discover_dfg,
    discover_petri_net_heuristics as _rs_discover_heuristics,
    discover_inductive_net as _rs_inductive_net,
)

logger = logging.getLogger(__name__)

# Standard pm4py column names
CASE_COL = "case:concept:name"
ACTIVITY_COL = "concept:name"
TIMESTAMP_COL = "time:timestamp"

PM4PY_KEYS = {
    "case_id_key": CASE_COL,
    "activity_key": ACTIVITY_COL,
    "timestamp_key": TIMESTAMP_COL,
}

# Performance color thresholds
COLOR_FAST = "#22c55e"   # green
COLOR_MEDIUM = "#eab308"  # yellow
COLOR_SLOW = "#ef4444"    # red


def _sanitize_id(name: str) -> str:
    return str(name).replace(" ", "_").replace("/", "_").replace("\\", "_").lower()


def _assign_performance_color(value: float, p25: float, p75: float) -> str:
    if value <= p25:
        return COLOR_FAST
    elif value <= p75:
        return COLOR_MEDIUM
    else:
        return COLOR_SLOW


class DiscoveryService:

    def _compute_activity_durations(self, df: pd.DataFrame) -> dict:
        if df.empty or TIMESTAMP_COL not in df.columns:
            return {}

        # Rust path: ~30-47x faster
        rs_result = _rs_activity_durations(df)
        if rs_result is not None:
            return rs_result

        result = defaultdict(list)

        sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL]).copy()
        sorted_df["_next_ts"] = sorted_df.groupby(CASE_COL)[TIMESTAMP_COL].shift(-1)
        sorted_df["_duration"] = (
            sorted_df["_next_ts"] - sorted_df[TIMESTAMP_COL]
        ).dt.total_seconds()

        valid = sorted_df.dropna(subset=["_duration"])

        for activity, group in valid.groupby(ACTIVITY_COL):
            durations = group["_duration"].tolist()
            result[activity] = {
                "avg": float(np.mean(durations)) if durations else 0.0,
                "median": float(np.median(durations)) if durations else 0.0,
            }

        return dict(result)

    def _compute_edge_durations(self, df: pd.DataFrame) -> dict:
        if df.empty or TIMESTAMP_COL not in df.columns:
            return {}

        # Rust path: ~400x faster than iterrows
        rs_result = _rs_edge_durations(df)
        if rs_result is not None:
            return rs_result

        # Python fallback
        result = defaultdict(list)
        sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL]).copy()
        sorted_df["_next_activity"] = sorted_df.groupby(CASE_COL)[ACTIVITY_COL].shift(-1)
        sorted_df["_next_ts"] = sorted_df.groupby(CASE_COL)[TIMESTAMP_COL].shift(-1)
        sorted_df["_duration"] = (
            sorted_df["_next_ts"] - sorted_df[TIMESTAMP_COL]
        ).dt.total_seconds()

        valid = sorted_df.dropna(subset=["_next_activity", "_duration"])

        for _, row in valid.iterrows():
            key = (str(row[ACTIVITY_COL]), str(row["_next_activity"]))
            result[key].append(row["_duration"])

        edge_stats = {}
        for key, durations in result.items():
            edge_stats[key] = {
                "avg": float(np.mean(durations)),
                "median": float(np.median(durations)),
            }

        return edge_stats

    def _get_start_end_activities(self, df: pd.DataFrame) -> tuple[dict, dict]:
        sa = pm4py.get_start_activities(df, **PM4PY_KEYS)
        ea = pm4py.get_end_activities(df, **PM4PY_KEYS)
        return sa, ea

    def _build_nodes(self, df, activity_counts, activity_durations, start_acts, end_acts):
        nodes = []
        for activity in sorted(activity_counts.keys()):
            freq = activity_counts.get(activity, 0)
            dur = activity_durations.get(activity, {})
            nodes.append({
                "id": _sanitize_id(activity),
                "label": str(activity),
                "frequency": int(freq),
                "avg_duration": dur.get("avg"),
                "median_duration": dur.get("median"),
                "is_start": activity in start_acts,
                "is_end": activity in end_acts,
            })
        return nodes

    def _build_edges(self, dfg_dict, edge_durations, p25, p75):
        edges = []
        for (source, target), freq in sorted(dfg_dict.items(), key=lambda x: x[1], reverse=True):
            edge_dur = edge_durations.get((source, target), {})
            avg_dur = edge_dur.get("avg")
            color = None
            if avg_dur is not None and avg_dur > 0:
                color = _assign_performance_color(avg_dur, p25, p75)
            edges.append({
                "source": _sanitize_id(source),
                "target": _sanitize_id(target),
                "frequency": int(freq),
                "avg_duration": avg_dur,
                "median_duration": edge_dur.get("median"),
                "performance_color": color,
            })
        return edges

    def _edge_percentiles(self, edge_durations):
        all_avgs = [v["avg"] for v in edge_durations.values() if v["avg"] > 0]
        if all_avgs:
            return float(np.percentile(all_avgs, 25)), float(np.percentile(all_avgs, 75))
        return 0.0, 0.0

    def discover_dfg(self, df: pd.DataFrame) -> dict:
        if df.empty:
            return {"nodes": [], "edges": [], "statistics": {}}

        try:
            dfg, start_activities, end_activities = _rs_discover_dfg(df)
            activity_counts = df[ACTIVITY_COL].value_counts().to_dict()
            activity_durations = self._compute_activity_durations(df)
            edge_durations = self._compute_edge_durations(df)
            p25, p75 = self._edge_percentiles(edge_durations)

            nodes = self._build_nodes(df, activity_counts, activity_durations, start_activities, end_activities)
            edges = self._build_edges(dfg, edge_durations, p25, p75)

            statistics = {
                "total_cases": int(df[CASE_COL].nunique()),
                "total_events": len(df),
                "total_activities": len(activity_counts),
                "total_edges": len(edges),
                "start_activities": list(start_activities.keys()),
                "end_activities": list(end_activities.keys()),
            }

            return {"nodes": nodes, "edges": edges, "statistics": statistics}

        except Exception as e:
            logger.error(f"Error in DFG discovery: {e}", exc_info=True)
            raise

    def discover_alpha(self, df: pd.DataFrame) -> dict:
        if df.empty:
            return {"nodes": [], "edges": [], "statistics": {}}

        try:
            net, im, fm = pm4py.discover_petri_net_alpha(df, **PM4PY_KEYS)
            return self._petri_net_to_dict(net, im, fm, df)
        except Exception as e:
            logger.error(f"Error in Alpha Miner discovery: {e}", exc_info=True)
            raise

    def _dict_to_petri_net(self, net_dict: dict):
        """Build a pm4py Petri net from the serialised dict the Rust
        Heuristic Miner returns (places / transitions / arcs / markings)."""
        from pm4py.objects.petri_net.obj import PetriNet, Marking

        net = PetriNet("heuristic_net")
        place_map = {}
        for pname in net_dict.get("places", []):
            place = PetriNet.Place(pname)
            net.places.add(place)
            place_map[pname] = place

        trans_map = {}
        for t in net_dict.get("transitions", []):
            label = t.get("label")
            transition = PetriNet.Transition(t["name"], label)
            net.transitions.add(transition)
            trans_map[t["name"]] = transition

        for arc in net_dict.get("arcs", []):
            src = place_map.get(arc["source"]) or trans_map.get(arc["source"])
            tgt = place_map.get(arc["target"]) or trans_map.get(arc["target"])
            if src is not None and tgt is not None:
                a = PetriNet.Arc(src, tgt)
                net.arcs.add(a)
                src.out_arcs.add(a)
                tgt.in_arcs.add(a)

        im = Marking()
        for pname in net_dict.get("initial_marking", []):
            if pname in place_map:
                im[place_map[pname]] = 1
        fm = Marking()
        for pname in net_dict.get("final_marking", []):
            if pname in place_map:
                fm[place_map[pname]] = 1
        return net, im, fm

    def _heuristic_net(self, df: pd.DataFrame, dependency_threshold: float = 0.5):
        """Discover a Heuristic-Miner Petri net, preferring the Rust path
        (~20x faster than pm4py on large logs) and falling back to pm4py.

        Used by the Split-Miner approximation, where the downstream frequency
        filter makes the result identical to the pm4py net (verified, edge
        Jaccard 1.0). ``discover_heuristic`` keeps the pm4py net directly so
        its *unfiltered* output stays faithful to pm4py's split/join
        semantics, which the simplified Rust net construction does not
        reproduce edge-for-edge.
        """
        rs_dict = _rs_discover_heuristics(df, dependency_threshold=dependency_threshold)
        if rs_dict is not None:
            return self._dict_to_petri_net(rs_dict)
        return pm4py.discover_petri_net_heuristics(
            df, dependency_threshold=dependency_threshold, **PM4PY_KEYS
        )

    def discover_heuristic(self, df: pd.DataFrame) -> dict:
        if df.empty:
            return {"nodes": [], "edges": [], "statistics": {}}

        try:
            net, im, fm = pm4py.discover_petri_net_heuristics(df, **PM4PY_KEYS)
            return self._petri_net_to_dict(net, im, fm, df)
        except Exception as e:
            logger.error(f"Error in Heuristic Miner discovery: {e}", exc_info=True)
            raise

    def discover_inductive(self, df: pd.DataFrame, parameters: dict = None) -> dict:
        if df.empty:
            return {"nodes": [], "edges": [], "statistics": {}}

        parameters = parameters or {}
        noise_threshold = float(parameters.get("threshold", 0.0))

        try:
            # noise_threshold > 0 activates IMf (Inductive Miner — filtering variant)
            if noise_threshold > 0:
                net, im, fm = pm4py.discover_petri_net_inductive(
                    df, noise_threshold=noise_threshold, **PM4PY_KEYS
                )
            else:
                # IM (noise_threshold == 0): prefer the Rust miner (~95x faster,
                # verified byte-identical tree → identical net), fall back to pm4py.
                rs_net = _rs_inductive_net(df)
                if rs_net is not None:
                    net, im, fm = rs_net
                else:
                    net, im, fm = pm4py.discover_petri_net_inductive(df, **PM4PY_KEYS)
            result = self._petri_net_to_dict(net, im, fm, df)
            if noise_threshold > 0:
                result.setdefault("statistics", {})["noise_threshold"] = noise_threshold
            return result
        except Exception as e:
            logger.error(f"Error in Inductive Miner discovery: {e}", exc_info=True)
            raise

    def _build_concurrency_matrix(self, df: pd.DataFrame, start_col: str) -> dict:
        """
        Build a concurrency matrix from start+end timestamp pairs.

        Two activities A and B are concurrent in a case when their execution
        intervals [start_A, end_A] and [start_B, end_B] overlap.

        References:
          Augusto et al. "Split Miner: automated discovery of accurate and simple
          business process models from event logs." KAIS 2019.
          Augusto et al. "Split Miner 2.0." 2022 (start/end timestamp variant).

        Returns:
            dict mapping frozenset({A, B}) -> {"co_occurring": int, "co_present": int}
        """
        pair_stats: dict = {}

        for case_id, grp in df.groupby(CASE_COL):
            grp = grp.reset_index(drop=True)
            activities = grp[ACTIVITY_COL].tolist()
            starts = grp[start_col].tolist()
            ends = grp[TIMESTAMP_COL].tolist()

            # Build per-activity interval lists for this case
            act_intervals: dict = defaultdict(list)
            for act, s, e in zip(activities, starts, ends):
                # Guard against inverted timestamps (start > end)
                s, e = (s, e) if s <= e else (e, s)
                act_intervals[str(act)].append((s, e))

            act_list = sorted(act_intervals.keys())
            for i, a in enumerate(act_list):
                for b in act_list[i + 1:]:
                    key = frozenset((a, b))
                    if key not in pair_stats:
                        pair_stats[key] = {"co_occurring": 0, "co_present": 0}
                    pair_stats[key]["co_present"] += 1
                    # Any interval of A overlaps any interval of B?
                    overlaps = any(
                        ia[0] < ib[1] and ib[0] < ia[1]
                        for ia in act_intervals[a]
                        for ib in act_intervals[b]
                    )
                    if overlaps:
                        pair_stats[key]["co_occurring"] += 1

        return pair_stats

    def discover_split_miner(self, df: pd.DataFrame, parameters: dict = None) -> dict:
        """
        Split-Miner-style discovery with timestamp-pair concurrency detection.

        When the event log contains start timestamps (columns: ``start_timestamp``
        or ``time:start``), uses the Split Miner 2.0 approach (Augusto et al.
        2022): builds a concurrency matrix from overlapping [start, end] intervals,
        labels edges as sequence / parallel / choice, and annotates nodes with
        their concurrent partners.

        Without start timestamps, falls back to the heuristic-net approximation
        (original behaviour).

        References:
          Augusto et al. "Split Miner: automated discovery of accurate and simple
          business process models from event logs." KAIS 2019.
          Augusto et al. "Split Miner 2.0." 2022.
        """
        if df.empty:
            return {"nodes": [], "edges": [], "statistics": {}}
        parameters = parameters or {}
        threshold = float(parameters.get("threshold", 0.2))
        # Concurrency ratio threshold: pairs with ratio > this are declared parallel.
        # 0.5 means "more than half of cases where both activities appear show overlap"
        # — a robust mid-point that avoids noise from occasional parallelism.
        concurrency_threshold = float(parameters.get("concurrency_threshold", 0.5))

        # ── Detect start-timestamp column ────────────────────────────────────
        start_col = None
        for candidate in ("start_timestamp", "time:start"):
            if candidate in df.columns:
                start_col = candidate
                break

        has_start_timestamps = start_col is not None

        if not has_start_timestamps:
            logger.warning(
                "discover_split_miner: no start-timestamp column found "
                "(looked for 'start_timestamp', 'time:start'). "
                "Falling back to heuristic-net approximation."
            )
            return self._split_miner_approx(df, threshold)

        # ── Split Miner v2: build concurrency matrix ─────────────────────────
        logger.info("discover_split_miner: start timestamps detected, using concurrency-matrix approach.")
        try:
            pair_stats = self._build_concurrency_matrix(df, start_col)
        except Exception as e:
            logger.error(f"Concurrency matrix build failed: {e}. Falling back to approx.", exc_info=True)
            return self._split_miner_approx(df, threshold)

        # Concurrent pairs: ratio > concurrency_threshold
        concurrent_pairs: list[tuple[str, str]] = []
        concurrent_set: set[frozenset] = set()
        for pair_key, counts in pair_stats.items():
            if counts["co_present"] == 0:
                continue
            ratio = counts["co_occurring"] / counts["co_present"]
            if ratio > concurrency_threshold:
                a, b = sorted(pair_key)
                concurrent_pairs.append((a, b))
                concurrent_set.add(pair_key)

        # ── Build DFG + annotate edges ───────────────────────────────────────
        try:
            dfg, start_activities, end_activities = _rs_discover_dfg(df)
        except Exception as e:
            logger.error(f"DFG build failed in split_miner_v2: {e}", exc_info=True)
            raise

        activity_counts = df[ACTIVITY_COL].value_counts().to_dict()
        activity_durations = self._compute_activity_durations(df)
        edge_durations = self._compute_edge_durations(df)
        p25, p75 = self._edge_percentiles(edge_durations)

        # Determine which pairs only alternate (never co-occur) → choice
        choice_set: set[frozenset] = set()
        for pair_key, counts in pair_stats.items():
            if counts["co_occurring"] == 0 and counts["co_present"] > 0:
                choice_set.add(pair_key)

        # Build nodes with concurrent_with annotation
        concurrent_with: dict[str, list[str]] = defaultdict(list)
        for a, b in concurrent_pairs:
            concurrent_with[a].append(b)
            concurrent_with[b].append(a)

        nodes = []
        for activity in sorted(activity_counts.keys()):
            freq = activity_counts.get(activity, 0)
            dur = activity_durations.get(activity, {})
            node: dict = {
                "id": _sanitize_id(activity),
                "label": str(activity),
                "frequency": int(freq),
                "avg_duration": dur.get("avg"),
                "median_duration": dur.get("median"),
                "is_start": activity in start_activities,
                "is_end": activity in end_activities,
                "concurrent_with": [_sanitize_id(x) for x in concurrent_with.get(activity, [])],
            }
            nodes.append(node)

        # Build edges with relation type
        max_freq = max(dfg.values()) if dfg else 1
        cutoff = max_freq * threshold
        edges = []
        used_nodes: set[str] = set()
        for (source, target), freq in sorted(dfg.items(), key=lambda x: x[1], reverse=True):
            if freq < cutoff:
                continue
            edge_dur = edge_durations.get((source, target), {})
            avg_dur = edge_dur.get("avg")
            color = None
            if avg_dur is not None and avg_dur > 0:
                color = _assign_performance_color(avg_dur, p25, p75)

            pair_key = frozenset((source, target))
            if pair_key in concurrent_set:
                relation = "parallel"
            elif pair_key in choice_set:
                relation = "choice"
            else:
                relation = "sequence"

            edges.append({
                "source": _sanitize_id(source),
                "target": _sanitize_id(target),
                "frequency": int(freq),
                "avg_duration": avg_dur,
                "median_duration": edge_dur.get("median"),
                "performance_color": color,
                "relation": relation,
            })
            used_nodes.add(_sanitize_id(source))
            used_nodes.add(_sanitize_id(target))

        # Prune disconnected nodes
        nodes = [n for n in nodes if n["id"] in used_nodes]

        statistics = {
            "total_cases": int(df[CASE_COL].nunique()),
            "total_events": len(df),
            "total_activities": len({n["id"] for n in nodes}),
            "total_edges": len(edges),
            "start_activities": list(start_activities.keys()),
            "end_activities": list(end_activities.keys()),
            "algorithm": "split_miner_v2",
            "threshold": threshold,
            "concurrency_threshold": concurrency_threshold,
            "has_start_timestamps": True,
            "concurrent_pairs": concurrent_pairs,
        }

        return {"nodes": nodes, "edges": edges, "statistics": statistics}

    def _split_miner_approx(self, df: pd.DataFrame, threshold: float) -> dict:
        """
        Heuristic-net approximation used as fallback when start timestamps
        are absent. Original Split Miner behaviour prior to v2 enhancement.
        """
        try:
            net, im, fm = self._heuristic_net(df, dependency_threshold=max(threshold, 0.5))
            result = self._petri_net_to_dict(net, im, fm, df)
        except Exception as e:
            logger.error(f"Split-Miner approximation failed: {e}", exc_info=True)
            raise

        # Post-filter: drop edges below threshold fraction of max, prune nodes
        edges = result.get("edges", [])
        if edges:
            max_freq = max(e.get("frequency", 0) for e in edges) or 1
            cutoff = max_freq * threshold
            filtered_edges = [e for e in edges if e.get("frequency", 0) >= cutoff]
            used_nodes = {e["source"] for e in filtered_edges} | {e["target"] for e in filtered_edges}
            result["edges"] = filtered_edges
            result["nodes"] = [n for n in result.get("nodes", []) if n.get("id") in used_nodes]
            result.setdefault("statistics", {})["algorithm"] = "split_miner_approx"
            result["statistics"]["threshold"] = threshold
            result["statistics"]["has_start_timestamps"] = False
            result["statistics"]["concurrent_pairs"] = []

        return result

    def discover(self, df: pd.DataFrame, algorithm: str = "dfg", parameters: dict = None) -> dict:
        parameters = parameters or {}
        dispatchers = {
            "dfg": lambda d: self.discover_dfg(d),
            "alpha": lambda d: self.discover_alpha(d),
            "heuristic": lambda d: self.discover_split_miner(d, parameters=parameters),
            "inductive": lambda d: self.discover_inductive(d, parameters=parameters),
            "split_miner": lambda d: self.discover_split_miner(d, parameters=parameters),
        }

        if algorithm not in dispatchers:
            raise ValueError(f"Unknown algorithm: '{algorithm}'. Supported: {list(dispatchers.keys())}")

        return dispatchers[algorithm](df)

    def _petri_net_to_dict(self, net, initial_marking, final_marking, df: pd.DataFrame) -> dict:
        """
        Convert a Petri net to a clean activity-only graph.
        Derives valid activity→activity connections from the Petri net structure
        by traversing through places (and silent/tau transitions), then uses
        the actual DFG frequencies for the edges that the model permits.
        """
        activity_counts = df[ACTIVITY_COL].value_counts().to_dict()
        activity_durations = self._compute_activity_durations(df)
        edge_durations = self._compute_edge_durations(df)
        start_acts, end_acts = self._get_start_end_activities(df)
        p25, p75 = self._edge_percentiles(edge_durations)

        # Full DFG for frequency data
        full_dfg, _, _ = _rs_discover_dfg(df)

        # Extract valid activity-to-activity edges from the Petri net structure.
        # In a Petri net: transition → place → transition.
        # We follow paths from labeled transitions through places (and silent
        # tau transitions) to find which labeled activities can follow each other.
        model_edges = set()
        labeled_transitions = {t for t in net.transitions if t.label is not None}

        # Build adjacency map once: node -> list of outgoing target nodes.
        # This avoids scanning all of net.arcs on every recursive call
        # (previously O(nodes × arcs); now O(arcs) build + O(nodes) per BFS).
        adj: dict = {}
        for arc in net.arcs:
            adj.setdefault(arc.source, []).append(arc.target)

        def _find_reachable_activities(start_node):
            """Iterative BFS from start_node through places and tau transitions
            to find the next reachable labeled (activity) transitions.

            NOTE: start_node is intentionally NOT pre-added to visited so that
            self-loop paths (start_node → place → start_node) are discovered —
            matching the behaviour of the original recursive implementation.
            The loop guard (visited.add before queue.extend) prevents infinite
            cycles for all intermediate nodes.
            """
            reachable = set()
            visited = set()
            queue = list(adj.get(start_node, []))
            while queue:
                node = queue.pop()
                if node in visited:
                    continue
                visited.add(node)
                if hasattr(node, 'label'):
                    # It's a transition
                    if node.label is not None:
                        reachable.add(node.label)
                    else:
                        # Silent/tau transition — keep traversing
                        queue.extend(adj.get(node, []))
                else:
                    # It's a place — keep traversing
                    queue.extend(adj.get(node, []))
            return reachable

        for trans in labeled_transitions:
            source_label = trans.label
            reachable = _find_reachable_activities(trans)
            for target_label in reachable:
                model_edges.add((source_label, target_label))

        # Build the filtered DFG: only edges the model permits, with real frequencies
        filtered_dfg = {}
        for (source, target) in model_edges:
            freq = full_dfg.get((source, target), 0)
            if freq > 0:
                filtered_dfg[(source, target)] = freq
            else:
                # The model says this edge is valid but it has 0 frequency in data
                # (can happen with generalized models). Include with freq=1 as structural edge.
                filtered_dfg[(source, target)] = 1

        # Activities present in the model
        model_activities = {t.label for t in labeled_transitions}
        model_activity_counts = {
            a: c for a, c in activity_counts.items() if a in model_activities
        }

        nodes = self._build_nodes(df, model_activity_counts, activity_durations, start_acts, end_acts)
        edges = self._build_edges(filtered_dfg, edge_durations, p25, p75)

        statistics = {
            "total_cases": int(df[CASE_COL].nunique()),
            "total_events": len(df),
            "total_activities": len(model_activity_counts),
            "total_edges": len(edges),
            "start_activities": [a for a in start_acts if a in model_activities],
            "end_activities": [a for a in end_acts if a in model_activities],
            "petri_net_transitions": len(net.transitions),
            "petri_net_places": len(net.places),
        }

        return {"nodes": nodes, "edges": edges, "statistics": statistics}
