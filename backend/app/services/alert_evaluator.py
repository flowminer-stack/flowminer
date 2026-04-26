"""
AlertEvaluator: evaluates alert conditions against current process metrics.

Supported metrics
-----------------
Spec-defined metrics (used by the alert delivery system):
  - avg_case_duration   : average case duration in seconds
  - total_cases         : total number of distinct cases
  - bottleneck_count    : number of activities flagged as bottlenecks
  - conformance_fitness : token-replay fitness score (0–1)

Alert-engine legacy metrics (delegated to AlertEngine.compute_metric):
  - avg_cycle_time, median_cycle_time, max_cycle_time
  - rework_rate, case_count, variant_count, automation_rate
"""

import logging

import pandas as pd

from app.services.alert_engine import AlertEngine, CONDITION_OPERATORS, CASE_COL, TIMESTAMP_COL

logger = logging.getLogger(__name__)

# Metrics handled natively by AlertEvaluator (not delegated to AlertEngine)
_NATIVE_METRICS = frozenset(
    ["avg_case_duration", "total_cases", "bottleneck_count", "conformance_fitness"]
)


class AlertEvaluator:
    """Evaluates alert conditions against current process metrics.

    Wraps AlertEngine for its existing metric set and adds four new metrics
    required by the alert delivery system.
    """

    def __init__(self):
        self._engine = AlertEngine()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def evaluate(self, alert, df: pd.DataFrame) -> dict:
        """Compute the metric value and check it against the threshold.

        Args:
            alert: An Alert ORM instance with .metric, .condition, .threshold.
            df:    A normalised event-log DataFrame (pm4py column names).

        Returns:
            {
                "triggered":     bool,
                "current_value": float,
                "message":       str,
            }
        """
        metric = alert.metric
        condition = (
            alert.condition.value
            if hasattr(alert.condition, "value")
            else str(alert.condition)
        )
        threshold = float(alert.threshold)

        value = self._compute_metric(metric, df)
        triggered = self._check_condition(value, condition, threshold)

        message = (
            f"{metric} = {value:.4f} "
            f"(threshold: {condition} {threshold})"
        )

        return {
            "triggered": triggered,
            "current_value": value,
            "message": message,
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _compute_metric(self, metric: str, df: pd.DataFrame) -> float:
        """Dispatch to the appropriate metric computation."""
        metric_lower = metric.lower().strip()

        if metric_lower == "avg_case_duration":
            return self._avg_case_duration(df)
        elif metric_lower == "total_cases":
            return self._total_cases(df)
        elif metric_lower == "bottleneck_count":
            return self._bottleneck_count(df)
        elif metric_lower == "conformance_fitness":
            return self._conformance_fitness(df)
        else:
            # Delegate to the existing AlertEngine for its metric set
            return self._engine.compute_metric(df, metric)

    def _check_condition(self, value: float, condition: str, threshold: float) -> bool:
        """Compare value against threshold using the named condition operator."""
        op = CONDITION_OPERATORS.get(condition)
        if op is None:
            logger.warning("Unknown alert condition '%s'; defaulting to False", condition)
            return False
        return bool(op(value, threshold))

    # ------------------------------------------------------------------
    # Metric implementations
    # ------------------------------------------------------------------

    def _avg_case_duration(self, df: pd.DataFrame) -> float:
        """Average case duration in **seconds**."""
        if df.empty:
            return 0.0
        case_times = df.groupby(CASE_COL)[TIMESTAMP_COL].agg(["min", "max"])
        durations = (case_times["max"] - case_times["min"]).dt.total_seconds()
        return float(durations.mean()) if not durations.empty else 0.0

    def _total_cases(self, df: pd.DataFrame) -> float:
        """Total number of distinct cases."""
        if df.empty:
            return 0.0
        return float(df[CASE_COL].nunique())

    def _bottleneck_count(self, df: pd.DataFrame) -> float:
        """Number of activities flagged as bottlenecks by the BottleneckService."""
        if df.empty:
            return 0.0
        try:
            from app.services.bottleneck import BottleneckService

            result = BottleneckService().analyze_bottlenecks(df)
            bottlenecks = result.get("bottlenecks", [])
            count = sum(1 for b in bottlenecks if b.get("is_bottleneck", False))
            return float(count)
        except Exception as exc:
            logger.error("bottleneck_count computation failed: %s", exc)
            return 0.0

    def _conformance_fitness(self, df: pd.DataFrame) -> float:
        """Token-replay conformance fitness score (0–1)."""
        if df.empty:
            return 0.0
        try:
            from app.services.conformance import ConformanceService

            result = ConformanceService().check_conformance(df)
            return float(result.get("fitness", 0.0))
        except Exception as exc:
            logger.error("conformance_fitness computation failed: %s", exc)
            return 0.0
