"""
Process statistics service.
Computes comprehensive statistics about the event log including case durations,
activity frequencies, start/end activities, and time series data.
"""

import logging
from datetime import timedelta

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

CASE_COL = "case:concept:name"
ACTIVITY_COL = "concept:name"
TIMESTAMP_COL = "time:timestamp"


class StatisticsService:
    """Service for computing comprehensive process statistics."""

    def compute_statistics(self, df: pd.DataFrame) -> dict:
        """
        Compute comprehensive process statistics compatible with the
        ProcessStatistics schema.

        Handles edge cases: empty DataFrames, single-event cases, missing timestamps.

        Returns:
            dict matching ProcessStatistics schema fields.
        """
        if df.empty:
            return self._empty_statistics()

        try:
            total_events = len(df)
            total_cases = df[CASE_COL].nunique()
            unique_activities = df[ACTIVITY_COL].dropna().unique()
            total_activities = len(unique_activities)

            # Avg events per case
            events_per_case = df.groupby(CASE_COL).size()
            avg_events_per_case = float(events_per_case.mean()) if total_cases > 0 else 0.0

            # Case durations
            duration_stats = self._compute_duration_stats(df)

            # Start activities
            start_activities = self._compute_start_activities(df)

            # End activities
            end_activities = self._compute_end_activities(df)

            # Activity frequencies
            activity_frequencies = self._compute_activity_frequencies(df, total_events)

            # Cases over time
            cases_over_time = self._compute_cases_over_time(df)

            return {
                "total_cases": int(total_cases),
                "total_events": int(total_events),
                "total_activities": int(total_activities),
                "avg_case_duration": duration_stats["avg"],
                "median_case_duration": duration_stats["median"],
                "min_case_duration": duration_stats["min"],
                "max_case_duration": duration_stats["max"],
                "avg_events_per_case": round(avg_events_per_case, 2),
                "start_activities": start_activities,
                "end_activities": end_activities,
                "activity_frequencies": activity_frequencies,
                "cases_over_time": cases_over_time,
            }

        except Exception as e:
            logger.error(f"Error computing statistics: {e}", exc_info=True)
            raise

    def _empty_statistics(self) -> dict:
        """Return a statistics dict for an empty DataFrame."""
        return {
            "total_cases": 0,
            "total_events": 0,
            "total_activities": 0,
            "avg_case_duration": 0.0,
            "median_case_duration": 0.0,
            "min_case_duration": 0.0,
            "max_case_duration": 0.0,
            "avg_events_per_case": 0.0,
            "start_activities": [],
            "end_activities": [],
            "activity_frequencies": [],
            "cases_over_time": [],
        }

    def _compute_duration_stats(self, df: pd.DataFrame) -> dict:
        """
        Compute case duration statistics (avg, median, min, max in seconds).

        Handles single-event cases (duration = 0).
        """
        if TIMESTAMP_COL not in df.columns:
            return {"avg": 0.0, "median": 0.0, "min": 0.0, "max": 0.0}

        case_times = df.groupby(CASE_COL)[TIMESTAMP_COL].agg(["min", "max"])
        durations = (case_times["max"] - case_times["min"]).dt.total_seconds()

        if durations.empty:
            return {"avg": 0.0, "median": 0.0, "min": 0.0, "max": 0.0}

        return {
            "avg": round(float(durations.mean()), 2),
            "median": round(float(durations.median()), 2),
            "min": round(float(durations.min()), 2),
            "max": round(float(durations.max()), 2),
        }

    def _compute_start_activities(self, df: pd.DataFrame) -> list:
        """
        Compute start activities (first activity in each case) with frequencies.

        Returns:
            list of {"activity": str, "frequency": int}
        """
        sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL])
        first_events = sorted_df.groupby(CASE_COL).first()
        start_counts = first_events[ACTIVITY_COL].value_counts()

        return [
            {"activity": str(activity), "frequency": int(count)}
            for activity, count in start_counts.items()
        ]

    def _compute_end_activities(self, df: pd.DataFrame) -> list:
        """
        Compute end activities (last activity in each case) with frequencies.

        Returns:
            list of {"activity": str, "frequency": int}
        """
        sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL])
        last_events = sorted_df.groupby(CASE_COL).last()
        end_counts = last_events[ACTIVITY_COL].value_counts()

        return [
            {"activity": str(activity), "frequency": int(count)}
            for activity, count in end_counts.items()
        ]

    def _compute_activity_frequencies(
        self, df: pd.DataFrame, total_events: int
    ) -> list:
        """
        Compute activity frequencies with absolute and relative values.

        Returns:
            list of {"activity": str, "frequency": int, "relative_frequency": float}
        """
        counts = df[ACTIVITY_COL].value_counts()

        return [
            {
                "activity": str(activity),
                "frequency": int(count),
                "relative_frequency": round(float(count / total_events), 4)
                if total_events > 0
                else 0.0,
            }
            for activity, count in counts.items()
        ]

    def _compute_cases_over_time(self, df: pd.DataFrame) -> list:
        """
        Compute cases over time, grouping case start dates by day/week/month
        depending on the total time range of the data.

        Returns:
            list of {"date": "YYYY-MM-DD", "count": int}
        """
        if TIMESTAMP_COL not in df.columns:
            return []

        # Get the start timestamp for each case
        case_starts = df.groupby(CASE_COL)[TIMESTAMP_COL].min().reset_index()
        case_starts.columns = [CASE_COL, "_start_ts"]

        if case_starts.empty:
            return []

        # Determine the time range
        ts_min = case_starts["_start_ts"].min()
        ts_max = case_starts["_start_ts"].max()

        if pd.isna(ts_min) or pd.isna(ts_max):
            return []

        time_range = ts_max - ts_min

        # Choose grouping granularity based on the range
        if time_range <= timedelta(days=60):
            # Group by day
            case_starts["_period"] = case_starts["_start_ts"].dt.date
        elif time_range <= timedelta(days=365 * 2):
            # Group by week (Monday start)
            case_starts["_period"] = case_starts["_start_ts"].dt.to_period("W").apply(
                lambda r: r.start_time.date()
            )
        else:
            # Group by month
            case_starts["_period"] = case_starts["_start_ts"].dt.to_period("M").apply(
                lambda r: r.start_time.date()
            )

        period_counts = case_starts.groupby("_period").size().sort_index()

        return [
            {"date": str(period), "count": int(count)}
            for period, count in period_counts.items()
        ]
