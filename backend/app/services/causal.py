"""Causal execution-dependency discovery for event logs.

Implements the approach from Fournier, Limonad, Skarbovsky & David (KI
journal 2025, arXiv:2310.14975) — runs a LiNGAM causal discovery
algorithm over per-case activity durations to produce a DAG of true
cause-effect dependencies between activities. The result overlays the
standard mined process map with a *"why"* answer: if activity A causes
activity B to be delayed, that edge surfaces even when it doesn't appear
in the discovered control-flow.

This is the open-ended "WHY in business processes" feature nobody in
the commercial market ships. The implementation depends on the
``lingam`` Python library (pip installable, MIT licensed).
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any

import pandas as pd
import numpy as np

logger = logging.getLogger(__name__)

CASE_COL = "case:concept:name"
ACTIVITY_COL = "concept:name"
TIMESTAMP_COL = "time:timestamp"


def _build_duration_matrix(df: pd.DataFrame, top_k: int = 20) -> tuple[pd.DataFrame, list[str]]:
    """Build a case × activity matrix of per-activity dwell times.

    Each cell is the total seconds the case spent in that activity
    (summed across visits). Absent activities get 0. We cap the activity
    set to the ``top_k`` most frequent to keep LiNGAM tractable — causal
    discovery is O(n³) in the number of variables.
    """
    if df.empty:
        return pd.DataFrame(), []

    # Pick the top-k activities by frequency
    activity_counts = df[ACTIVITY_COL].value_counts()
    top_activities = activity_counts.head(top_k).index.tolist()
    top_set = set(top_activities)

    # For each case, compute duration per activity as (sum of gaps between
    # start-of-activity and start-of-next-event). If the case has only one
    # event of a given activity and no "next" event, fall back to zero —
    # LiNGAM handles zero-columns gracefully after scaling.
    rows: dict[str, dict[str, float]] = defaultdict(dict)
    for case_id, group in df.groupby(CASE_COL):
        g = group.sort_values(TIMESTAMP_COL).reset_index(drop=True)
        for i in range(len(g)):
            act = str(g.iloc[i][ACTIVITY_COL])
            if act not in top_set:
                continue
            if i + 1 < len(g):
                try:
                    dt = (g.iloc[i + 1][TIMESTAMP_COL] - g.iloc[i][TIMESTAMP_COL]).total_seconds()
                except Exception:
                    dt = 0.0
            else:
                dt = 0.0
            rows[str(case_id)][act] = rows[str(case_id)].get(act, 0.0) + max(0.0, dt)

    matrix = pd.DataFrame.from_dict(rows, orient="index").fillna(0.0)
    # Ensure a stable column order (matches `top_activities`)
    matrix = matrix.reindex(columns=top_activities, fill_value=0.0)
    return matrix, top_activities


def discover_causal_dag(df: pd.DataFrame, top_k: int = 20, threshold: float = 0.1) -> dict[str, Any]:
    """Discover a causal DAG of activity dwell-time dependencies.

    Returns a dict with ``nodes``, ``edges``, and ``method``. Each edge
    has ``source``, ``target``, and ``weight`` (the standardized LiNGAM
    coefficient — positive = source increases target duration).

    Falls back to a simple Pearson-correlation graph if ``lingam`` is
    not installed, so the feature still works without the optional dep.
    """
    matrix, activities = _build_duration_matrix(df, top_k=top_k)
    if matrix.empty or len(activities) < 2:
        return {"nodes": [], "edges": [], "method": "empty"}

    # Standardize columns — LiNGAM is scale-sensitive
    stddev = matrix.std(ddof=0).replace(0.0, 1.0)
    standardized = (matrix - matrix.mean()) / stddev

    # Drop columns that are all-zero after standardization (constants
    # break DirectLiNGAM's FastICA step).
    nonzero_cols = standardized.columns[standardized.std(ddof=0) > 1e-9].tolist()
    if len(nonzero_cols) < 2:
        return {"nodes": activities, "edges": [], "method": "insufficient_variance"}
    standardized = standardized[nonzero_cols]

    try:
        from lingam import DirectLiNGAM  # type: ignore
    except Exception as e:
        logger.warning(
            "lingam not available (%s), falling back to Pearson correlation graph",
            e,
        )
        return _correlation_fallback(standardized, threshold)

    try:
        model = DirectLiNGAM()
        model.fit(standardized.values)
        adjacency = model.adjacency_matrix_  # shape (n, n), adj[i][j] = effect of j on i
    except Exception as e:
        logger.warning("DirectLiNGAM fit failed (%s), falling back to correlation", e)
        return _correlation_fallback(standardized, threshold)

    edges = []
    cols = standardized.columns.tolist()
    for i, target in enumerate(cols):
        for j, source in enumerate(cols):
            if i == j:
                continue
            weight = float(adjacency[i][j])
            if abs(weight) < threshold:
                continue
            edges.append({
                "source": source,
                "target": target,
                "weight": round(weight, 4),
                "direction": "positive" if weight > 0 else "negative",
            })

    # Sort by absolute effect so the UI can surface the strongest ones first
    edges.sort(key=lambda e: -abs(e["weight"]))

    return {
        "nodes": activities,
        "edges": edges[:200],
        "method": "direct_lingam",
        "sample_size": int(len(matrix)),
    }


def _correlation_fallback(standardized: pd.DataFrame, threshold: float) -> dict[str, Any]:
    """Correlation-based fallback when LiNGAM is unavailable.

    Returns an undirected-ish graph as a list of directed edges (a↔b
    becomes two entries) so the frontend renderer stays the same. This
    is strictly weaker than a real causal DAG — it cannot distinguish
    "A causes B" from "B causes A" — but it keeps the endpoint useful
    in environments that can't install the lingam dep.
    """
    corr = standardized.corr(method="pearson").fillna(0.0)
    edges = []
    cols = corr.columns.tolist()
    for i, a in enumerate(cols):
        for j, b in enumerate(cols):
            if i >= j:
                continue
            r = float(corr.iloc[i, j])
            if abs(r) < threshold:
                continue
            edges.append({
                "source": a,
                "target": b,
                "weight": round(r, 4),
                "direction": "positive" if r > 0 else "negative",
            })
    edges.sort(key=lambda e: -abs(e["weight"]))
    return {
        "nodes": cols,
        "edges": edges[:200],
        "method": "pearson_correlation",
        "sample_size": int(len(standardized)),
    }
