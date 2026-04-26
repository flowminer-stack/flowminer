"""Action engine: evaluate ActionRule conditions against an event log and dispatch actions."""

import logging
from datetime import datetime, timezone
from typing import Any

import pandas as pd

from app.services.ingestion import ACTIVITY_COL, CASE_COL, TIMESTAMP_COL

logger = logging.getLogger(__name__)

_OPERATORS = {
    "gt": lambda a, b: a > b,
    "gte": lambda a, b: a >= b,
    "lt": lambda a, b: a < b,
    "lte": lambda a, b: a <= b,
    "eq": lambda a, b: a == b,
    "neq": lambda a, b: a != b,
    "in": lambda a, b: a in b,
    "not_in": lambda a, b: a not in b,
}


def _case_snapshots(df: pd.DataFrame, now: pd.Timestamp | None = None) -> pd.DataFrame:
    """Reduce a log to one row per case with columns used by rule conditions."""
    if now is None:
        now = df[TIMESTAMP_COL].max()
    sorted_df = df.sort_values(TIMESTAMP_COL)
    grouped = sorted_df.groupby(CASE_COL)

    start = grouped[TIMESTAMP_COL].min()
    end = grouped[TIMESTAMP_COL].max()
    current_activity = grouped[ACTIVITY_COL].last()
    event_count = grouped.size()
    rework_count = grouped[ACTIVITY_COL].apply(lambda s: len(s) - s.nunique())

    case_duration = (end - start).dt.total_seconds()
    time_on_activity = (now - end).dt.total_seconds()

    snapshot = pd.DataFrame({
        "case_id": start.index.astype(str),
        "case_duration": case_duration.values,
        "time_on_activity": time_on_activity.values,
        "current_activity": current_activity.values,
        "event_count": event_count.values,
        "rework_count": rework_count.values,
        "start_time": start.values,
        "end_time": end.values,
    })
    return snapshot


def evaluate_rule(df: pd.DataFrame, condition: dict) -> list[dict]:
    """Return a list of case snapshots that match the condition."""
    if not condition:
        return []

    snap = _case_snapshots(df)

    metric = condition.get("metric")
    operator = condition.get("operator", "gt")
    value = condition.get("value")
    required_activity = condition.get("current_activity")

    op_fn = _OPERATORS.get(operator)
    if op_fn is None:
        return []

    if metric in ("case_duration", "time_on_activity", "event_count", "rework_count"):
        if metric not in snap.columns:
            return []
        try:
            mask = snap[metric].apply(lambda x: op_fn(x, value))
        except Exception:
            return []
        matched = snap[mask]
    elif metric == "current_activity":
        matched = snap[snap["current_activity"].apply(lambda a: op_fn(a, value))]
    else:
        return []

    if required_activity:
        matched = matched[matched["current_activity"] == required_activity]

    out = []
    for _, row in matched.iterrows():
        out.append({
            "case_id": row["case_id"],
            "case_duration": float(row["case_duration"]),
            "time_on_activity": float(row["time_on_activity"]),
            "current_activity": row["current_activity"],
            "rework_count": int(row["rework_count"]),
            "event_count": int(row["event_count"]),
        })
    return out


def dispatch_action(action: dict, case: dict) -> dict:
    """Execute a single action against a case. Returns an execution detail dict.

    Side effects are intentionally lightweight: email/webhook/task creation
    are logged as intents here; actual transport can be wired via Celery.
    """
    action_type = action.get("type")
    params = action.get("params", {}) or {}
    timestamp = datetime.now(timezone.utc).isoformat()

    if action_type == "notify_email":
        return {
            "action": "notify_email",
            "to": params.get("to"),
            "subject": params.get("subject", f"Action rule triggered for case {case['case_id']}"),
            "case_id": case["case_id"],
            "timestamp": timestamp,
        }
    if action_type == "notify_webhook":
        return {
            "action": "notify_webhook",
            "url": params.get("url"),
            "case_id": case["case_id"],
            "timestamp": timestamp,
        }
    if action_type == "create_task":
        return {
            "action": "create_task",
            "assignee": params.get("assignee"),
            "title": params.get("title", f"Review case {case['case_id']}"),
            "case_id": case["case_id"],
            "timestamp": timestamp,
        }
    if action_type == "tag_case":
        return {
            "action": "tag_case",
            "tag": params.get("tag", "flagged"),
            "case_id": case["case_id"],
            "timestamp": timestamp,
        }
    if action_type == "escalate":
        return {
            "action": "escalate",
            "level": params.get("level", "manager"),
            "case_id": case["case_id"],
            "timestamp": timestamp,
        }

    return {
        "action": action_type or "unknown",
        "case_id": case["case_id"],
        "timestamp": timestamp,
        "note": "No handler for this action type",
    }
