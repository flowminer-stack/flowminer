"""Data anonymization utilities for masking PII in process mining data."""

import hashlib
from typing import Callable

import pandas as pd

from app.services.ingestion import CASE_COL, RESOURCE_COL


def _derive_column_salt(column_label: str) -> str:
    """Derive a per-column salt by mixing the server SECRET_KEY with the column label.

    This makes rainbow-table / dictionary attacks significantly harder: an attacker
    who does not know the server SECRET_KEY cannot pre-compute a table.  The salt is
    deterministic so pseudonyms are stable across restarts (same key + same column
    label = same salt).

    Imported lazily to avoid a module-level circular import at test time.
    """
    from app.config import settings  # noqa: PLC0415

    keyed = f"{settings.SECRET_KEY}:{column_label}"
    # Take the full 64-char digest as the salt — length doesn't matter
    # much here since it's only used as HMAC-style prefix material, but
    # a longer salt keeps the combined material well above birthday-bound.
    return hashlib.sha256(keyed.encode()).hexdigest()


def _hash_value(val: str, column_label: str = "flowminer") -> str:
    """Produce a deterministic pseudonym for *val* scoped to *column_label*.

    Security note: this is a DETERMINISTIC pseudonym, NOT anonymisation.
    Given the server SECRET_KEY and the column label an attacker can still
    invert the mapping by dictionary attack on small or bounded domains
    (e.g. a list of employee IDs).  Use only as a privacy-in-depth measure,
    not as a substitute for true anonymisation (k-anonymity, differential
    privacy, etc.).

    Truncation is widened to 16 hex chars (64 bits) to reduce collision
    probability on large logs and raise the bar against brute-force inversion.
    """
    if pd.isna(val) or val == "":
        return val
    salt = _derive_column_salt(column_label)
    h = hashlib.sha256(f"{salt}:{val}".encode()).hexdigest()[:16]
    return f"anon_{h}"


def anonymize_df(
    df: pd.DataFrame,
    anonymize_resources: bool = False,
    anonymize_case_ids: bool = False,
    masked_columns: list[str] | None = None,
) -> pd.DataFrame:
    """Return a copy of the DataFrame with specified columns pseudonymised.

    Pseudonymisation is deterministic (same value always maps to the same
    token within a deployment) so case/resource relationships are preserved
    for process-mining analyses.  The mapping is keyed on the server
    SECRET_KEY; see ``_hash_value`` for the security caveats.
    """
    if not anonymize_resources and not anonymize_case_ids and not masked_columns:
        return df

    # Shallow copy: only the pseudonymised columns are reassigned (with fresh
    # data), so the other columns' blocks are shared read-only with the input
    # rather than deep-copied. On a 1.6M-row log this avoids copying every
    # untouched column (hundreds of MB) on every non-admin request.
    result = df.copy(deep=False)

    if anonymize_resources and RESOURCE_COL in result.columns:
        result[RESOURCE_COL] = _hash_column(result[RESOURCE_COL], "resource")

    if anonymize_case_ids and CASE_COL in result.columns:
        result[CASE_COL] = _hash_column(result[CASE_COL], "case")

    if masked_columns:
        for col in masked_columns:
            if col in result.columns:
                result[col] = _hash_column(result[col], col)

    return result


def _hash_column(series: pd.Series, label: str) -> pd.Series:
    """Pseudonymise a column by hashing only its DISTINCT values, then mapping.

    Identical output to a per-row ``_hash_value`` map, but a column with k
    distinct values costs k SHA-256 calls instead of one per row — a large
    win for low-cardinality columns (e.g. ~hundreds of resources across
    millions of events).
    """
    s = series.astype(str)
    mapping = {u: _hash_value(u, label) for u in s.unique()}
    return s.map(mapping)
