"""
Variant analysis service.
Groups cases into process variants (unique activity sequences) and computes
frequency and duration statistics per variant.
"""

import logging

import numpy as np
import pandas as pd

from app.services.rust_accel import analyze_variants as _rs_analyze_variants

logger = logging.getLogger(__name__)

CASE_COL = "case:concept:name"
ACTIVITY_COL = "concept:name"
TIMESTAMP_COL = "time:timestamp"


class VariantAnalysisService:
    """Service for process variant analysis."""

    def analyze_variants(self, df: pd.DataFrame) -> dict:
        """
        Group events by case, create ordered activity sequences, and compute
        variant frequency and duration statistics.

        Each variant is assigned an incrementing id (1, 2, 3, ...) ordered by
        descending frequency.

        Returns:
            dict with:
                - variants: list of Variant-compatible dicts
                - total_cases: int
                - total_variants: int
        """
        if df.empty:
            return {"variants": [], "total_cases": 0, "total_variants": 0}

        # Rust fast path (~30-66x faster)
        rs_variants = _rs_analyze_variants(df)
        if rs_variants is not None:
            total_cases = sum(v["frequency"] for v in rs_variants)
            return {
                "variants": rs_variants,
                "total_cases": int(total_cases),
                "total_variants": len(rs_variants),
            }

        try:
            # Sort events by case and timestamp
            sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL])

            # Build activity sequence per case
            case_sequences = (
                sorted_df.groupby(CASE_COL)[ACTIVITY_COL]
                .apply(list)
                .reset_index()
            )
            case_sequences.columns = [CASE_COL, "_activities"]

            # Convert activity list to a hashable tuple for grouping
            case_sequences["_variant_key"] = case_sequences["_activities"].apply(tuple)

            # Compute case durations
            case_times = sorted_df.groupby(CASE_COL)[TIMESTAMP_COL].agg(["min", "max"])
            case_times["_case_duration"] = (
                case_times["max"] - case_times["min"]
            ).dt.total_seconds()

            # Merge durations into case_sequences
            case_sequences = case_sequences.merge(
                case_times["_case_duration"],
                left_on=CASE_COL,
                right_index=True,
                how="left",
            )

            # Group by variant
            total_cases = len(case_sequences)
            variant_groups = case_sequences.groupby("_variant_key")

            variant_data = []
            for variant_key, group in variant_groups:
                activities = list(variant_key)
                frequency = len(group)
                durations = group["_case_duration"].dropna().values

                avg_duration = float(np.mean(durations)) if len(durations) > 0 else None
                min_duration = float(np.min(durations)) if len(durations) > 0 else None
                max_duration = float(np.max(durations)) if len(durations) > 0 else None
                percentage = (frequency / total_cases) * 100 if total_cases > 0 else 0.0

                variant_data.append(
                    {
                        "activities": activities,
                        "frequency": frequency,
                        "percentage": round(percentage, 2),
                        "avg_duration": avg_duration,
                        "min_duration": min_duration,
                        "max_duration": max_duration,
                    }
                )

            # Sort by frequency descending and assign IDs
            variant_data.sort(key=lambda v: v["frequency"], reverse=True)
            for idx, variant in enumerate(variant_data, start=1):
                variant["id"] = idx

            return {
                "variants": variant_data,
                "total_cases": int(total_cases),
                "total_variants": len(variant_data),
            }

        except Exception as e:
            logger.error(f"Error in variant analysis: {e}", exc_info=True)
            raise
