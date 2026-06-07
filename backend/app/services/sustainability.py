"""Sustainability / ESG metrics — emission, energy, and water estimates per process activity.

IMPORTANT: the figures this module produces are ESTIMATES, not measurements.
They multiply process activity durations by configurable per-minute factors.
The defaults below are transparent placeholder proxies so the dashboard renders
something sensible out of the box; replace them with your own audited
conversion factors (via the `factors` request field or per-activity overrides)
before using any of these numbers for external ESG disclosure. The response
carries a `methodology` block so this is visible in-product, not buried here.
"""

import logging

import numpy as np
import pandas as pd

from app.services.ingestion import ACTIVITY_COL, CASE_COL, RESOURCE_COL, TIMESTAMP_COL

logger = logging.getLogger(__name__)


# Default emission factors — TRANSPARENT PROXY ESTIMATES, editable per request.
# These are deliberately conservative mid-range placeholders, NOT audited values
# for any specific organisation. Ground them in your own data before disclosure
# (see FACTOR_METHODOLOGY["sources"] for where real factors come from).
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

# Returned to the client so the estimate's basis and limitations are visible in
# the UI rather than implied to be precise measurements.
FACTOR_METHODOLOGY = {
    "estimate": True,
    "disclaimer": (
        "Estimated, not measured. Figures are derived from process activity "
        "durations multiplied by configurable per-minute proxy factors. Replace "
        "the default factors with your own audited conversion factors before "
        "using these numbers for external ESG reporting."
    ),
    "basis": (
        "emissions ≈ active duration × factor, where duration is the gap to the "
        "next event in the same case (work-in-progress time, not wall-clock)."
    ),
    "sources": [
        "GHG Protocol — Corporate Accounting & Reporting Standard (Scope 2/3)",
        "UK DEFRA / BEIS greenhouse-gas conversion factors (published annually)",
        "Cloud-provider carbon reports / regional grid intensity (e.g. ember-climate.org)",
    ],
    "editable": True,
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
        # Keep the response shape stable even with no data so the client always
        # gets the methodology/factors transparency block.
        return {
            "totals": {},
            "by_activity": [],
            "trend": [],
            "high_impact": [],
            "factors": base,
            "methodology": FACTOR_METHODOLOGY,
        }

    # Compute time spent per activity per case as the gap to the next event.
    # FIX (1): when get_transitions returns non-None, the original code assigned
    # duration_sec directly onto `df` (the caller's frame), mutating it in place.
    # We now take a shallow copy so the cached/caller frame is never touched.
    from app.services.transition_cache import get_transitions
    _t = get_transitions(df)
    if _t is not None:
        sorted_df = df.copy(deep=False)  # shallow: avoids mutating the input/cached frame
        duration_arr = _t.duration_secs.copy()  # own copy so clip doesn't touch the cache array
        duration_arr[_t.is_last] = 0.0
        np.clip(duration_arr, 0, None, out=duration_arr)
        sorted_df = sorted_df.assign(duration_sec=duration_arr)
    else:
        sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL]).copy()
        sorted_df["next_ts"] = sorted_df.groupby(CASE_COL)[TIMESTAMP_COL].shift(-1)
        sorted_df["duration_sec"] = (sorted_df["next_ts"] - sorted_df[TIMESTAMP_COL]).dt.total_seconds()
        sorted_df["duration_sec"] = sorted_df["duration_sec"].fillna(0).clip(lower=0)

    # FIX (2): replace three apply(row_fn, axis=1) calls with vectorised numpy.
    # Build per-row factor arrays via Series.map (unmapped → NaN → fill with base value).
    activities = sorted_df[ACTIVITY_COL]
    duration_sec = sorted_df["duration_sec"].to_numpy(dtype=np.float64)

    def _factor_array(key: str) -> np.ndarray:
        """Return a float64 array of per-row factor values, honouring activity_overrides."""
        if overrides:
            mapping = {act: float(ov.get(key, base[key])) for act, ov in overrides.items()}
            arr = activities.map(mapping).to_numpy(dtype="float64")
            # NaN means the activity had no override — fill with the base value
            nan_mask = np.isnan(arr)
            if nan_mask.any():
                arr[nan_mask] = base[key]
        else:
            arr = np.full(len(activities), base[key], dtype=np.float64)
        return arr

    co2_per_min = _factor_array("co2_g_per_minute")
    co2_per_act = _factor_array("co2_g_per_activity")
    energy_per_min = _factor_array("energy_wh_per_minute")
    water_per_hr = _factor_array("water_l_per_hour")

    co2_g_arr = (duration_sec / 60.0) * co2_per_min + co2_per_act
    energy_wh_arr = (duration_sec / 60.0) * energy_per_min
    water_l_arr = (duration_sec / 3600.0) * water_per_hr

    sorted_df = sorted_df.assign(
        co2_g=co2_g_arr,
        energy_wh=energy_wh_arr,
        water_l=water_l_arr,
    )

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
    # FIX (3): replace iterrows() over small grouped frames with to_dict('records').
    # itertuples() is faster than iterrows() but mangles column names that contain
    # non-identifier characters (e.g. "concept:name" → "_0"), which breaks lookups.
    # to_dict('records') is safe and still ~3-5x faster than iterrows() for small frames.
    by_activity_list = [
        {
            "activity": row[ACTIVITY_COL],
            "co2_g": round(float(row["co2_g"]), 2),
            "energy_wh": round(float(row["energy_wh"]), 2),
            "water_l": round(float(row["water_l"]), 3),
            "events": int(row["events"]),
            "share_pct": round(float(row["co2_g"]) / total_co2 * 100, 1) if total_co2 > 0 else 0,
        }
        for row in by_activity.to_dict("records")
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
    # FIX (3): to_dict('records') for trend frame too
    trend_list = [
        {
            "month": row["month"],
            "co2_g": round(float(row["co2_g"]), 2),
            "energy_wh": round(float(row["energy_wh"]), 2),
            "cases": int(row["cases"]),
            "co2_g_per_case": round(float(row["co2_g"]) / row["cases"], 2) if row["cases"] else 0,
        }
        for row in trend.to_dict("records")
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
        "methodology": FACTOR_METHODOLOGY,
    }
