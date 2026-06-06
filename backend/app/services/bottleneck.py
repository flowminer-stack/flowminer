"""
Bottleneck analysis service.
Identifies processing-time bottlenecks and computes waiting times between activities.
"""

import logging
from collections import defaultdict

import numpy as np
import pandas as pd

from app.services.rust_accel import compute_bottlenecks as _rs_bottlenecks

logger = logging.getLogger(__name__)

CASE_COL = "case:concept:name"
ACTIVITY_COL = "concept:name"
TIMESTAMP_COL = "time:timestamp"


class BottleneckService:
    """Service for bottleneck detection and waiting time analysis."""

    def analyze_bottlenecks(self, df: pd.DataFrame) -> dict:
        """
        Analyze processing times and waiting times to identify bottlenecks.

        For each activity:
        - Duration = time from this event to the next event in the same case.
        - Activities with avg duration > 75th percentile are flagged as bottlenecks.
        - Severity: critical (>95th), high (>90th), medium (>75th), low (<=75th).

        For each pair of consecutive activities:
        - Waiting time = transition time between activities.

        Returns:
            dict with "bottlenecks", "waiting_times", and "dbsm_scores" lists.
        """
        if df.empty:
            return {"bottlenecks": [], "waiting_times": [], "dbsm_scores": []}

        # Rust fast path (replaces iterrows bottleneck)
        rs_result = _rs_bottlenecks(df)
        if rs_result is not None:
            # Compute DBSM on top of Rust result if not already present.
            # The Rust bottlenecks already carry avg/median/frequency AND each
            # activity's p95_duration, so DBSM needs no per-event `valid` frame
            # — this avoids two full-log sorts/copies (~hundreds of MB) on every
            # bottleneck request.
            if not rs_result.get("dbsm_scores"):
                try:
                    activity_stats = rs_result.get("bottlenecks", [])
                    waiting_times = rs_result.get("waiting_times", [])
                    rs_result["dbsm_scores"] = self.compute_dbsm_scores(
                        None, activity_stats, waiting_times
                    )
                except Exception as e:
                    logger.warning(f"DBSM computation on Rust result failed: {e}")
                    rs_result["dbsm_scores"] = []
            return rs_result

        try:
            # Sort by case and timestamp
            sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL]).copy()

            # Compute duration to next event within each case
            sorted_df["_next_ts"] = sorted_df.groupby(CASE_COL)[TIMESTAMP_COL].shift(-1)
            sorted_df["_next_activity"] = sorted_df.groupby(CASE_COL)[ACTIVITY_COL].shift(-1)
            sorted_df["_duration_seconds"] = (
                sorted_df["_next_ts"] - sorted_df[TIMESTAMP_COL]
            ).dt.total_seconds()

            # Drop rows where there is no next event (last event in case)
            valid = sorted_df.dropna(subset=["_duration_seconds"]).copy()

            # --- Activity bottleneck analysis ---
            activity_stats = self._compute_activity_stats(valid)
            bottlenecks = self._classify_bottlenecks(activity_stats)

            # --- Waiting time analysis (per transition) ---
            waiting_times = self._compute_waiting_times(valid)

            # --- DBSM single-score ranking ---
            dbsm_scores = self.compute_dbsm_scores(valid, activity_stats, waiting_times)

            return {
                "bottlenecks": bottlenecks,
                "waiting_times": waiting_times,
                "dbsm_scores": dbsm_scores,
            }

        except Exception as e:
            logger.error(f"Error in bottleneck analysis: {e}", exc_info=True)
            raise

    def compute_dbsm_scores(
        self,
        df: pd.DataFrame,
        activity_stats: list,
        waiting_times: list,
    ) -> list:
        """
        Compute DBSM (Dynamic Bottleneck Scoring Method) scores per activity.

        Blends three components into a single 0-100 score:
        - Delay (40%): avg duration vs overall median duration
        - Resource pressure (30%): tail-to-median ratio (or waiting-time ratio)
        - Cycle-time impact (30%): share of total log duration consumed

        Returns:
            list of dicts sorted by dbsm_score descending with ranks assigned.
        """
        if not activity_stats:
            return []

        # --- Pre-compute globals ---
        all_avg_durations = [s["avg_duration"] for s in activity_stats]
        overall_median = float(np.median(all_avg_durations)) if all_avg_durations else 1.0
        if overall_median == 0:
            overall_median = 1.0

        # Total log duration = sum of (avg_duration * frequency) across all activities
        total_log_duration = sum(
            s["avg_duration"] * s["frequency"] for s in activity_stats
        )
        if total_log_duration == 0:
            total_log_duration = 1.0

        # Build a lookup from activity -> activity_stats dict (for p95/median)
        stats_by_activity: dict = {s["activity"]: s for s in activity_stats}

        # p95 duration per activity. Prefer the value the Rust bottleneck pass
        # already computed (carried on each stat dict) so we avoid re-deriving
        # per-event durations; fall back to the raw df for the pure-Python path.
        p95_by_activity: dict = {}
        if activity_stats and all("p95_duration" in s for s in activity_stats):
            p95_by_activity = {
                str(s["activity"]): float(s["p95_duration"]) for s in activity_stats
            }
        elif df is not None:
            grouped = df.groupby(ACTIVITY_COL)["_duration_seconds"]
            for activity, durations in grouped:
                p95_by_activity[str(activity)] = float(np.percentile(durations.values, 95))

        # Build waiting-time lookup: activity -> avg wait as source
        # Use (activity_avg_wait / overall_avg_wait) * 50, capped at 100
        avg_wait_by_activity: dict = {}
        overall_avg_wait = 0.0
        if waiting_times:
            all_waits = [wt["avg_waiting"] for wt in waiting_times]
            overall_avg_wait = float(np.mean(all_waits)) if all_waits else 0.0
            for wt in waiting_times:
                src = wt["source"]
                if src not in avg_wait_by_activity:
                    avg_wait_by_activity[src] = wt["avg_waiting"]
                else:
                    # Take the max wait among all outgoing transitions
                    avg_wait_by_activity[src] = max(avg_wait_by_activity[src], wt["avg_waiting"])

        results = []
        for stat in activity_stats:
            activity = stat["activity"]
            avg_dur = stat["avg_duration"]
            median_dur = stat["median_duration"] if stat["median_duration"] > 0 else 1.0
            freq = stat["frequency"]
            activity_total = avg_dur * freq

            # --- Delay component (40%) ---
            delay = min(100.0, (avg_dur / overall_median) * 50.0)

            # --- Resource pressure component (30%) ---
            p95 = p95_by_activity.get(activity, avg_dur)
            if overall_avg_wait > 0 and activity in avg_wait_by_activity:
                pressure = min(100.0, (avg_wait_by_activity[activity] / overall_avg_wait) * 50.0)
            else:
                pressure = min(100.0, (p95 / median_dur) * 25.0)

            # --- Cycle-time impact component (30%) ---
            impact = min(100.0, (activity_total / total_log_duration) * 200.0)

            dbsm = round(0.4 * delay + 0.3 * pressure + 0.3 * impact, 1)

            results.append(
                {
                    "activity": activity,
                    "dbsm_score": dbsm,
                    "delay_component": round(delay, 1),
                    "pressure_component": round(pressure, 1),
                    "impact_component": round(impact, 1),
                    "rank": 0,  # filled in below
                }
            )

        # Sort descending by score, assign ranks 1..N
        results.sort(key=lambda r: r["dbsm_score"], reverse=True)
        for i, r in enumerate(results):
            r["rank"] = i + 1

        return results

    def _compute_activity_stats(self, valid: pd.DataFrame) -> list:
        """
        Compute per-activity duration statistics.

        Returns:
            list of dicts with activity, avg_duration, median_duration, frequency.
        """
        stats = []
        grouped = valid.groupby(ACTIVITY_COL)["_duration_seconds"]

        for activity, durations in grouped:
            dur_array = durations.values
            stats.append(
                {
                    "activity": str(activity),
                    "avg_duration": float(np.mean(dur_array)),
                    "median_duration": float(np.median(dur_array)),
                    "frequency": int(len(dur_array)),
                }
            )

        return stats

    def _classify_bottlenecks(self, activity_stats: list) -> list:
        """
        Classify activities as bottlenecks based on duration percentiles.

        Severity thresholds applied to the avg_duration across all activities:
        - critical: > 95th percentile
        - high: > 90th percentile
        - medium: > 75th percentile
        - low: <= 75th percentile

        Returns:
            list of Bottleneck-compatible dicts.
        """
        if not activity_stats:
            return []

        # Exclude extreme outlier activities (frequency < 5) from the
        # percentile computation so a single rare event like Release E
        # (freq 1, 112 days) doesn't skew the thresholds and dominate
        # the bottleneck ranking.
        freq_threshold = max(5, int(sum(s["frequency"] for s in activity_stats) * 0.005))
        representative = [s for s in activity_stats if s["frequency"] >= freq_threshold]
        basis = representative if representative else activity_stats
        avg_durations = [s["avg_duration"] for s in basis]
        p75 = float(np.percentile(avg_durations, 75))
        p90 = float(np.percentile(avg_durations, 90))
        p95 = float(np.percentile(avg_durations, 95))

        bottlenecks = []
        for stat in activity_stats:
            avg = stat["avg_duration"]
            freq = stat["frequency"]

            # Low-frequency activities are never flagged as bottlenecks
            # but still appear in the list so users can investigate.
            if freq < freq_threshold:
                severity = "low"
                is_bottleneck = False
            elif avg > p95:
                severity = "critical"
                is_bottleneck = True
            elif avg > p90:
                severity = "high"
                is_bottleneck = True
            elif avg > p75:
                severity = "medium"
                is_bottleneck = True
            else:
                severity = "low"
                is_bottleneck = False

            bottlenecks.append(
                {
                    "activity": stat["activity"],
                    "avg_duration": stat["avg_duration"],
                    "median_duration": stat["median_duration"],
                    "frequency": stat["frequency"],
                    "is_bottleneck": is_bottleneck,
                    "severity": severity,
                }
            )

        # Flagged bottlenecks first (by duration desc), then non-bottleneck
        # activities (by duration desc). This keeps Release E visible at the
        # bottom with severity "low" instead of dominating position #1.
        bottlenecks.sort(
            key=lambda b: (b["is_bottleneck"], b["avg_duration"]),
            reverse=True,
        )

        return bottlenecks

    def _compute_waiting_times(self, valid: pd.DataFrame) -> list:
        """
        Compute waiting/transition times between each pair of consecutive activities.

        Returns:
            list of WaitingTime-compatible dicts.
        """
        # Group by (source activity, target activity) pairs
        transition_durations = defaultdict(list)

        for _, row in valid.iterrows():
            source = str(row[ACTIVITY_COL])
            target = str(row["_next_activity"])
            duration = row["_duration_seconds"]
            if pd.notna(duration):
                transition_durations[(source, target)].append(duration)

        waiting_times = []
        for (source, target), durations in transition_durations.items():
            dur_array = np.array(durations)
            waiting_times.append(
                {
                    "source": source,
                    "target": target,
                    "avg_waiting": float(np.mean(dur_array)),
                    "median_waiting": float(np.median(dur_array)),
                    "max_waiting": float(np.max(dur_array)),
                    "frequency": int(len(dur_array)),
                }
            )

        # Sort by avg_waiting descending
        waiting_times.sort(key=lambda w: w["avg_waiting"], reverse=True)

        return waiting_times
