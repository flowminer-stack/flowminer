"""
Queue mining service: M/M/c queueing model per activity with wait-time decomposition.

Implements the approach from:
  Senderovich et al., "Queue Mining for Delay Prediction in Multi-Class Service Processes"
  Information Systems, 2015.

For each activity we fit an M/M/c queue:
  - lambda (arrival rate): occurrences / hour over the full log timespan
  - mu (service rate): 1 / mean(activity_duration_hours); fallback to per-activity dist mean
  - c (servers): distinct org:resource values observed for this activity (default 1)
  - rho = lambda / (c * mu), clamped to 0.999

Erlang-C formula (Pollaczek-Khinchine for M/M/c):
  P0 = [sum_{n=0}^{c-1} (c*rho)^n/n!  +  (c*rho)^c / (c! * (1-rho))]^-1
  Pq = (c*rho)^c * P0 / (c! * (1-rho))    # probability a job waits (Erlang C)
  Wq = Pq / (c*mu - lambda)               # expected waiting time

Wait decomposition (heuristic):
  resource_contention_s = clamp(Wq_seconds, 0, actual_avg_wait)
  inter_batch_wait_s    = estimated from timestamp clustering (5-min window)
  external_dependency_s = max(0, actual_avg_wait - resource_contention - inter_batch)
  processing_s          = mean activity duration
"""

import logging
import math
from collections import defaultdict

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

CASE_COL = "case:concept:name"
ACTIVITY_COL = "concept:name"
TIMESTAMP_COL = "time:timestamp"
RESOURCE_COL = "org:resource"

_BATCH_WINDOW_S = 300  # 5-minute clustering window for batch detection


def _erlang_c(c: int, rho: float) -> float | None:
    """
    Compute Erlang-C probability (Pq) = P(job waits in M/M/c queue).

    Returns None if the system is unstable (rho >= 1) or computation fails.

    Formula (Pollaczek-Khinchine):
        sum_term = sum_{n=0}^{c-1} (c*rho)^n / n!
        last_term = (c*rho)^c / (c! * (1 - rho))
        P0 = 1 / (sum_term + last_term)
        Pq = (c*rho)^c * P0 / (c! * (1 - rho))
    """
    if rho >= 1.0:
        return None
    try:
        c_rho = c * rho
        c_fact = math.factorial(c)

        sum_term = sum(
            (c_rho ** n) / math.factorial(n)
            for n in range(c)
        )
        last_term = (c_rho ** c) / (c_fact * (1.0 - rho))

        p0 = 1.0 / (sum_term + last_term)
        pq = (c_rho ** c) * p0 / (c_fact * (1.0 - rho))
        return float(pq)
    except (OverflowError, ZeroDivisionError, ValueError):
        return None


def _expected_wait_s(
    lam: float, mu: float, c: int, rho: float
) -> float | None:
    """
    Compute E[Wq] in seconds for an M/M/c queue.

    Wq = Pq / (c * mu - lambda)   [in hours]
    Returns None if unstable or computation fails.
    """
    pq = _erlang_c(c, rho)
    if pq is None:
        return None
    denom = c * mu - lam  # in events/hour
    if denom <= 0:
        return None
    wq_hours = pq / denom
    return wq_hours * 3600.0  # convert to seconds


def _estimate_batch_wait_s(timestamps: pd.Series) -> float:
    """
    Estimate inter-batch waiting time using timestamp clustering.

    Jobs that arrive within _BATCH_WINDOW_S seconds of each other
    are considered the same batch. The mean gap between batch starts
    is returned as a proxy for inter-batch wait.

    Returns 0.0 if there are fewer than 2 events.
    """
    if len(timestamps) < 2:
        return 0.0
    sorted_ts = timestamps.sort_values().reset_index(drop=True)
    gaps = sorted_ts.diff().dt.total_seconds().dropna()
    # Find batch boundaries: gaps > window
    batch_gaps = gaps[gaps > _BATCH_WINDOW_S]
    if len(batch_gaps) == 0:
        return 0.0
    # Mean inter-batch gap → spread evenly as wait for jobs within each batch
    mean_batch_gap = float(batch_gaps.mean())
    # Fraction of cases that are in a batch (not the first arrival)
    batch_arrivals = (gaps <= _BATCH_WINDOW_S).sum()
    total = len(gaps)
    fraction_batched = batch_arrivals / max(total, 1)
    return mean_batch_gap * fraction_batched


class QueueMiningService:
    """
    Per-activity M/M/c queueing analysis with wait-time decomposition.

    Reference: Senderovich et al., Information Systems 2015.
    """

    def analyze(self, df: pd.DataFrame) -> dict:
        """
        Run M/M/c queue mining on a normalized event-log DataFrame.

        Returns a dict with:
          per_activity: list of per-activity queue stats
          summary: system-level summary
        """
        if df.empty:
            return {"per_activity": [], "summary": self._empty_summary()}

        # Ensure timestamps are datetime
        df = df.copy()
        if not pd.api.types.is_datetime64_any_dtype(df[TIMESTAMP_COL]):
            df[TIMESTAMP_COL] = pd.to_datetime(df[TIMESTAMP_COL], utc=True, errors="coerce")

        df = df.dropna(subset=[TIMESTAMP_COL])
        if df.empty:
            return {"per_activity": [], "summary": self._empty_summary()}

        log_start = df[TIMESTAMP_COL].min()
        log_end = df[TIMESTAMP_COL].max()
        log_span_h = max((log_end - log_start).total_seconds() / 3600.0, 1e-6)

        # Compute per-case activity durations (time to next event in same case)
        sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL]).copy()
        sorted_df["_next_ts"] = sorted_df.groupby(CASE_COL)[TIMESTAMP_COL].shift(-1)
        sorted_df["_next_activity"] = sorted_df.groupby(CASE_COL)[ACTIVITY_COL].shift(-1)
        sorted_df["_duration_s"] = (
            sorted_df["_next_ts"] - sorted_df[TIMESTAMP_COL]
        ).dt.total_seconds()

        has_resource = RESOURCE_COL in df.columns

        per_activity = []
        for activity, group in df.groupby(ACTIVITY_COL):
            try:
                result = self._analyze_activity(
                    activity=str(activity),
                    group=group,
                    sorted_df=sorted_df,
                    log_span_h=log_span_h,
                    has_resource=has_resource,
                )
                per_activity.append(result)
            except Exception as exc:
                logger.warning("Queue mining skipped activity %r: %s", activity, exc)

        # Sort by utilization descending
        per_activity.sort(key=lambda x: x["utilization"], reverse=True)

        # Summary
        summary = self._build_summary(per_activity, log_span_h, df)

        return {"per_activity": per_activity, "summary": summary}

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _analyze_activity(
        self,
        activity: str,
        group: pd.DataFrame,
        sorted_df: pd.DataFrame,
        log_span_h: float,
        has_resource: bool,
    ) -> dict:
        n = len(group)

        # --- Arrival rate (lambda) ---
        lam = n / log_span_h  # arrivals per hour

        # --- Service rate (mu) ---
        act_durations = sorted_df.loc[
            sorted_df[ACTIVITY_COL] == activity, "_duration_s"
        ].dropna()
        if len(act_durations) > 0 and act_durations.mean() > 0:
            mean_dur_h = act_durations.mean() / 3600.0
            mu = 1.0 / mean_dur_h  # service completions per hour
            mean_dur_s = float(act_durations.mean())
        else:
            # Fallback: assume a 1-minute service time
            mean_dur_s = 60.0
            mu = 60.0  # per hour

        # --- Server count (c) ---
        if has_resource and RESOURCE_COL in group.columns:
            c = max(1, int(group[RESOURCE_COL].dropna().nunique()))
        else:
            c = 1

        # --- Utilisation (rho) ---
        rho_raw = lam / max(c * mu, 1e-12)
        rho = min(rho_raw, 0.999)
        stable = rho_raw < 1.0

        # --- Erlang-C expected wait ---
        expected_wait_s = _expected_wait_s(lam, mu, c, rho)

        # --- Actual average wait (transition time into this activity) ---
        actual_avg_wait_s = self._compute_actual_wait(activity, sorted_df)

        # --- Wait decomposition ---
        decomp = self._decompose_wait(
            activity=activity,
            group=group,
            actual_avg_wait_s=actual_avg_wait_s,
            expected_wait_s=expected_wait_s,
            mean_dur_s=mean_dur_s,
        )

        # --- Queue health ---
        health = self._queue_health(rho_raw)

        return {
            "activity": activity,
            "arrival_rate_per_hour": round(lam, 4),
            "service_rate_per_hour": round(mu, 4),
            "estimated_servers": c,
            "utilization": round(rho, 4),
            "expected_wait_time_s": round(expected_wait_s, 2) if expected_wait_s is not None else None,
            "actual_avg_wait_time_s": round(actual_avg_wait_s, 2),
            "wait_decomposition": decomp,
            "queue_health": health,
            "stability": stable,
        }

    def _compute_actual_wait(self, activity: str, sorted_df: pd.DataFrame) -> float:
        """
        Actual average waiting time = average transition time *into* this activity.

        We look at rows where _next_activity == activity and use _duration_s
        as a proxy for the waiting time a case experienced before entering it.
        """
        if "_next_activity" not in sorted_df.columns:
            return 0.0
        mask = sorted_df["_next_activity"] == activity
        waiting = sorted_df.loc[mask, "_duration_s"].dropna()
        if len(waiting) == 0:
            return 0.0
        return float(waiting.mean())

    def _decompose_wait(
        self,
        activity: str,
        group: pd.DataFrame,
        actual_avg_wait_s: float,
        expected_wait_s: float | None,
        mean_dur_s: float,
    ) -> dict:
        """Decompose actual_avg_wait into three components."""

        # Resource contention: clamp M/M/c expected wait to observed wait
        if expected_wait_s is not None:
            resource_contention_s = float(np.clip(expected_wait_s, 0.0, actual_avg_wait_s))
        else:
            resource_contention_s = 0.0

        # Inter-batch wait: heuristic clustering
        if TIMESTAMP_COL in group.columns:
            raw_batch = _estimate_batch_wait_s(group[TIMESTAMP_COL])
        else:
            raw_batch = 0.0
        remaining = max(0.0, actual_avg_wait_s - resource_contention_s)
        inter_batch_wait_s = float(np.clip(raw_batch, 0.0, remaining))

        # External dependency: residual
        external_dependency_s = float(
            max(0.0, actual_avg_wait_s - resource_contention_s - inter_batch_wait_s)
        )

        return {
            "resource_contention_s": round(resource_contention_s, 2),
            "inter_batch_wait_s": round(inter_batch_wait_s, 2),
            "external_dependency_s": round(external_dependency_s, 2),
            "processing_s": round(mean_dur_s, 2),
        }

    @staticmethod
    def _queue_health(rho: float) -> str:
        if rho < 0.7:
            return "healthy"
        if rho < 0.9:
            return "strained"
        return "saturated"

    @staticmethod
    def _empty_summary() -> dict:
        return {
            "max_utilization_activity": None,
            "system_throughput_cases_per_hour": 0.0,
        }

    def _build_summary(
        self, per_activity: list, log_span_h: float, df: pd.DataFrame
    ) -> dict:
        max_act = per_activity[0]["activity"] if per_activity else None
        total_cases = df[CASE_COL].nunique() if CASE_COL in df.columns else 0
        throughput = total_cases / max(log_span_h, 1e-6)
        return {
            "max_utilization_activity": max_act,
            "system_throughput_cases_per_hour": round(throughput, 4),
        }
