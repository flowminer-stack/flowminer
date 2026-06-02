"""Action engine: evaluate ActionRule conditions against an event log and dispatch actions."""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

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


# ---------------------------------------------------------------------------
# Duck-typed adapter so the existing Notifier transports can be reused for
# action-rule notifications without touching the Notifier class itself.
#
# The Notifier private methods read several Alert attributes *before* their
# try-blocks, so the adapter must supply all of them or the call raises an
# AttributeError that gets swallowed and recorded as a silent failure:
#   _send_email   reads .id, .email_recipients, .name, .metric,
#                 .condition, .threshold (body is built before the SMTP try)
#   _send_webhook reads .id, .webhook_url, .name, .metric,
#                 .condition, .threshold (payload built before the POST try)
#   _send_slack   reads .id, .webhook_url, .name
#   _send_teams   reads .id, .webhook_url, .name + getattr(metric/threshold)
# We expose the full superset so every transport works regardless of channel.
# ---------------------------------------------------------------------------

class _NotifyAdapter:
    """Minimal stub that satisfies Notifier's internal method contracts."""

    def __init__(
        self,
        *,
        adapter_id: str,
        name: str,
        email_recipients: list[str],
        webhook_url: str | None,
        metric: str = "",
        condition: str = "",
        threshold: Any = "",
    ) -> None:
        self.id = adapter_id
        self.name = name
        self.email_recipients = email_recipients
        self.webhook_url = webhook_url
        # Read by _send_email (body) and _send_webhook (payload) before their
        # try-blocks. Sourced from the rule's condition context when available,
        # otherwise sensible empty defaults so the transports never raise.
        self.metric = metric
        self.condition = condition
        self.threshold = threshold


def _build_notifier_result(case: dict, subject: str | None = None) -> dict:
    """Build the evaluation_result dict that Notifier methods expect."""
    return {
        "triggered": True,
        "current_value": float(case.get("case_duration", 0)),
        "message": (
            subject
            or f"Action rule triggered for case {case['case_id']}"
        ),
    }


def _notify_context(params: dict, case: dict) -> dict:
    """Resolve the metric / condition / threshold attributes the Notifier
    transports read while building the email body and webhook payload.

    These describe the rule that triggered the action. They are taken from
    the action ``params`` (which carry the rule/condition context) when
    present, falling back to the matched case's metric so the rendered
    notification stays meaningful rather than blank."""
    return {
        "metric": params.get("metric", "") or "",
        "condition": params.get("condition", "") or "",
        "threshold": params.get("threshold", case.get("case_duration", "")),
    }


async def dispatch_action(
    action: dict,
    case: dict,
    *,
    dry_run: bool = False,
    notifier: Any | None = None,
    db: Any | None = None,
    event_log_id: UUID | None = None,
    created_by: UUID | None = None,
) -> dict:
    """Execute a single action against a case. Returns an execution detail dict.

    When *dry_run* is ``True`` the function returns the intent dict without
    performing any side effects (original behaviour — kept for backward compat).

    When *dry_run* is ``False`` the function attempts the real side effect and
    records the outcome in the returned dict:

    * ``success`` — ``True`` when the side effect completed without exception.
    * ``error``   — present only when an exception was caught.

    Transport parameters are injected from the API layer:

    * ``notifier``      — ``Notifier`` instance (email / webhook / Slack).
    * ``db``            — ``AsyncSession`` for DB writes (``tag_case``).
    * ``event_log_id``  — needed by ``tag_case`` to set ``CaseTag.event_log_id``.
    * ``created_by``    — user UUID recorded on new ``CaseTag`` rows.
    """
    action_type = action.get("type")
    params = action.get("params", {}) or {}
    timestamp = datetime.now(timezone.utc).isoformat()

    if action_type == "notify_email":
        to_addr = params.get("to") or ""
        subject = params.get("subject", f"Action rule triggered for case {case['case_id']}")
        detail: dict[str, Any] = {
            "action": "notify_email",
            "to": to_addr,
            "subject": subject,
            "case_id": case["case_id"],
            "timestamp": timestamp,
        }
        if dry_run:
            return detail
        # Real send — delegate to Notifier's SMTP transport.
        try:
            if notifier is None:
                raise RuntimeError("No Notifier supplied; SMTP transport unavailable")
            # _send_email returns early (no send, no exception) when SMTP_HOST
            # is unset — detect that here so we don't report a delivered email
            # that never left the box.
            from app.config import settings  # lazy import to avoid circular deps
            smtp_host = (getattr(settings, "SMTP_HOST", "") or "").strip()
            if not smtp_host:
                detail["success"] = False
                detail["note"] = "SMTP_HOST not configured; email not sent"
                return detail
            adapter = _NotifyAdapter(
                adapter_id=case["case_id"],
                name=f"Action rule notification — case {case['case_id']}",
                email_recipients=[r.strip() for r in to_addr.split(",") if r.strip()],
                webhook_url=None,
                **_notify_context(params, case),
            )
            # Notifier transports are synchronous & blocking (smtplib SMTP with
            # a 10s timeout); run them off the event loop so we don't stall it.
            await asyncio.to_thread(
                notifier._send_email, adapter, _build_notifier_result(case, subject)
            )
            detail["success"] = True
        except Exception as exc:
            logger.error("notify_email failed for case %s: %s", case["case_id"], exc)
            detail["success"] = False
            detail["error"] = str(exc)
        return detail

    if action_type == "notify_webhook":
        url = params.get("url")
        detail = {
            "action": "notify_webhook",
            "url": url,
            "case_id": case["case_id"],
            "timestamp": timestamp,
        }
        if dry_run:
            return detail
        try:
            if notifier is None:
                raise RuntimeError("No Notifier supplied; webhook transport unavailable")
            adapter = _NotifyAdapter(
                adapter_id=case["case_id"],
                name=f"Action rule webhook — case {case['case_id']}",
                email_recipients=[],
                webhook_url=url,
                **_notify_context(params, case),
            )
            # httpx.Client is synchronous & blocking — run it off the loop.
            await asyncio.to_thread(
                notifier._send_webhook, adapter, _build_notifier_result(case)
            )
            detail["success"] = True
        except Exception as exc:
            logger.error("notify_webhook failed for case %s: %s", case["case_id"], exc)
            detail["success"] = False
            detail["error"] = str(exc)
        return detail

    if action_type == "notify_slack":
        url = params.get("url") or params.get("webhook_url")
        detail = {
            "action": "notify_slack",
            "url": url,
            "case_id": case["case_id"],
            "timestamp": timestamp,
        }
        if dry_run:
            return detail
        try:
            if notifier is None:
                raise RuntimeError("No Notifier supplied; Slack transport unavailable")
            adapter = _NotifyAdapter(
                adapter_id=case["case_id"],
                name=f"Action rule Slack — case {case['case_id']}",
                email_recipients=[],
                webhook_url=url,
                **_notify_context(params, case),
            )
            # httpx.Client is synchronous & blocking — run it off the loop.
            await asyncio.to_thread(
                notifier._send_slack, adapter, _build_notifier_result(case)
            )
            detail["success"] = True
        except Exception as exc:
            logger.error("notify_slack failed for case %s: %s", case["case_id"], exc)
            detail["success"] = False
            detail["error"] = str(exc)
        return detail

    if action_type == "tag_case":
        tag_value = params.get("tag", "flagged")
        color = params.get("color", "#06b6d4")
        note = params.get("note")
        detail = {
            "action": "tag_case",
            "tag": tag_value,
            "case_id": case["case_id"],
            "timestamp": timestamp,
        }
        if dry_run:
            return detail
        try:
            if db is None or event_log_id is None or created_by is None:
                raise RuntimeError(
                    "tag_case requires db, event_log_id, and created_by — not supplied"
                )
            from app.models.case_tag import CaseTag  # lazy import to avoid circular deps
            tag_row = CaseTag(
                event_log_id=event_log_id,
                case_id=case["case_id"],
                tag=tag_value,
                color=color,
                note=note,
                created_by=created_by,
            )
            # Insert inside a SAVEPOINT so a flush error (e.g. a duplicate or
            # constraint violation for this one case) rolls back only this row
            # instead of poisoning the shared request session — which would
            # otherwise make every later execution insert and the endpoint's
            # final commit fail, turning one tag failure into a lost batch.
            # The caller (API layer) commits in bulk after all cases.
            async with db.begin_nested():
                db.add(tag_row)
                await db.flush()
            detail["success"] = True
        except Exception as exc:
            logger.error("tag_case failed for case %s: %s", case["case_id"], exc)
            detail["success"] = False
            detail["error"] = str(exc)
        return detail

    if action_type == "create_task":
        assignee = params.get("assignee")
        title = params.get("title", f"Review case {case['case_id']}")
        detail = {
            "action": "create_task",
            "assignee": assignee,
            "title": title,
            "case_id": case["case_id"],
            "timestamp": timestamp,
        }
        if dry_run:
            return detail
        # No task connector wired yet — route via webhook if a URL is supplied,
        # otherwise record as pending-connector so the execution history is honest.
        webhook_url = params.get("webhook_url") or params.get("url")
        if webhook_url and notifier is not None:
            try:
                adapter = _NotifyAdapter(
                    adapter_id=case["case_id"],
                    name=title,
                    email_recipients=[],
                    webhook_url=webhook_url,
                    **_notify_context(params, case),
                )
                # httpx.Client is synchronous & blocking — run it off the loop.
                await asyncio.to_thread(
                    notifier._send_webhook, adapter, _build_notifier_result(case, title)
                )
                detail["success"] = True
            except Exception as exc:
                logger.error("create_task webhook failed for case %s: %s", case["case_id"], exc)
                detail["success"] = False
                detail["error"] = str(exc)
        else:
            logger.info(
                "create_task for case %s recorded as pending — no connector configured",
                case["case_id"],
            )
            detail["success"] = False
            detail["note"] = "Needs external task-management connector"
        return detail

    if action_type == "escalate":
        level = params.get("level", "manager")
        detail = {
            "action": "escalate",
            "level": level,
            "case_id": case["case_id"],
            "timestamp": timestamp,
        }
        if dry_run:
            return detail
        # Route via webhook if configured, otherwise log as pending connector.
        webhook_url = params.get("webhook_url") or params.get("url")
        if webhook_url and notifier is not None:
            try:
                adapter = _NotifyAdapter(
                    adapter_id=case["case_id"],
                    name=f"Escalate to {level} — case {case['case_id']}",
                    email_recipients=[],
                    webhook_url=webhook_url,
                    **_notify_context(params, case),
                )
                # httpx.Client is synchronous & blocking — run it off the loop.
                await asyncio.to_thread(
                    notifier._send_webhook, adapter, _build_notifier_result(case)
                )
                detail["success"] = True
            except Exception as exc:
                logger.error("escalate webhook failed for case %s: %s", case["case_id"], exc)
                detail["success"] = False
                detail["error"] = str(exc)
        else:
            logger.info(
                "escalate for case %s recorded as pending — no connector configured",
                case["case_id"],
            )
            detail["success"] = False
            detail["note"] = "Needs external escalation connector"
        return detail

    return {
        "action": action_type or "unknown",
        "case_id": case["case_id"],
        "timestamp": timestamp,
        "success": False,
        "note": "No handler for this action type",
    }
