"""Data anonymization utilities for masking PII in process mining data."""

import hashlib
from typing import Callable

import pandas as pd

from app.services.ingestion import CASE_COL, RESOURCE_COL


def _hash_value(val: str, salt: str = "flowminer") -> str:
    """Hash a value to a deterministic but unrecoverable pseudonym."""
    if pd.isna(val) or val == "":
        return val
    h = hashlib.sha256(f"{salt}:{val}".encode()).hexdigest()[:8]
    return f"anon_{h}"


def anonymize_df(
    df: pd.DataFrame,
    anonymize_resources: bool = False,
    anonymize_case_ids: bool = False,
    masked_columns: list[str] | None = None,
) -> pd.DataFrame:
    """Return a copy of the DataFrame with specified columns anonymized.

    Anonymization uses deterministic hashing so the same input always maps
    to the same pseudonym (preserving relationships).
    """
    if not anonymize_resources and not anonymize_case_ids and not masked_columns:
        return df

    result = df.copy()

    if anonymize_resources and RESOURCE_COL in result.columns:
        result[RESOURCE_COL] = result[RESOURCE_COL].astype(str).map(
            lambda v: _hash_value(v, "resource")
        )

    if anonymize_case_ids and CASE_COL in result.columns:
        result[CASE_COL] = result[CASE_COL].astype(str).map(
            lambda v: _hash_value(v, "case")
        )

    if masked_columns:
        for col in masked_columns:
            if col in result.columns:
                result[col] = result[col].astype(str).map(
                    lambda v: _hash_value(v, col)
                )

    return result
