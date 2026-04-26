"""Sustainability / ESG metrics — emission, energy, and water proxies per process activity.

The rates below are *proxies* for transparent reporting. Each represents a
reasonable public-domain mid-range value so customers can parameterize them
to match their own disclosure methodology.
"""

import logging

import pandas as pd

from app.services.ingestion import ACTIVITY_COL, CASE_COL, RESOURCE_COL, TIMESTAMP_COL

logger = logging.getLogger(__name__)


# Default emission factors (editable per project)
DEFAULT_FACTORS = {
    # grams of CO2-equivalent per minute spent executing the activity
    "co2_g_per_minute": 8.5,
    # Wh per minute (server + workstation workload)
    "energy_wh_per_minute": 0.5,
    # litres of cooling water proxy per hour
    "water_l_per_hour": 0.03,
    # cost of one kWh in whatever currency the user is tracking
    "cost_per_kwh": 0.15,
    # flat emission per activity execution (shipping, dispatch, etc.)
    "co2_g_per_activity": 0.0,
}


def compute_sustainability(
    df: pd.DataFrame,
    factors: dict | None = None,
    activity_overrides: dict[str, dict] | None = None,
) -> dict:
    """Return sustainability metrics for a process event log.

    Args:
        df: Event log DataFrame
        factors: override the global default factors
        activity_overrides: per-activity factor overrides
            e.g. {"Ship Package": {"co2_g_per_activity": 1200}}

    Returns:
        dict with overall totals, per-activity breakdown, and trend over time
    """
    base = {**DEFAULT_FACTORS, **(factors or {})}
    overrides = activity_overrides or {}

    if df.empty or ACTIVITY_COL not in df.columns:
        return {"totals": {}, "by_activity": [], "trend": []}

    # Compute time spent per activity per case as the gap to the next event
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
        sorted_df["duration_sec"] = (sorted_df["next_ts"] - sorted_df[TIMESTAMP_COL]).dt.total_seconds()
        sorted_df["duration_sec"] = sorted_df["duration_sec"].fillna(0).clip(lower=0)

    def factor_for(activity: str, key: str) -> float:
        ov = overrides.get(activity, {})
        return float(ov.get(key, base[key]))

    # Per-row metrics
    def row_co2(row):
        minutes = row["duration_sec"] / 60
        return minutes * factor_for(row[ACTIVITY_COL], "co2_g_per_minute") + factor_for(
            row[ACTIVITY_COL], "co2_g_per_activity"
        )

    def row_energy(row):
        return (row["duration_sec"] / 60) * factor_for(row[ACTIVITY_COL], "energy_wh_per_minute")

    def row_water(row):
        return (row["duration_sec"] / 3600) * factor_for(row[ACTIVITY_COL], "water_l_per_hour")

    sorted_df["co2_g"] = sorted_df.apply(row_co2, axis=1)
    sorted_df["energy_wh"] = sorted_df.apply(row_energy, axis=1)
    sorted_df["water_l"] = sorted_df.apply(row_water, axis=1)

    total_co2 = float(sorted_df["co2_g"].sum())
    total_energy = float(sorted_df["energy_wh"].sum())
    total_water = float(sorted_df["water_l"].sum())
    total_cases = int(sorted_df[CASE_COL].nunique())
    avg_co2_per_case = total_co2 / total_cases if total_cases else 0
    total_cost = (total_energy / 1000) * base["cost_per_kwh"]

    # Per-activity breakdown
    by_activity = (
        sorted_df.groupby(ACTIVITY_COL)
        .agg(
            co2_g=("co2_g", "sum"),
            energy_wh=("energy_wh", "sum"),
            water_l=("water_l", "sum"),
            events=(ACTIVITY_COL, "count"),
        )
        .reset_index()
        .sort_values("co2_g", ascending=False)
    )
    by_activity_list = [
        {
            "activity": row[ACTIVITY_COL],
            "co2_g": round(float(row["co2_g"]), 2),
            "energy_wh": round(float(row["energy_wh"]), 2),
            "water_l": round(float(row["water_l"]), 3),
            "events": int(row["events"]),
            "share_pct": round(float(row["co2_g"]) / total_co2 * 100, 1) if total_co2 > 0 else 0,
        }
        for _, row in by_activity.iterrows()
    ]

    # Monthly trend
    sorted_df["month"] = sorted_df[TIMESTAMP_COL].dt.to_period("M").astype(str)
    trend = (
        sorted_df.groupby("month")
        .agg(
            co2_g=("co2_g", "sum"),
            energy_wh=("energy_wh", "sum"),
            cases=(CASE_COL, "nunique"),
        )
        .reset_index()
    )
    trend_list = [
        {
            "month": row["month"],
            "co2_g": round(float(row["co2_g"]), 2),
            "energy_wh": round(float(row["energy_wh"]), 2),
            "cases": int(row["cases"]),
            "co2_g_per_case": round(float(row["co2_g"]) / row["cases"], 2) if row["cases"] else 0,
        }
        for _, row in trend.iterrows()
    ]

    # Cheapest targets: activities with high CO2 but low event counts (candidates for elimination)
    high_impact = [a for a in by_activity_list if a["co2_g"] > total_co2 * 0.1][:5]

    return {
        "totals": {
            "co2_g": round(total_co2, 2),
            "co2_kg": round(total_co2 / 1000, 3),
            "energy_wh": round(total_energy, 2),
            "energy_kwh": round(total_energy / 1000, 3),
            "water_l": round(total_water, 3),
            "energy_cost": round(total_cost, 2),
            "co2_per_case_g": round(avg_co2_per_case, 2),
            "total_cases": total_cases,
        },
        "by_activity": by_activity_list[:50],
        "trend": trend_list,
        "high_impact": high_impact,
        "factors": base,
    }
