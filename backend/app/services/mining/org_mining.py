"""Organisational mining: social network, SNA, org roles, staff assignment, four-eyes checks."""

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
    compute_handover_network as _rs_handover_network,
)

logger = logging.getLogger(__name__)


def get_social_network(df: pd.DataFrame) -> dict:
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

    # Rust fast path (~80-90x faster than the per-case Python loop on large logs)
    rs_result = _rs_handover_network(df)
    if rs_result is not None:
        return rs_result

    resource_event_count: dict[str, int] = {}
    handover_count: dict[tuple[str, str], int] = {}

    for _, group in df.groupby(CASE_COL, sort=False):
        # Stable sort so that events sharing a timestamp keep their original
        # (ingestion) order — makes handover counts deterministic and matches
        # the Rust fast path. Day-granularity logs (e.g. SAP P2P) have many
        # tied timestamps, where the default quicksort would vary run-to-run.
        group = group.sort_values(TIMESTAMP_COL, kind="mergesort")
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


def get_sna(df: pd.DataFrame, network_type: str = "handover") -> dict:
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


def get_org_roles(df: pd.DataFrame) -> dict:
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


def discover_staff_assignment(df: pd.DataFrame) -> dict:
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


def check_four_eyes(df: pd.DataFrame, activity1: str, activity2: str
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
