"""
Rust-accelerated process mining functions.

Thin wrapper around the ``flowminer_accel`` PyO3 module. Each public
function accepts a pandas DataFrame (with standard pm4py column names)
and returns the same shape as its Python/pm4py equivalent.

If the Rust module is not installed, all functions fall back transparently
to the original Python implementations with a one-time warning.
"""

import logging

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

CASE_COL = "case:concept:name"
ACTIVITY_COL = "concept:name"
TIMESTAMP_COL = "time:timestamp"

# ── try to load the native module ────────────────────────────────────

try:
    import flowminer_accel as _rs  # type: ignore[import-not-found]

    RUST_AVAILABLE = True
    logger.info("flowminer_accel Rust module loaded — accelerated algorithms active")
except ImportError:
    _rs = None  # type: ignore[assignment]
    RUST_AVAILABLE = False
    logger.info("flowminer_accel not installed — using pure-Python fallbacks")


# ── internal: categorical encoding ───────────────────────────────────

def _encode(df: pd.DataFrame) -> dict:
    """Categorically encode a DataFrame for the Rust functions.

    Returns a dict with numpy arrays ready to pass straight into the
    Rust module: int32 case/activity codes, the activity label list,
    and int64 nanosecond timestamps.
    """
    case_cat = df[CASE_COL].astype("category")
    act_cat = df[ACTIVITY_COL].astype("category")

    # Normalise timestamps to nanoseconds regardless of pandas version.
    # pandas ≥ 2.0 may use datetime64[us] → .astype(int64) gives µs.
    raw_ts = df[TIMESTAMP_COL].astype(np.int64).values
    dtype_str = str(df[TIMESTAMP_COL].dtype)
    if "us" in dtype_str:
        raw_ts = raw_ts * 1_000
    elif "ms" in dtype_str:
        raw_ts = raw_ts * 1_000_000
    # else: already nanoseconds (pandas < 2.0 default)

    return {
        "case_codes": case_cat.cat.codes.values.astype(np.int32),
        "act_codes": act_cat.cat.codes.values.astype(np.int32),
        "act_labels": act_cat.cat.categories.tolist(),
        "ts_ns": raw_ts,
    }


# ── public API ───────────────────────────────────────────────────────

def discover_dfg(df: pd.DataFrame):
    """Discover a Directly-Follows Graph.

    Returns ``(dfg_dict, start_activities, end_activities)`` — same
    shape as ``pm4py.discover_dfg()``.
    """
    if not RUST_AVAILABLE:
        import pm4py
        return pm4py.discover_dfg(
            df, case_id_key=CASE_COL, activity_key=ACTIVITY_COL,
            timestamp_key=TIMESTAMP_COL,
        )
    p = _encode(df)
    return _rs.discover_dfg(p["case_codes"], p["act_codes"], p["act_labels"], p["ts_ns"])


def discover_performance_dfg(df: pd.DataFrame):
    """Performance DFG with per-edge mean durations.

    Returns ``(perf_dfg, start_activities, end_activities)`` — same
    shape as ``pm4py.discover_performance_dfg()``.
    """
    if not RUST_AVAILABLE:
        import pm4py
        return pm4py.discover_performance_dfg(
            df, case_id_key=CASE_COL, activity_key=ACTIVITY_COL,
            timestamp_key=TIMESTAMP_COL,
        )
    p = _encode(df)
    return _rs.discover_performance_dfg(
        p["case_codes"], p["act_codes"], p["act_labels"], p["ts_ns"],
    )


def analyze_variants(df: pd.DataFrame) -> list:
    """Group traces into variants with frequency/duration stats.

    Returns a list of dicts sorted by descending frequency.  Each dict
    has: activities, frequency, percentage, avg_duration, min_duration,
    max_duration, id.
    """
    if not RUST_AVAILABLE:
        return None  # caller should use the Python implementation
    p = _encode(df)
    return list(_rs.analyze_variants(
        p["case_codes"], p["act_codes"], p["act_labels"], p["ts_ns"],
    ))


def compute_edge_durations(df: pd.DataFrame) -> dict:
    """Per-edge avg + median durations (seconds).

    Returns ``dict[(str,str) → {"avg": float, "median": float}]``.
    """
    if not RUST_AVAILABLE:
        return None  # caller should use the Python implementation
    p = _encode(df)
    return dict(_rs.compute_edge_durations(
        p["case_codes"], p["act_codes"], p["act_labels"], p["ts_ns"],
    ))


def compute_efg(df: pd.DataFrame) -> dict:
    """Eventually-Follows Graph with pair counts.

    Returns ``dict[(str,str) → int]``.
    """
    if not RUST_AVAILABLE:
        return None  # caller should use the Python implementation
    p = _encode(df)
    return dict(_rs.compute_efg(
        p["case_codes"], p["act_codes"], p["act_labels"], p["ts_ns"],
    ))


def token_replay_fitness(
    df: pd.DataFrame, net, initial_marking, final_marking,
) -> dict | None:
    """Token-based replay fitness with silent transition support.

    Accepts a pm4py Petri net.  Returns a dict with
    ``average_trace_fitness``, ``conformant_cases``, ``total_cases``,
    ``per_trace`` — same keys as ``pm4py.fitness_token_based_replay()``.

    Returns ``None`` if Rust is unavailable (caller falls back to pm4py).
    """
    if not RUST_AVAILABLE:
        return None

    # Build trace list
    traces = []
    for _, group in df.sort_values(
        [CASE_COL, TIMESTAMP_COL]
    ).groupby(CASE_COL, sort=False):
        traces.append(group[ACTIVITY_COL].tolist())

    # Serialise Petri net
    place_list = list(net.places)
    place_idx = {p: i for i, p in enumerate(place_list)}
    transitions_serial = []
    for t in net.transitions:
        label = t.label if t.label else ""
        inp = [place_idx[a.source] for a in t.in_arcs]
        out = [place_idx[a.target] for a in t.out_arcs]
        transitions_serial.append((label, inp, out))

    im_places = [place_idx[p] for p in initial_marking]
    fm_places = [place_idx[p] for p in final_marking]
    n_places = len(place_list)

    return _rs.token_replay_fitness(
        traces, transitions_serial, n_places, im_places, fm_places,
    )


def _serialise_net(net, initial_marking, final_marking):
    """Serialise a pm4py Petri net into the format Rust expects."""
    place_list = list(net.places)
    place_idx = {p: i for i, p in enumerate(place_list)}
    transitions_serial = []
    for t in net.transitions:
        label = t.label if t.label else ""
        inp = [place_idx[a.source] for a in t.in_arcs]
        out = [place_idx[a.target] for a in t.out_arcs]
        transitions_serial.append((label, inp, out))
    im_places = [place_idx[p] for p in initial_marking]
    fm_places = [place_idx[p] for p in final_marking]
    return transitions_serial, len(place_list), im_places, fm_places


def compute_activity_durations(df: pd.DataFrame) -> dict | None:
    """Per-activity avg + median duration to next event (seconds).

    Returns ``dict[str → {"avg": float, "median": float}]`` or ``None``
    if Rust is unavailable.
    """
    if not RUST_AVAILABLE:
        return None
    p = _encode(df)
    return dict(_rs.compute_activity_durations(
        p["case_codes"], p["act_codes"], p["act_labels"], p["ts_ns"],
    ))


def compute_precision_etc(
    df: pd.DataFrame, net, initial_marking, final_marking,
) -> float | None:
    """ETC precision (Muñoz-Gama & Carmona) via Rust.

    Returns a float in [0, 1] or ``None`` if Rust is unavailable.
    ~600-1200x faster than pm4py on typical logs.
    """
    if not RUST_AVAILABLE:
        return None

    traces = []
    for _, group in df.sort_values(
        [CASE_COL, TIMESTAMP_COL]
    ).groupby(CASE_COL, sort=False):
        traces.append(group[ACTIVITY_COL].tolist())

    trans_serial, n_places, im_p, fm_p = _serialise_net(
        net, initial_marking, final_marking,
    )
    return _rs.compute_precision_etc(traces, trans_serial, n_places, im_p, fm_p)


def discover_petri_net_heuristics(
    df: pd.DataFrame, dependency_threshold: float = 0.5,
) -> dict | None:
    """Heuristic Miner returning a serialised Petri net dict.

    Returns a dict with places, transitions, arcs, initial_marking,
    final_marking — or ``None`` if Rust is unavailable.
    """
    if not RUST_AVAILABLE:
        return None
    p = _encode(df)
    return _rs.discover_petri_net_heuristics(
        p["case_codes"], p["act_codes"], p["act_labels"], p["ts_ns"],
        dependency_threshold,
    )


def compute_temporal_profile(df: pd.DataFrame) -> dict | None:
    """Temporal profile: mean/stdev per eventually-follows pair + deviations.

    Returns dict with "profiles" and "deviations" lists, or ``None``
    if Rust is unavailable.
    """
    if not RUST_AVAILABLE:
        return None
    p = _encode(df)
    result = _rs.compute_temporal_profile(
        p["case_codes"], p["act_codes"], p["act_labels"], p["ts_ns"],
    )
    return {"profiles": list(result["profiles"]), "deviations": list(result["deviations"])}


def compute_bottlenecks(df: pd.DataFrame) -> dict | None:
    """Bottleneck analysis: activity stats + waiting times.

    Returns dict with "bottlenecks" and "waiting_times" lists, or
    ``None`` if Rust is unavailable.
    """
    if not RUST_AVAILABLE:
        return None
    p = _encode(df)
    result = _rs.compute_bottlenecks(
        p["case_codes"], p["act_codes"], p["act_labels"], p["ts_ns"],
    )
    return {"bottlenecks": list(result["bottlenecks"]),
            "waiting_times": list(result["waiting_times"])}


def compute_sna(df: pd.DataFrame, network_type: str = "handover") -> dict | None:
    """Social network analysis matrix.

    Returns dict with "resources", "matrix", "network_type" or ``None``
    if Rust is unavailable or no resource column present.
    """
    if not RUST_AVAILABLE:
        return None
    resource_col = "org:resource"
    if resource_col not in df.columns:
        return None
    p = _encode(df)
    res_cat = df[resource_col].astype("category")
    res_codes = res_cat.cat.codes.values.astype(np.int32)
    res_labels = res_cat.cat.categories.tolist()
    result = _rs.compute_sna(
        p["case_codes"], p["act_codes"], res_codes, res_labels,
        p["ts_ns"], network_type,
    )
    return {"resources": list(result["resources"]),
            "matrix": [list(row) for row in result["matrix"]],
            "network_type": result["network_type"]}


def compute_rework(df: pd.DataFrame) -> dict | None:
    """Detect rework (repeated activities) and self-loops.

    Returns dict with activities, self_loops, overall_rework_rate, etc.
    or ``None`` if Rust is unavailable.
    """
    if not RUST_AVAILABLE:
        return None
    p = _encode(df)
    result = _rs.compute_rework(
        p["case_codes"], p["act_codes"], p["act_labels"], p["ts_ns"],
    )
    return {"activities": list(result["activities"]),
            "self_loops": list(result["self_loops"]),
            "overall_rework_rate": float(result["overall_rework_rate"]),
            "cases_with_rework": int(result["cases_with_rework"]),
            "total_cases": int(result["total_cases"])}


def compute_edge_stats(
    df: pd.DataFrame, source: str, target: str, bins: int = 20,
) -> dict | None:
    """Edge transition stats with histogram and EF fallback.

    Returns the same shape as ``MiningEngine.get_edge_stats()`` or
    ``None`` if Rust is unavailable.
    """
    if not RUST_AVAILABLE:
        return None
    p = _encode(df)
    return dict(_rs.compute_edge_stats(
        p["case_codes"], p["act_codes"], p["act_labels"], p["ts_ns"],
        source, target, bins,
    ))


def compute_case_overlap(df: pd.DataFrame) -> dict | None:
    """Case overlap via interval intersection counting.

    Returns dict with "overlaps", "max_overlap", "avg_overlap"
    or ``None`` if Rust is unavailable.
    """
    if not RUST_AVAILABLE:
        return None
    p = _encode(df)
    result = _rs.compute_case_overlap(p["case_codes"], p["ts_ns"])
    return {"overlaps": list(result["overlaps"]),
            "max_overlap": int(result["max_overlap"]),
            "avg_overlap": float(result["avg_overlap"])}


def compute_generalization(
    df: pd.DataFrame, net, initial_marking, final_marking,
) -> float | None:
    """Generalization metric via Rust token replay.

    Returns a float in [0, 1] or ``None`` if Rust is unavailable.
    """
    if not RUST_AVAILABLE:
        return None
    traces = []
    for _, group in df.sort_values(
        [CASE_COL, TIMESTAMP_COL]
    ).groupby(CASE_COL, sort=False):
        traces.append(group[ACTIVITY_COL].tolist())
    trans_serial, n_places, im_p, fm_p = _serialise_net(
        net, initial_marking, final_marking,
    )
    return _rs.compute_generalization(traces, trans_serial, n_places, im_p, fm_p)


def compute_case_durations(df: pd.DataFrame) -> dict | None:
    """Fast case duration computation (seconds).

    Returns dict mapping case_code (int) → duration_seconds (float),
    or ``None`` if Rust is unavailable.
    """
    if not RUST_AVAILABLE:
        return None
    p = _encode(df)
    return dict(_rs.compute_case_durations(p["case_codes"], p["ts_ns"]))


def compute_handover_network(df: pd.DataFrame) -> dict | None:
    """Resource handover-of-work network with raw counts.

    Returns the same shape as ``org_mining.get_social_network()`` —
    ``{"nodes", "edges", "total_resources", "total_handovers"}`` — or
    ``None`` if Rust is unavailable or no resource column is present.
    """
    if not RUST_AVAILABLE:
        return None
    resource_col = "org:resource"
    if resource_col not in df.columns:
        return None
    # NaT timestamps encode to a sentinel that mis-orders events; the pandas
    # path sorts NaT last. Defer to it so handover ordering stays consistent.
    if df[TIMESTAMP_COL].isna().any():
        return None
    p = _encode(df)
    res_cat = df[resource_col].astype("category")
    res_codes = res_cat.cat.codes.values.astype(np.int32)  # -1 for NaN
    res_labels = res_cat.cat.categories.tolist()
    result = _rs.compute_handover_network(
        p["case_codes"], res_codes, res_labels, p["ts_ns"],
    )
    return {
        "nodes": list(result["nodes"]),
        "edges": list(result["edges"]),
        "total_resources": int(result["total_resources"]),
        "total_handovers": int(result["total_handovers"]),
    }


def compute_log_statistics(df: pd.DataFrame) -> dict | None:
    """Single-pass whole-log statistics primitives.

    Returns the heavy per-case reductions (start/end activity counts,
    activity frequencies, case-duration stats, per-case start timestamps)
    that ``StatisticsService`` shapes into the final response, or ``None``
    if Rust is unavailable.
    """
    if not RUST_AVAILABLE:
        return None
    # Null activities encode to category code -1, which would index out of
    # bounds in the native function; NaT timestamps encode to a sentinel that
    # overflows the duration math. The pandas path handles both (dropna /
    # groupby skips NaT), so defer to it rather than guess — these are rare.
    if df[TIMESTAMP_COL].isna().any():
        return None
    p = _encode(df)
    if (p["act_codes"] < 0).any():
        return None
    result = _rs.compute_log_statistics(
        p["case_codes"], p["act_codes"], p["act_labels"], p["ts_ns"],
    )
    return {
        "start_activities": dict(result["start_activities"]),
        "end_activities": dict(result["end_activities"]),
        "activity_frequencies": dict(result["activity_frequencies"]),
        "case_count": int(result["case_count"]),
        "event_count": int(result["event_count"]),
        "duration_avg": float(result["duration_avg"]),
        "duration_median": float(result["duration_median"]),
        "duration_min": float(result["duration_min"]),
        "duration_max": float(result["duration_max"]),
        "avg_events_per_case": float(result["avg_events_per_case"]),
        "case_start_ts": list(result["case_start_ts"]),
    }


def compute_prefix_features(df: pd.DataFrame):
    """Per-(case, prefix-length) feature rows for predictive monitoring.

    Drop-in for ``predictive._extract_prefix_features``: returns
    ``(feats_df, sorted_activities)`` with the same columns, or ``None`` if
    Rust is unavailable. One native pass replaces the Python triple loop +
    ~1.3M-dict materialisation; the DataFrame is built from columnar numpy
    arrays so there are no per-row Python objects.
    """
    if not RUST_AVAILABLE:
        return None
    case_cat = df[CASE_COL].astype("category")
    p = _encode(df)
    r = _rs.compute_prefix_features(p["case_codes"], p["act_codes"], p["ts_ns"])
    act_index = pd.Index(p["act_labels"])
    feats = pd.DataFrame({
        "case_id": pd.Categorical.from_codes(
            np.asarray(r["case_code"]), categories=case_cat.cat.categories
        ).astype(str),
        "prefix_length": np.asarray(r["prefix_length"]),
        "elapsed_seconds": np.asarray(r["elapsed_seconds"]),
        "remaining_seconds": np.asarray(r["remaining_seconds"]),
        "total_seconds": np.asarray(r["total_seconds"]),
        "unique_activities_so_far": np.asarray(r["unique_activities_so_far"]),
        "rework_count": np.asarray(r["rework_count"]),
        "hour_of_day": np.asarray(r["hour_of_day"]),
        "day_of_week": np.asarray(r["day_of_week"]),
        "last_activity": pd.Categorical.from_codes(
            np.asarray(r["last_act_code"]), categories=act_index
        ).astype(str),
        "is_last_prefix": np.asarray(r["is_last_prefix"]),
    })
    activities = sorted(str(p["act_labels"][c]) for c in r["present_acts"])
    return feats, activities


def compute_batches(df: pd.DataFrame, merge_distance: int = 15 * 60,
                    min_batch_size: int = 2):
    """Batch detection (Martin et al. 2015) in Rust, for single-timestamp logs.

    Returns a list of batch dicts (activity, resource, batch_type, num_cases,
    num_events, case_codes, start_ns, end_ns) or ``None`` if Rust is
    unavailable / no resource column. Faithful to pm4py's ``discover_batches``
    detection for logs where start == complete timestamp (the FlowMiner case).
    """
    if not RUST_AVAILABLE:
        return None
    resource_col = "org:resource"
    if resource_col not in df.columns:
        return None
    p = _encode(df)
    res_cat = df[resource_col].astype("category")
    res_codes = res_cat.cat.codes.values.astype(np.int32)  # -1 for NaN
    res_labels = res_cat.cat.categories.tolist()
    batches = list(_rs.compute_batches(
        p["case_codes"], p["act_codes"], p["act_labels"],
        res_codes, res_labels, p["ts_ns"],
        float(merge_distance), int(min_batch_size),
    ))
    # map case codes back to labels
    case_cats = df[CASE_COL].astype("category").cat.categories
    for b in batches:
        b["case_ids"] = [str(case_cats[c]) for c in b.pop("case_codes")]
    return batches


def discover_inductive_tree(df: pd.DataFrame):
    """Inductive-Miner process tree (pm4py IM / UVCL semantics), in Rust.

    Returns the process tree as nested Python objects — an activity leaf is its
    label (str), a tau leaf is ``None``, and an operator node is
    ``(symbol, [children])`` with symbol in ``{"->", "X", "+", "*"}`` — or
    ``None`` if Rust is unavailable.

    Verified language-equivalent (pm4py ``structurally_language_equal``) AND
    byte-identical (canonical string after fold+tree_sort) to
    ``pm4py.discover_process_tree_inductive`` on all bundled logs, ~95x faster
    on BPIC2019. See ``scripts/verify_inductive.py``.
    """
    if not RUST_AVAILABLE:
        return None
    p = _encode(df)
    return _rs.discover_inductive_tree(
        p["case_codes"], p["act_codes"], p["act_labels"], p["ts_ns"],
    )


def discover_inductive_net(df: pd.DataFrame):
    """Inductive-Miner Petri net via the Rust IM, or ``None`` if unavailable.

    Builds the IM process tree in Rust, then runs pm4py's OWN
    ``fold`` → ``tree_sort`` → ``convert_to_petri_net`` pipeline (the exact
    steps ``pm4py.discover_petri_net_inductive`` performs after discovering the
    tree). Because the Rust tree is byte-identical to pm4py's, the resulting
    ``(net, initial_marking, final_marking)`` matches pm4py's — only the
    (43s → 0.45s on BPIC2019) tree-discovery step is replaced. IM semantics
    only (noise_threshold == 0); callers keep pm4py for the IMf path.
    """
    if not RUST_AVAILABLE:
        return None
    raw = discover_inductive_tree(df)
    if raw is None:
        return None
    import pm4py
    from pm4py.objects.process_tree.obj import Operator, ProcessTree
    from pm4py.objects.process_tree.utils.generic import fold, tree_sort

    ops = {"->": Operator.SEQUENCE, "X": Operator.XOR, "+": Operator.PARALLEL, "*": Operator.LOOP}

    def _build(node):
        if node is None:
            return ProcessTree()  # tau / silent
        if isinstance(node, str):
            return ProcessTree(label=node)
        sym, children = node
        t = ProcessTree(operator=ops[sym])
        for c in children:
            ch = _build(c)
            ch.parent = t
            t.children.append(ch)
        return t

    tree = fold(_build(raw))
    tree_sort(tree)
    return pm4py.convert_to_petri_net(tree)


def parse_xes(file_path: str) -> pd.DataFrame | None:
    """Parse a XES file using Rust's quick-xml.

    Returns a DataFrame with case_id, activity, timestamp columns,
    or ``None`` if Rust is unavailable.
    """
    if not RUST_AVAILABLE:
        return None
    with open(file_path, "rb") as f:
        raw = f.read()
    result = _rs.parse_xes(raw)
    if not result["case_ids"]:
        return None
    return pd.DataFrame({
        "case:concept:name": result["case_ids"],
        "concept:name": result["activities"],
        "time:timestamp": pd.to_datetime(result["timestamps"], utc=True),
    })
