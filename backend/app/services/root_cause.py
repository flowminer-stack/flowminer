"""
Root cause analysis service.
Identifies case attributes that correlate with or impact case duration,
using statistical methods (group comparison for categorical, Pearson correlation
for numerical attributes).
"""

import logging

import numpy as np
import pandas as pd
from scipy import stats

logger = logging.getLogger(__name__)

CASE_COL = "case:concept:name"
ACTIVITY_COL = "concept:name"
TIMESTAMP_COL = "time:timestamp"
RESOURCE_COL = "org:resource"
COST_COL = "cost:total"

# Standard columns that should not be treated as case attributes for root cause
STANDARD_COLS = {
    CASE_COL,
    ACTIVITY_COL,
    TIMESTAMP_COL,
    RESOURCE_COL,
    COST_COL,
}

# Minimum number of cases with an attribute value to include it in the analysis
MIN_SAMPLE_SIZE = 5


class RootCauseService:
    """Service for root cause analysis of process performance differences."""

    def analyze_root_causes(self, df: pd.DataFrame) -> dict:
        """
        Identify case-level attributes that correlate with or impact case duration.

        For categorical attributes: compare avg case duration across different values.
        For numerical attributes: compute Pearson correlation with case duration.

        Returns:
            dict with:
                - factors: list of RootCauseFactor-compatible dicts
                - correlations: list of Correlation-compatible dicts
        """
        if df.empty:
            return {"factors": [], "correlations": []}

        try:
            # Compute case-level duration
            case_durations = self._compute_case_durations(df)
            if case_durations.empty:
                return {"factors": [], "correlations": []}

            # Build a case-level attribute DataFrame
            case_attributes = self._build_case_attributes(df, case_durations)
            if case_attributes.empty or len(case_attributes.columns) <= 1:
                # Only the duration column or nothing
                return {"factors": [], "correlations": []}

            overall_avg_duration = float(case_attributes["_case_duration"].mean())

            # Identify attribute columns (everything except _case_duration)
            attribute_cols = [
                c for c in case_attributes.columns if c != "_case_duration"
            ]

            factors = []
            correlations = []

            for col in attribute_cols:
                series = case_attributes[col].dropna()
                if series.empty:
                    continue

                if self._is_categorical(series):
                    col_factors = self._analyze_categorical(
                        case_attributes, col, overall_avg_duration
                    )
                    factors.extend(col_factors)
                elif self._is_numerical(series):
                    correlation = self._analyze_numerical(case_attributes, col)
                    if correlation is not None:
                        correlations.append(correlation)

            # Sort factors by absolute impact (difference between affected and normal)
            factors.sort(
                key=lambda f: abs(f["avg_duration_affected"] - f["avg_duration_normal"]),
                reverse=True,
            )

            # Sort correlations by absolute correlation value
            correlations.sort(
                key=lambda c: abs(c["correlation_value"]),
                reverse=True,
            )

            return {"factors": factors, "correlations": correlations}

        except Exception as e:
            logger.error(f"Error in root cause analysis: {e}", exc_info=True)
            raise

    def _compute_case_durations(self, df: pd.DataFrame) -> pd.Series:
        """
        Compute total duration per case (max timestamp - min timestamp).

        Returns:
            pd.Series indexed by case_id with duration in seconds.
        """
        case_times = df.groupby(CASE_COL)[TIMESTAMP_COL].agg(["min", "max"])
        durations = (case_times["max"] - case_times["min"]).dt.total_seconds()
        durations.name = "_case_duration"
        return durations

    def _build_case_attributes(
        self, df: pd.DataFrame, case_durations: pd.Series
    ) -> pd.DataFrame:
        """
        Build a DataFrame where each row is a case and columns are case-level
        attributes plus the duration.

        Case-level attributes are columns whose values are constant within a case
        or which represent additional metadata. We take the first value per case
        for each non-standard column.
        """
        # Identify candidate attribute columns
        candidate_cols = [c for c in df.columns if c not in STANDARD_COLS]
        if not candidate_cols:
            # Return just durations
            return case_durations.to_frame()

        # For each case, take the first value of each attribute
        # (event-level attributes like resource are excluded from STANDARD_COLS
        # only if they aren't mapped; if they are, they're in STANDARD_COLS)
        case_attrs = df.groupby(CASE_COL)[candidate_cols].first()

        # Filter to columns that are truly case-level (constant within a case)
        # by checking nunique per case. A column is case-level if max nunique <= 1.
        # For efficiency with large datasets, we sample.
        case_level_cols = []
        for col in candidate_cols:
            nunique_per_case = df.groupby(CASE_COL)[col].nunique()
            # If 90%+ of cases have unique value for this column, treat it as case-level
            if (nunique_per_case <= 1).mean() >= 0.9:
                case_level_cols.append(col)

        if not case_level_cols:
            return case_durations.to_frame()

        case_attrs = case_attrs[case_level_cols]
        case_attrs = case_attrs.join(case_durations)

        return case_attrs

    def _is_categorical(self, series: pd.Series) -> bool:
        """Check if a series should be treated as categorical."""
        if series.dtype == object or series.dtype.name == "category":
            return True
        if series.dtype == bool:
            return True
        # Treat integers with few unique values as categorical
        if pd.api.types.is_integer_dtype(series) and series.nunique() <= 20:
            return True
        return False

    def _is_numerical(self, series: pd.Series) -> bool:
        """Check if a series should be treated as numerical."""
        if pd.api.types.is_numeric_dtype(series) and series.nunique() > 20:
            return True
        if pd.api.types.is_float_dtype(series):
            return True
        return False

    def _analyze_categorical(
        self,
        case_attrs: pd.DataFrame,
        col: str,
        overall_avg_duration: float,
    ) -> list:
        """
        For a categorical attribute, compare avg case duration across different values.

        Returns:
            list of RootCauseFactor-compatible dicts.
        """
        factors = []

        value_counts = case_attrs[col].value_counts()

        for value, count in value_counts.items():
            if count < MIN_SAMPLE_SIZE:
                continue

            # Cases with this attribute value
            affected_mask = case_attrs[col] == value
            affected_durations = case_attrs.loc[affected_mask, "_case_duration"]
            normal_durations = case_attrs.loc[~affected_mask, "_case_duration"]

            if affected_durations.empty or normal_durations.empty:
                continue

            avg_affected = float(affected_durations.mean())
            avg_normal = float(normal_durations.mean())

            # Determine impact direction
            diff = avg_affected - avg_normal
            diff_ratio = abs(diff) / overall_avg_duration if overall_avg_duration > 0 else 0

            if diff > 0:
                impact = "negative"  # longer duration = negative impact on performance
            elif diff < 0:
                impact = "positive"  # shorter duration = positive impact on performance
            else:
                impact = "neutral"

            factors.append(
                {
                    "attribute": str(col),
                    "value": str(value),
                    "impact": impact,
                    "avg_duration_affected": round(avg_affected, 2),
                    "avg_duration_normal": round(avg_normal, 2),
                    "case_count": int(count),
                }
            )

        return factors

    def _analyze_numerical(
        self, case_attrs: pd.DataFrame, col: str
    ) -> dict | None:
        """
        For a numerical attribute, compute Pearson correlation with case duration.

        Returns:
            Correlation-compatible dict, or None if not enough data.
        """
        valid = case_attrs[[col, "_case_duration"]].dropna()
        if len(valid) < MIN_SAMPLE_SIZE:
            return None

        # Check for zero variance
        if valid[col].std() == 0 or valid["_case_duration"].std() == 0:
            return None

        try:
            corr_value, p_value = stats.pearsonr(
                valid[col].values, valid["_case_duration"].values
            )
        except Exception as e:
            logger.warning(f"Could not compute correlation for {col}: {e}")
            return None

        return {
            "attribute": str(col),
            "correlation_value": round(float(corr_value), 4),
            "p_value": round(float(p_value), 6),
        }
