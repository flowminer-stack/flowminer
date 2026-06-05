"""Shared assertions for validating a connector's raw -> event-log output.

A "mineable" event log is the contract every connector's output must satisfy:
a case identifier, an activity label, and a parseable timestamp, with no nulls
in those three keys. These helpers are used by the Phase 0 connector tests and
are intended to be reused by the transform layer (Phase 6) so the facades and
the real connectors are held to the same bar.
"""

from __future__ import annotations

import pandas as pd

REQUIRED_KEYS = ("case_id_column", "activity_column", "timestamp_column")


def assert_valid_event_log(
    df: pd.DataFrame,
    *,
    case_col: str,
    activity_col: str,
    ts_col: str,
    min_cases: int = 1,
    min_activities: int = 1,
) -> None:
    """Assert ``df`` is a mineable event log.

    Checks (each a distinct, non-tautological failure mode of a transform):
      * the three required columns exist;
      * no null case_id / activity / timestamp;
      * every timestamp parses to a datetime (no NaT after coercion);
      * at least ``min_cases`` distinct cases and ``min_activities`` activities.

    Conformance against a reference process model (token replay) is a stronger
    check layered on top of this in Phase 6 — this is the structural floor.
    """
    assert df is not None and len(df) > 0, "event log is empty"

    for col in (case_col, activity_col, ts_col):
        assert col in df.columns, (
            f"missing required column {col!r}; have {list(df.columns)}"
        )

    for col in (case_col, activity_col, ts_col):
        n_null = int(df[col].isna().sum())
        assert n_null == 0, f"{n_null} null value(s) in required column {col!r}"

    parsed = pd.to_datetime(df[ts_col], errors="coerce", utc=True)
    n_bad = int(parsed.isna().sum())
    assert n_bad == 0, f"{n_bad} unparseable timestamp(s) in column {ts_col!r}"

    n_cases = int(df[case_col].nunique())
    assert n_cases >= min_cases, f"expected >= {min_cases} cases, got {n_cases}"

    n_acts = int(df[activity_col].nunique())
    assert n_acts >= min_activities, (
        f"expected >= {min_activities} distinct activities, got {n_acts}"
    )


def assert_declares_event_log_mapping(mapping: dict | None, *, who: str) -> None:
    """Assert a connector declares a usable default case/activity/timestamp map.

    The contract that separates a mineable connector from a "facade" that dumps
    raw rows: it must tell the pipeline which columns are the case, activity and
    timestamp (or explicitly opt out via ``produces_event_log=False``).
    """
    mapping = mapping or {}
    for key in REQUIRED_KEYS:
        assert mapping.get(key), f"{who} does not declare {key} in its default mapping"
