"""Advanced / ML-based discovery: trace clustering, ILP miner, decision rules, digital-twin parameters, correlation mining, feature extraction."""

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


def cluster_log(df: pd.DataFrame, n_clusters: int = 3) -> dict:
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


def cluster_log_dbscan(df: pd.DataFrame, eps: float = 0.5, min_samples: int = 5) -> dict:
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


def run_discovery_ilp(df: pd.DataFrame) -> dict:
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


def discover_decision_rules(df: pd.DataFrame) -> dict:
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


def digital_twin_parameters(df: pd.DataFrame) -> dict:
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


def run_correlation_mining(df: pd.DataFrame) -> dict:
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


def get_features(df: pd.DataFrame) -> dict:
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
