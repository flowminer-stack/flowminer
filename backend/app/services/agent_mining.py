"""Agent mining — classify resources as human/bot/system and analyze the handoff network.

Bots are detected via naming heuristics (suffixes like _bot, _sys, _rpa, svc_),
speed (median activity duration), and consistency (low duration variance).
"""

import logging
import re

import pandas as pd

from app.services.ingestion import ACTIVITY_COL, CASE_COL, RESOURCE_COL, TIMESTAMP_COL

logger = logging.getLogger(__name__)


_BOT_PATTERNS = [
    r"\bbot\b", r"_bot$", r"^bot_", r"_rpa\b", r"^rpa_",
    r"\bservice\b", r"^svc_", r"_svc$", r"_system$", r"^sys_",
    r"_script\b", r"scheduler", r"_job$", r"cron", r"daemon",
    r"_agent$", r"^agent_", r"_ai$", r"^ai_", r"automation",
]


def _name_looks_like_bot(name: str) -> bool:
    if not name:
        return False
    lowered = str(name).lower()
    return any(re.search(p, lowered) for p in _BOT_PATTERNS)


def analyze_agents(df: pd.DataFrame) -> dict:
    """Classify resources and surface agent-oriented insights.

    Returns:
        dict with 'resources', 'handoffs', 'automation_ratio', 'summary'
    """
    if RESOURCE_COL not in df.columns:
        return {
            "resources": [],
            "handoffs": [],
            "automation_ratio": 0.0,
            "summary": "No resource column available",
        }

    from app.services.transition_cache import get_transitions
    _t = get_transitions(df)
    if _t is not None:
        sorted_df = df
        sorted_df["duration_sec"] = _t.duration_secs
        sorted_df.loc[_t.is_last, "duration_sec"] = 0.0
        sorted_df["duration_sec"] = sorted_df["duration_sec"].clip(lower=0)
    else:
        sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL]).copy()
        sorted_df["next_ts"] = sorted_df.groupby(CASE_COL)[TIMESTAMP_COL].shift(-1)
        sorted_df["duration_sec"] = (sorted_df["next_ts"] - sorted_df[TIMESTAMP_COL]).dt.total_seconds().fillna(0).clip(lower=0)

    # ── Per-resource classification ───────────────────────────────────────
    grouped = sorted_df.groupby(RESOURCE_COL)
    resources = []
    for name, g in grouped:
        if pd.isna(name):
            continue
        events = len(g)
        activities = g[ACTIVITY_COL].nunique()
        durations = g["duration_sec"]
        median_dur = float(durations.median()) if len(durations) > 0 else 0
        std_dur = float(durations.std()) if len(durations) > 1 else 0
        # A bot is typically: fast median, very consistent durations, OR matches a naming pattern
        name_hit = _name_looks_like_bot(name)
        speed_hit = median_dur < 10 and events >= 5  # sub-10s median with decent sample
        consistency_hit = std_dur < (median_dur * 0.3) if median_dur > 0 else False

        score = int(name_hit) * 3 + int(speed_hit) * 2 + int(consistency_hit) * 1
        if score >= 3:
            kind = "bot"
        elif score >= 2:
            kind = "likely_bot"
        else:
            kind = "human"

        resources.append({
            "resource": str(name),
            "kind": kind,
            "events": events,
            "unique_activities": int(activities),
            "median_duration_sec": round(median_dur, 2),
            "stddev_duration_sec": round(std_dur, 2),
            "unique_cases": int(g[CASE_COL].nunique()),
            "score": score,
        })

    # ── Human→bot & bot→human handoffs ────────────────────────────────────
    kind_by_name = {r["resource"]: r["kind"] for r in resources}

    sorted_df["next_resource"] = sorted_df.groupby(CASE_COL)[RESOURCE_COL].shift(-1)
    handoff_rows = sorted_df.dropna(subset=["next_resource"])

    def _kind(n):
        return kind_by_name.get(str(n), "human") if not pd.isna(n) else "unknown"

    handoff_counts: dict[str, int] = {}
    for _, row in handoff_rows.iterrows():
        from_kind = _kind(row[RESOURCE_COL])
        to_kind = _kind(row["next_resource"])
        key = f"{from_kind}→{to_kind}"
        handoff_counts[key] = handoff_counts.get(key, 0) + 1

    handoffs = [{"transition": k, "count": v} for k, v in sorted(handoff_counts.items(), key=lambda x: -x[1])]

    # ── Overall automation ratio ──────────────────────────────────────────
    bot_events = sum(r["events"] for r in resources if r["kind"] in ("bot", "likely_bot"))
    human_events = sum(r["events"] for r in resources if r["kind"] == "human")
    total = bot_events + human_events
    automation_ratio = bot_events / total if total else 0.0

    # Summary
    bots = [r for r in resources if r["kind"] in ("bot", "likely_bot")]
    humans_only = [r for r in resources if r["kind"] == "human"]
    summary = (
        f"{len(bots)} automated resource(s) processed {bot_events:,} events "
        f"({automation_ratio*100:.1f}% of work). {len(humans_only)} human resource(s)."
    )

    resources.sort(key=lambda r: -r["events"])
    return {
        "resources": resources[:200],
        "handoffs": handoffs,
        "automation_ratio": round(automation_ratio, 3),
        "bot_events": bot_events,
        "human_events": human_events,
        "summary": summary,
    }
