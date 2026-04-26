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
            dict with "bottlenecks" and "waiting_times" lists.
        """
        if df.empty:
            return {"bottlenecks": [], "waiting_times": []}

        # Rust fast path (replaces iterrows bottleneck)
        rs_result = _rs_bottlenecks(df)
        if rs_result is not None:
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

            return {
                "bottlenecks": bottlenecks,
                "waiting_times": waiting_times,
            }

        except Exception as e:
            logger.error(f"Error in bottleneck analysis: {e}", exc_info=True)
            raise

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
