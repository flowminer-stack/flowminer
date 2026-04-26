"""
Alert engine service.
Evaluates alert conditions against event log metrics and determines
whether alerts should be triggered.
"""

import logging

import numpy as np
import pandas as pd

from app.services.ingestion import IngestionService

logger = logging.getLogger(__name__)

CASE_COL = "case:concept:name"
ACTIVITY_COL = "concept:name"
TIMESTAMP_COL = "time:timestamp"
RESOURCE_COL = "org:resource"

# Supported comparison conditions
CONDITION_OPERATORS = {
    "gt": lambda current, threshold: current > threshold,
    "lt": lambda current, threshold: current < threshold,
    "eq": lambda current, threshold: abs(current - threshold) < 1e-9,
    "gte": lambda current, threshold: current >= threshold,
    "lte": lambda current, threshold: current <= threshold,
}


class AlertEngine:
    """Service for evaluating alert conditions against event log metrics."""

    def __init__(self):
        self._ingestion_service = IngestionService()

    async def evaluate_alert(
        self,
        alert_config: dict,
        event_log_path: str,
        column_mapping: dict,
    ) -> dict:
        """
        Load the event log, compute the specified metric, and compare against
        the threshold using the specified condition.

        Args:
            alert_config: dict with keys:
                - metric: str — metric name to evaluate
                - condition: str — comparison operator (gt, lt, eq, gte, lte)
                - threshold: float — threshold value
            event_log_path: str — path to the event log file on disk
            column_mapping: dict with keys:
                - case_id_column: str
                - activity_column: str
                - timestamp_column: str
                - resource_column: str (optional)
                - cost_column: str (optional)

        Returns:
            dict with:
                - triggered: bool
                - current_value: float
                - threshold: float
                - metric: str
        """
        metric = alert_config.get("metric", "")
        condition = alert_config.get("condition", "gt")
        threshold = float(alert_config.get("threshold", 0))

        if condition not in CONDITION_OPERATORS:
            raise ValueError(
                f"Unsupported condition: '{condition}'. "
                f"Supported: {list(CONDITION_OPERATORS.keys())}"
            )

        # Load the event log
        try:
            df = self._ingestion_service.load_event_log(
                file_path=event_log_path,
                case_id_col=column_mapping.get("case_id_column", ""),
                activity_col=column_mapping.get("activity_column", ""),
                timestamp_col=column_mapping.get("timestamp_column", ""),
                resource_col=column_mapping.get("resource_column"),
                cost_col=column_mapping.get("cost_column"),
            )
        except Exception as e:
            logger.error(f"Failed to load event log for alert evaluation: {e}")
            raise

        # Compute the metric
        current_value = self.compute_metric(df, metric)

        # Evaluate the condition
        triggered = CONDITION_OPERATORS[condition](current_value, threshold)

        return {
            "triggered": bool(triggered),
            "current_value": float(current_value),
            "threshold": float(threshold),
            "metric": str(metric),
        }

    def compute_metric(self, df: pd.DataFrame, metric: str) -> float:
        """
        Compute a named metric from the event log DataFrame.

        Supported metrics:
            - avg_cycle_time: average case duration in hours
            - median_cycle_time: median case duration in hours
            - max_cycle_time: max case duration in hours
            - rework_rate: percentage of cases with repeated activities
            - case_count: total number of cases
            - variant_count: number of unique variants
            - automation_rate: percentage of cases completed without resource changes

        Args:
            df: Standardized event log DataFrame (pm4py column names).
            metric: Metric name string.

        Returns:
            float metric value.
        """
        if df.empty:
            return 0.0

        metric_lower = metric.lower().strip()

        if metric_lower == "avg_cycle_time":
            return self._compute_avg_cycle_time(df)
        elif metric_lower == "median_cycle_time":
            return self._compute_median_cycle_time(df)
        elif metric_lower == "max_cycle_time":
            return self._compute_max_cycle_time(df)
        elif metric_lower == "rework_rate":
            return self._compute_rework_rate(df)
        elif metric_lower == "case_count":
            return float(df[CASE_COL].nunique())
        elif metric_lower == "variant_count":
            return self._compute_variant_count(df)
        elif metric_lower == "automation_rate":
            return self._compute_automation_rate(df)
        else:
            raise ValueError(
                f"Unsupported metric: '{metric}'. Supported metrics: "
                "avg_cycle_time, median_cycle_time, max_cycle_time, "
                "rework_rate, case_count, variant_count, automation_rate"
            )

    def _get_case_durations_hours(self, df: pd.DataFrame) -> pd.Series:
        """Compute case durations in hours."""
        case_times = df.groupby(CASE_COL)[TIMESTAMP_COL].agg(["min", "max"])
        durations_seconds = (case_times["max"] - case_times["min"]).dt.total_seconds()
        durations_hours = durations_seconds / 3600.0
        return durations_hours

    def _compute_avg_cycle_time(self, df: pd.DataFrame) -> float:
        """Average case duration in hours."""
        durations = self._get_case_durations_hours(df)
        if durations.empty:
            return 0.0
        return float(durations.mean())

    def _compute_median_cycle_time(self, df: pd.DataFrame) -> float:
        """Median case duration in hours."""
        durations = self._get_case_durations_hours(df)
        if durations.empty:
            return 0.0
        return float(durations.median())

    def _compute_max_cycle_time(self, df: pd.DataFrame) -> float:
        """Maximum case duration in hours."""
        durations = self._get_case_durations_hours(df)
        if durations.empty:
            return 0.0
        return float(durations.max())

    def _compute_rework_rate(self, df: pd.DataFrame) -> float:
        """
        Percentage of cases that contain at least one repeated activity.
        A repeated activity is one that appears more than once in a single case.
        """
        total_cases = df[CASE_COL].nunique()
        if total_cases == 0:
            return 0.0

        # For each case, count unique activities vs total activities
        case_stats = df.groupby(CASE_COL)[ACTIVITY_COL].agg(
            total_count="count", unique_count="nunique"
        )
        # Cases with rework have total_count > unique_count
        rework_cases = (case_stats["total_count"] > case_stats["unique_count"]).sum()

        return float((rework_cases / total_cases) * 100)

    def _compute_variant_count(self, df: pd.DataFrame) -> float:
        """Number of unique process variants (unique activity sequences)."""
        sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL])
        variants = (
            sorted_df.groupby(CASE_COL)[ACTIVITY_COL]
            .apply(tuple)
        )
        return float(variants.nunique())

    def _compute_automation_rate(self, df: pd.DataFrame) -> float:
        """
        Percentage of cases completed without resource changes.
        A case is "automated" if all its events have the same resource
        (or if no resource column is available, returns 0.0).
        """
        if RESOURCE_COL not in df.columns:
            return 0.0

        total_cases = df[CASE_COL].nunique()
        if total_cases == 0:
            return 0.0

        # Count unique non-null resources per case
        resource_counts = (
            df.dropna(subset=[RESOURCE_COL])
            .groupby(CASE_COL)[RESOURCE_COL]
            .nunique()
        )

        if resource_counts.empty:
            return 0.0

        # Cases with only 1 unique resource are considered "automated"
        automated_cases = (resource_counts <= 1).sum()

        return float((automated_cases / total_cases) * 100)
