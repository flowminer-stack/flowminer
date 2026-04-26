"""
Concept drift detection service for process mining.

Detects process behavioral drift by sliding a window over the event log and
computing Jensen-Shannon divergence (JSD) between transition-frequency
distributions of consecutive windows.

References:
- VDD (2021): Van Zelst et al., "Event Stream-based Process Discovery using Abstract Representations"
- "Explainable concept drift in process mining" (Information Systems 2023)
- CV4CDD (ICPM 2024): CV-based approach — out of scope for v1

TODO (v2): migrate the nightly `check_conformance_drift` Celery task in
`app/workers/tasks.py` to use `DriftDetector.detect_drifts` as its core
computation, replacing the fitness-drop heuristic with a JSD-based signal.
"""

import logging
from collections import defaultdict
from typing import Literal

import numpy as np
import pandas as pd
from scipy.spatial.distance import jensenshannon

logger = logging.getLogger(__name__)

# Standard pm4py column names (match discovery.py / conformance.py)
CASE_COL = "case:concept:name"
ACTIVITY_COL = "concept:name"
TIMESTAMP_COL = "time:timestamp"

WindowSize = Literal["auto", "day", "week", "month"] | str  # also "<N>cases"

_EMPTY_RESULT: dict = {
    "windows": [],
    "drifts": [],
    "summary": {
        "total_windows": 0,
        "total_drifts": 0,
        "avg_jsd": 0.0,
        "max_jsd": 0.0,
    },
}


class DriftDetector:
    """
    Transition-matrix–based concept drift detector.

    Slides a fixed-size window over the event log (by time or case count),
    computes a normalized transition-frequency distribution per window, and
    flags pairs of consecutive windows whose Jensen-Shannon divergence exceeds
    a configurable threshold.
    """

    # ------------------------------------------------------------------ #
    # Public API                                                           #
    # ------------------------------------------------------------------ #

    def detect_drifts(
        self,
        df: pd.DataFrame,
        window: WindowSize = "auto",
        sensitivity: float = 0.15,
    ) -> dict:
        """
        Detect concept drift by sliding a window over the log and computing
        Jensen-Shannon divergence between the transition-frequency distribution
        of consecutive windows.

        Args:
            df:          Event log DataFrame with standard pm4py column names.
            window:      Window granularity.  Accepted values:
                           "auto"   — pick day/week/month so the log yields
                                      8-30 windows (falls back to "week").
                           "day"    — one window per calendar day.
                           "week"   — one window per ISO week.
                           "month"  — one window per calendar month.
                           "<N>cases" — e.g. "50cases" — fixed case count.
            sensitivity: JSD threshold above which a window transition is
                         flagged as a drift point.  Default 0.15.

        Returns::

            {
              "windows": [
                {"start": ts, "end": ts, "case_count": n, "variant_count": n,
                 "top_variants": [...top-5 variants by frequency...]}
              ],
              "drifts": [
                {"window_index": int, "timestamp": ts, "jsd": float,
                 "added_edges":    [(act_a, act_b), ...],
                 "removed_edges":  [(act_a, act_b), ...],
                 "magnitude_changes": [
                   {"edge": [a, b], "before": float, "after": float, "delta": float},
                   ...
                 ]}
              ],
              "summary": {
                "total_windows": n, "total_drifts": n,
                "avg_jsd": float, "max_jsd": float
              }
            }
        """
        if df is None or df.empty:
            logger.debug("DriftDetector: empty dataframe — returning empty result")
            return _EMPTY_RESULT.copy()

        try:
            df = self._ensure_timestamp(df)
        except Exception as exc:
            logger.warning("DriftDetector: timestamp coercion failed: %s", exc)
            return _EMPTY_RESULT.copy()

        # Build windows
        try:
            windowed_frames = self._build_windows(df, window)
        except Exception as exc:
            logger.error("DriftDetector: window construction failed: %s", exc, exc_info=True)
            return _EMPTY_RESULT.copy()

        if len(windowed_frames) < 2:
            # Single window — no pair to compare
            windows_meta = [self._window_meta(w) for w in windowed_frames]
            return {
                "windows": windows_meta,
                "drifts": [],
                "summary": {
                    "total_windows": len(windows_meta),
                    "total_drifts": 0,
                    "avg_jsd": 0.0,
                    "max_jsd": 0.0,
                },
            }

        # Compute per-window transition distributions
        distributions = [self._transition_distribution(w) for w in windowed_frames]
        windows_meta = [self._window_meta(w) for w in windowed_frames]

        # Compare consecutive pairs
        drifts = []
        jsd_values = []
        for i in range(1, len(distributions)):
            dist_prev = distributions[i - 1]
            dist_curr = distributions[i]
            jsd = self._compute_jsd(dist_prev, dist_curr)
            jsd_values.append(jsd)
            if jsd > sensitivity:
                changes = self._explain_changes(dist_prev, dist_curr)
                drift_ts = windowed_frames[i][TIMESTAMP_COL].min()
                drifts.append(
                    {
                        "window_index": i,
                        "timestamp": drift_ts.isoformat() if hasattr(drift_ts, "isoformat") else str(drift_ts),
                        "jsd": round(float(jsd), 6),
                        "added_edges": changes["added"],
                        "removed_edges": changes["removed"],
                        "magnitude_changes": changes["magnitude"],
                    }
                )

        # Sort drifts by descending JSD for the UI (most significant first)
        drifts.sort(key=lambda d: d["jsd"], reverse=True)

        avg_jsd = float(np.mean(jsd_values)) if jsd_values else 0.0
        max_jsd = float(np.max(jsd_values)) if jsd_values else 0.0

        return {
            "windows": windows_meta,
            "drifts": drifts,
            "summary": {
                "total_windows": len(windows_meta),
                "total_drifts": len(drifts),
                "avg_jsd": round(avg_jsd, 6),
                "max_jsd": round(max_jsd, 6),
            },
        }

    # ------------------------------------------------------------------ #
    # Window construction                                                  #
    # ------------------------------------------------------------------ #

    def _ensure_timestamp(self, df: pd.DataFrame) -> pd.DataFrame:
        """Coerce the timestamp column to datetime if needed."""
        if TIMESTAMP_COL not in df.columns:
            raise ValueError(f"Column '{TIMESTAMP_COL}' not found in dataframe")
        df = df.copy()
        if not pd.api.types.is_datetime64_any_dtype(df[TIMESTAMP_COL]):
            df[TIMESTAMP_COL] = pd.to_datetime(df[TIMESTAMP_COL], utc=True, errors="coerce")
        # Drop rows where timestamp couldn't be parsed
        df = df.dropna(subset=[TIMESTAMP_COL])
        return df

    def _resolve_auto_window(self, df: pd.DataFrame) -> str:
        """
        Choose a time granularity so the log breaks into 8-30 windows.
        Falls back to 'week' if no granularity works.
        """
        ts_min = df[TIMESTAMP_COL].min()
        ts_max = df[TIMESTAMP_COL].max()
        span_days = max((ts_max - ts_min).total_seconds() / 86400, 1)

        candidates = [
            ("day",   span_days),
            ("week",  span_days / 7),
            ("month", span_days / 30),
        ]
        for granularity, n_windows in candidates:
            if 8 <= n_windows <= 30:
                logger.debug("DriftDetector: auto window resolved to '%s' (%d windows)", granularity, int(n_windows))
                return granularity

        # If the log is very dense (>30 days) pick month; if very sparse (<8 days) pick day
        if span_days > 30:
            return "month"
        return "day"

    def _build_windows(self, df: pd.DataFrame, window: str) -> list[pd.DataFrame]:
        """Split the dataframe into a list of per-window sub-frames."""
        # Case-count windows: "<N>cases"
        if isinstance(window, str) and window.endswith("cases"):
            try:
                n = int(window[:-5])
            except ValueError:
                raise ValueError(f"Invalid case-count window spec: '{window}'. Expected '<N>cases'.")
            return self._build_case_count_windows(df, n)

        # Time-based windows
        if window == "auto":
            window = self._resolve_auto_window(df)

        freq_map = {"day": "D", "week": "W", "month": "ME"}
        if window not in freq_map:
            raise ValueError(f"Unknown window: '{window}'. Use 'auto', 'day', 'week', 'month', or '<N>cases'.")

        freq = freq_map[window]
        # Group cases by the start event's timestamp period
        case_starts = (
            df.groupby(CASE_COL)[TIMESTAMP_COL]
            .min()
            .rename("_case_start")
            .reset_index()
        )
        case_starts["_period"] = case_starts["_case_start"].dt.to_period(freq)

        df_joined = df.merge(case_starts[[CASE_COL, "_period"]], on=CASE_COL, how="left")

        periods = sorted(df_joined["_period"].dropna().unique())
        frames = []
        for period in periods:
            chunk = df_joined[df_joined["_period"] == period].drop(columns=["_period"])
            if not chunk.empty:
                frames.append(chunk.reset_index(drop=True))

        return frames

    def _build_case_count_windows(self, df: pd.DataFrame, n: int) -> list[pd.DataFrame]:
        """Partition cases into groups of n, ordered by case start time."""
        case_order = (
            df.groupby(CASE_COL)[TIMESTAMP_COL]
            .min()
            .sort_values()
            .index.tolist()
        )
        frames = []
        for i in range(0, len(case_order), n):
            batch = case_order[i : i + n]
            chunk = df[df[CASE_COL].isin(batch)].copy().reset_index(drop=True)
            if not chunk.empty:
                frames.append(chunk)
        return frames

    # ------------------------------------------------------------------ #
    # Window metadata                                                      #
    # ------------------------------------------------------------------ #

    def _window_meta(self, df: pd.DataFrame) -> dict:
        """Compute summary metadata for a single window sub-frame."""
        ts = df[TIMESTAMP_COL]
        case_count = int(df[CASE_COL].nunique())

        # Compute variant signatures and their frequencies
        variant_counts: dict[str, int] = defaultdict(int)
        for _case_id, group in df.sort_values([CASE_COL, TIMESTAMP_COL]).groupby(CASE_COL, sort=False):
            sig = " → ".join(group[ACTIVITY_COL].astype(str).tolist())
            variant_counts[sig] += 1

        top_variants = [
            {"variant": sig, "count": cnt}
            for sig, cnt in sorted(variant_counts.items(), key=lambda x: -x[1])[:5]
        ]

        start = ts.min()
        end = ts.max()

        return {
            "start": start.isoformat() if hasattr(start, "isoformat") else str(start),
            "end": end.isoformat() if hasattr(end, "isoformat") else str(end),
            "case_count": case_count,
            "variant_count": len(variant_counts),
            "top_variants": top_variants,
        }

    # ------------------------------------------------------------------ #
    # Transition distribution                                              #
    # ------------------------------------------------------------------ #

    def _transition_distribution(self, df: pd.DataFrame) -> dict[tuple[str, str], float]:
        """
        Build a normalized transition-frequency distribution over (act_a, act_b)
        pairs observed in directly-follows relations within the window.

        Returns a dict mapping (source, target) → probability in [0, 1].
        """
        counts: dict[tuple[str, str], int] = defaultdict(int)
        sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL])

        for _case_id, group in sorted_df.groupby(CASE_COL, sort=False):
            acts = group[ACTIVITY_COL].astype(str).tolist()
            for a, b in zip(acts, acts[1:]):
                counts[(a, b)] += 1

        total = sum(counts.values())
        if total == 0:
            return {}
        return {edge: cnt / total for edge, cnt in counts.items()}

    # ------------------------------------------------------------------ #
    # JSD computation                                                      #
    # ------------------------------------------------------------------ #

    def _compute_jsd(
        self,
        dist_a: dict[tuple[str, str], float],
        dist_b: dict[tuple[str, str], float],
    ) -> float:
        """
        Compute Jensen-Shannon divergence between two edge distributions.

        Uses the union of both distributions' edge keys; missing edges are
        zero-padded. Returns a value in [0, 1] (jensenshannon returns the
        *distance*, i.e., the square root of the divergence, in base 2).
        """
        if not dist_a and not dist_b:
            return 0.0
        if not dist_a or not dist_b:
            return 1.0  # completely disjoint (one window has no transitions)

        union_keys = sorted(set(dist_a) | set(dist_b))
        p = np.array([dist_a.get(k, 0.0) for k in union_keys], dtype=float)
        q = np.array([dist_b.get(k, 0.0) for k in union_keys], dtype=float)

        jsd = float(jensenshannon(p, q, base=2))
        return min(1.0, max(0.0, jsd))

    # ------------------------------------------------------------------ #
    # Change explanation                                                   #
    # ------------------------------------------------------------------ #

    def _explain_changes(
        self,
        dist_before: dict[tuple[str, str], float],
        dist_after: dict[tuple[str, str], float],
    ) -> dict:
        """
        Identify the top structural and magnitude changes between two distributions.

        Returns:
            {
              "added":    [(a, b), ...]   — edges new in 'after' (top 5 by after-freq)
              "removed":  [(a, b), ...]   — edges gone from 'after' (top 5 by before-freq)
              "magnitude": [
                  {"edge": [a, b], "before": float, "after": float, "delta": float},
                  ...
              ]  — top 5 edges with the largest absolute frequency change
            }
        """
        keys_before = set(dist_before)
        keys_after = set(dist_after)

        added_keys = keys_after - keys_before
        removed_keys = keys_before - keys_after
        common_keys = keys_before & keys_after

        # Top 5 added edges by post-drift frequency
        added = sorted(added_keys, key=lambda k: -dist_after.get(k, 0))[:5]
        added = [list(k) for k in added]

        # Top 5 removed edges by pre-drift frequency
        removed = sorted(removed_keys, key=lambda k: -dist_before.get(k, 0))[:5]
        removed = [list(k) for k in removed]

        # Top 5 magnitude changes among shared edges
        magnitude_changes = []
        for k in common_keys:
            before = dist_before[k]
            after = dist_after[k]
            delta = after - before
            magnitude_changes.append(
                {
                    "edge": list(k),
                    "before": round(float(before), 6),
                    "after": round(float(after), 6),
                    "delta": round(float(delta), 6),
                }
            )
        magnitude_changes.sort(key=lambda x: -abs(x["delta"]))
        magnitude_changes = magnitude_changes[:5]

        return {"added": added, "removed": removed, "magnitude": magnitude_changes}
