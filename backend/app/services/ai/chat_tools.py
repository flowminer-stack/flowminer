"""Chat-tool catalogue used by the streaming chat endpoint.

The `/ai/chat` endpoint runs an agentic tool-use loop when the LLM
provider supports it. This module owns:

  1. The tool *schemas* (in OpenAI function-calling format — we use the
     openai SDK which covers OpenAI, OpenRouter, DeepSeek, Ollama (with
     function-calling), and any other OpenAI-compatible provider).

  2. The *runner* — a plain function that takes a tool name + args and
     executes the underlying mining-engine call, returning a dict with
     three keys:
         ``data``     — the raw numeric result, compact
         ``render``   — a hint the frontend uses to render inline
                        visualizations (chart, filter chips, table)
         ``summary``  — a one-sentence plaintext recap for the LLM to
                        reference in its text output

Design notes
------------
- Tools are scoped to the event log the chat request was made against.
  The LLM cannot ask about a different log; the ``event_log_id`` is not
  part of any tool schema because that would invite a class of
  cross-log leaks and also waste the model's thinking budget.

- ``render`` is deliberately minimal — we pre-aggregate everything on
  the backend and send small payloads (usually <1KB per chart). That
  keeps the NDJSON stream snappy and lets the frontend render with
  recharts without extra roundtrips.

- ``summary`` is what the LLM reads back in the next turn. If the
  underlying data is large or complicated, we strip it down to the
  2-3 most useful numbers so the model doesn't blow its context.
  The frontend-only detail (chart ticks, colors, etc.) stays in
  ``render`` where the LLM never sees it.

- Every tool returns within a few hundred ms on normal logs. Any tool
  that could take >2s would stall the chat UI and is disallowed from
  this surface — put it behind the regular mining endpoints instead.
"""

from __future__ import annotations

import logging
from typing import Any

import pandas as pd

from app.services.mining_engine import mining_engine

logger = logging.getLogger(__name__)


# ── Tool schemas (OpenAI function-calling format) ────────────────────
#
# The ``parameters`` object is JSON Schema. Keep them small and
# strictly typed — the more constrained the schema, the less the LLM
# hallucinates args.

CHAT_TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "show_bottlenecks",
            "description": (
                "Show the slowest activities in the event log ranked "
                "by average duration. Returns a bar chart the user "
                "sees inline. Use this whenever the user asks about "
                "slow steps, bottlenecks, or where time is lost."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "top_n": {
                        "type": "integer",
                        "description": "How many activities to show (1-10).",
                        "default": 5,
                        "minimum": 1,
                        "maximum": 10,
                    }
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "show_rework",
            "description": (
                "Show which activities are most often repeated within "
                "a case (rework). Returns a bar chart of rework rates. "
                "Use this for questions about repeated work, retries, "
                "quality issues, or correction loops."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "top_n": {
                        "type": "integer",
                        "description": "How many activities to show (1-10).",
                        "default": 5,
                        "minimum": 1,
                        "maximum": 10,
                    }
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "show_variants",
            "description": (
                "Show the most common execution paths through the "
                "process and how many cases follow each. Returns a "
                "horizontal bar chart. Use this for questions about "
                "process variability, the 'happy path', or how many "
                "different ways cases are handled."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "top_n": {
                        "type": "integer",
                        "description": "How many variants to show (1-10).",
                        "default": 5,
                        "minimum": 1,
                        "maximum": 10,
                    }
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "show_events_over_time",
            "description": (
                "Show event volume over time. Returns a line chart "
                "grouped by the specified interval. Use this for "
                "questions about throughput, seasonality, volume "
                "trends, or when cases were handled."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "groupby": {
                        "type": "string",
                        "enum": ["hour", "day", "week", "month"],
                        "description": "Time bucket size.",
                        "default": "day",
                    }
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_summary",
            "description": (
                "Get the event log's headline stats — total cases, "
                "total events, unique activities, average case "
                "duration, date range. Call this first if the user "
                "asks an open-ended question without a specific angle."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_filters",
            "description": (
                "Propose a set of filters that narrow the analysis to "
                "the subset of cases the user is asking about. The "
                "user sees an 'Apply to page' button and can accept "
                "or ignore. Use this for questions like 'show me "
                "cases with X' or 'focus on orders that took longer "
                "than Y'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "chips": {
                        "type": "array",
                        "description": "The filter chips to propose.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": {
                                    "type": "string",
                                    "enum": [
                                        "activity",
                                        "activity_exclude",
                                        "duration_range",
                                        "resource",
                                    ],
                                },
                                "label": {
                                    "type": "string",
                                    "description": "Human-readable chip label.",
                                },
                                "activity": {
                                    "type": "string",
                                    "description": "Activity name (for activity/activity_exclude types).",
                                },
                                "min_seconds": {
                                    "type": "number",
                                    "description": "Minimum case duration in seconds (duration_range only).",
                                },
                                "max_seconds": {
                                    "type": "number",
                                    "description": "Maximum case duration in seconds (duration_range only).",
                                },
                                "resource": {
                                    "type": "string",
                                    "description": "Resource name (resource type only).",
                                },
                            },
                            "required": ["type", "label"],
                        },
                    }
                },
                "required": ["chips"],
            },
        },
    },
]


# ── Helpers used by several runners ──────────────────────────────────


def _fmt_duration(seconds: float) -> str:
    """Short human-readable duration."""
    if seconds is None:
        return "—"
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{seconds/60:.1f}m"
    if seconds < 86400:
        return f"{seconds/3600:.1f}h"
    return f"{seconds/86400:.1f}d"


# ── Tool runners ─────────────────────────────────────────────────────
#
# Each runner returns the envelope:
#     {"data": ..., "render": ..., "summary": "..."}
#
# The LLM only sees ``summary`` on the next turn (plus the tool
# result it already requested). The frontend sees the whole envelope
# and picks the right widget from ``render.type``.


def _run_show_bottlenecks(df: pd.DataFrame, args: dict) -> dict:
    top_n = max(1, min(int(args.get("top_n", 5)), 10))
    result = mining_engine.run_bottleneck_analysis(df)
    bottlenecks = result.get("bottlenecks", [])
    # Filter out activities that appear fewer than 5 times or in less
    # than 1% of cases — a single extreme outlier (e.g. Release E with
    # frequency 1 at 112 days) shouldn't dominate the ranking. It's
    # still in the full bottleneck page, just not in this summary.
    from app.services.ingestion import CASE_COL
    total_cases = int(df[CASE_COL].nunique()) if CASE_COL in df.columns else 1
    min_freq = max(5, int(total_cases * 0.01))
    bottlenecks = [
        b for b in bottlenecks
        if int(b.get("frequency") or 0) >= min_freq
    ]
    # Rank by avg duration desc.
    bottlenecks = sorted(
        bottlenecks,
        key=lambda b: float(b.get("avg_duration") or 0),
        reverse=True,
    )[:top_n]

    data = [
        {
            "activity": b["activity"],
            "avg_duration_seconds": float(b.get("avg_duration") or 0),
            "avg_duration_label": _fmt_duration(float(b.get("avg_duration") or 0)),
            "occurrences": int(b.get("frequency") or 0),
        }
        for b in bottlenecks
    ]

    render = {
        "type": "bar_chart",
        "title": f"Top {len(data)} bottlenecks by average duration",
        "x_key": "activity",
        "y_key": "avg_duration_seconds",
        "y_label": "Avg duration",
        "x_label": "Activity",
        "y_formatter": "duration_seconds",
        "data": data,
    }

    if not data:
        summary = "No bottleneck data available."
    else:
        worst = data[0]
        summary = (
            f"{len(data)} bottlenecks surfaced. Worst: "
            f"{worst['activity']} at {worst['avg_duration_label']} "
            f"average across {worst['occurrences']} occurrences."
        )

    return {"data": data, "render": render, "summary": summary}


def _run_show_rework(df: pd.DataFrame, args: dict) -> dict:
    top_n = max(1, min(int(args.get("top_n", 5)), 10))
    result = mining_engine.get_rework(df)
    activities = result.get("activities", [])
    activities = sorted(
        activities,
        key=lambda a: float(a.get("rework_rate") or 0),
        reverse=True,
    )[:top_n]

    data = [
        {
            "activity": a["activity"],
            "rework_rate_pct": round(float(a.get("rework_rate") or 0), 1),
            "rework_count": int(a.get("rework_count") or 0),
        }
        for a in activities
    ]

    render = {
        "type": "bar_chart",
        "title": f"Top {len(data)} activities by rework rate",
        "x_key": "activity",
        "y_key": "rework_rate_pct",
        "y_label": "Rework rate (%)",
        "x_label": "Activity",
        "data": data,
    }

    overall = result.get("overall_rework_rate", 0)
    if not data:
        summary = f"Overall rework rate: {overall:.0f}%. No activity-level data."
    else:
        worst = data[0]
        summary = (
            f"Overall rework: {overall:.0f}% of cases. Worst activity: "
            f"{worst['activity']} at {worst['rework_rate_pct']}% rework rate."
        )

    return {"data": data, "render": render, "summary": summary}


def _run_show_variants(df: pd.DataFrame, args: dict) -> dict:
    top_n = max(1, min(int(args.get("top_n", 5)), 10))
    result = mining_engine.run_variant_analysis(df)
    variants = result.get("variants", [])[:top_n]

    data = []
    for i, v in enumerate(variants, start=1):
        activities = v.get("activities", [])
        # Build a compact label for the inline chart. Show first
        # and last activity with the step count in between when the
        # path is long; full path only when it fits.
        if len(activities) <= 3:
            path = " → ".join(activities)
        else:
            path = f"{activities[0]} → … ({len(activities)} steps) → {activities[-1]}"
        if len(path) > 45:
            path = path[:42] + "…"
        data.append(
            {
                "rank": i,
                "path": f"V{i}: {path}",
                "case_count": int(v.get("case_count") or 0),
                "percentage": round(float(v.get("percentage") or 0), 1),
            }
        )

    render = {
        "type": "bar_chart",
        "title": f"Top {len(data)} process variants",
        "x_key": "path",
        "y_key": "case_count",
        "y_label": "Cases",
        "x_label": "Variant",
        "orientation": "horizontal",
        "data": data,
    }

    total = int(result.get("total_variants") or len(variants))
    if not data:
        summary = f"{total} total variants, none to show."
    else:
        summary = (
            f"{total} total variants. Top variant covers "
            f"{data[0]['percentage']}% of cases ({data[0]['case_count']} cases); "
            f"remaining {total - 1} variants split the rest."
        )

    return {"data": data, "render": render, "summary": summary}


def _run_show_events_over_time(df: pd.DataFrame, args: dict) -> dict:
    groupby = str(args.get("groupby", "day")).lower()
    if groupby not in {"hour", "day", "week", "month"}:
        groupby = "day"

    from app.services.ingestion import TIMESTAMP_COL

    if TIMESTAMP_COL not in df.columns:
        return {
            "data": [],
            "render": None,
            "summary": "Event log has no timestamp column.",
        }

    ts = pd.to_datetime(df[TIMESTAMP_COL], errors="coerce", utc=True)
    ts = ts.dropna()
    if ts.empty:
        return {
            "data": [],
            "render": None,
            "summary": "No valid timestamps in this log.",
        }

    freq_map = {"hour": "H", "day": "D", "week": "W", "month": "ME"}
    buckets = ts.dt.tz_convert(None).dt.to_period(freq_map[groupby])
    counts = buckets.value_counts().sort_index()

    # Cap to 60 data points so we never blow the chart budget on a
    # pathological log. If the requested range is wider we auto-switch
    # to a coarser bucket.
    if len(counts) > 60 and groupby == "hour":
        groupby = "day"
        buckets = ts.dt.tz_convert(None).dt.to_period(freq_map[groupby])
        counts = buckets.value_counts().sort_index()
    if len(counts) > 60 and groupby == "day":
        groupby = "week"
        buckets = ts.dt.tz_convert(None).dt.to_period(freq_map[groupby])
        counts = buckets.value_counts().sort_index()

    data = [
        {"bucket": str(b), "count": int(n)} for b, n in counts.items()
    ][:200]

    render = {
        "type": "line_chart",
        "title": f"Event volume per {groupby}",
        "x_key": "bucket",
        "y_key": "count",
        "y_label": "Events",
        "x_label": groupby.capitalize(),
        "data": data,
    }

    summary = (
        f"{len(data)} {groupby}-buckets. Peak: {max(r['count'] for r in data)} events; "
        f"low: {min(r['count'] for r in data)} events."
    )
    return {"data": data, "render": render, "summary": summary}


def _run_get_summary(df: pd.DataFrame, args: dict) -> dict:
    stats = mining_engine.compute_statistics(df)
    data = {
        "total_cases": int(stats.get("total_cases") or 0),
        "total_events": int(stats.get("total_events") or 0),
        "total_activities": int(stats.get("total_activities") or 0),
        "avg_case_duration_seconds": float(stats.get("avg_case_duration_seconds") or 0),
        "avg_case_duration_label": _fmt_duration(
            float(stats.get("avg_case_duration_seconds") or 0)
        ),
        "date_range": stats.get("date_range"),
    }
    # No chart — this is a metric card set.
    render = {
        "type": "metric_card",
        "title": "Log overview",
        "metrics": [
            {"label": "Total cases", "value": f"{data['total_cases']:,}"},
            {"label": "Total events", "value": f"{data['total_events']:,}"},
            {"label": "Unique activities", "value": str(data["total_activities"])},
            {"label": "Avg case duration", "value": data["avg_case_duration_label"]},
        ],
    }
    summary = (
        f"{data['total_cases']:,} cases, {data['total_events']:,} events, "
        f"{data['total_activities']} activities. Avg case duration: "
        f"{data['avg_case_duration_label']}."
    )
    return {"data": data, "render": render, "summary": summary}


def _run_propose_filters(df: pd.DataFrame, args: dict) -> dict:
    """Sanity-check chips the model proposed, then hand them to the
    frontend to render with an 'Apply' button.

    The model is allowed to propose chips; we don't let it actually
    apply them because that would change page state without user
    consent. The summary the model sees back confirms how many chips
    were recognised so it can reference them in its text response.
    """
    chips_in = args.get("chips") or []
    validated: list[dict] = []
    for raw in chips_in[:10]:  # hard cap
        if not isinstance(raw, dict):
            continue
        ctype = str(raw.get("type") or "").strip()
        label = str(raw.get("label") or "").strip()
        if not ctype or not label:
            continue
        if ctype not in {"activity", "activity_exclude", "duration_range", "resource"}:
            continue
        payload: dict[str, Any] = {}
        if ctype in {"activity", "activity_exclude"}:
            act = str(raw.get("activity") or "").strip()
            if not act:
                continue
            payload["activity"] = act
        elif ctype == "duration_range":
            mn = raw.get("min_seconds")
            mx = raw.get("max_seconds")
            if mn is None and mx is None:
                continue
            if mn is not None:
                payload["min_seconds"] = float(mn)
            if mx is not None:
                payload["max_seconds"] = float(mx)
        elif ctype == "resource":
            res = str(raw.get("resource") or "").strip()
            if not res:
                continue
            payload["resource"] = res
        validated.append({"type": ctype, "label": label, "payload": payload})

    data = validated
    render = {
        "type": "filter_proposal",
        "title": "Proposed filters",
        "chips": validated,
    }
    if not validated:
        summary = "No valid filter chips could be built from the request."
    else:
        summary = (
            f"{len(validated)} filter chip(s) proposed. The user can apply "
            "them with one click."
        )
    return {"data": data, "render": render, "summary": summary}


# Map tool name -> runner function
_RUNNERS = {
    "show_bottlenecks": _run_show_bottlenecks,
    "show_rework": _run_show_rework,
    "show_variants": _run_show_variants,
    "show_events_over_time": _run_show_events_over_time,
    "get_summary": _run_get_summary,
    "propose_filters": _run_propose_filters,
}


def run_tool(name: str, args: dict, df: pd.DataFrame) -> dict:
    """Execute a tool by name, returning the standard envelope.

    Unknown tools return an error envelope instead of raising so the
    streaming chat loop can surface the issue to the user and the
    LLM can recover by picking a different tool.
    """
    runner = _RUNNERS.get(name)
    if runner is None:
        return {
            "data": None,
            "render": None,
            "summary": f"Unknown tool '{name}'.",
            "error": f"unknown_tool:{name}",
        }
    try:
        return runner(df, args or {})
    except Exception as e:
        logger.warning("chat tool %s failed: %s", name, e, exc_info=True)
        return {
            "data": None,
            "render": None,
            "summary": f"Tool '{name}' failed: {type(e).__name__}",
            "error": f"{type(e).__name__}: {str(e)[:180]}",
        }


__all__ = ["CHAT_TOOL_SCHEMAS", "run_tool"]
