"""Raw DataFrame -> event-log transform (the case / activity / timestamp step).

This is the part no extraction framework (Airbyte, dlt, Singer) gives you, and
the difference between a *mineable* connector and a raw dump. A ``MappingSpec``
describes how to turn a source table into an event log:

  * ``melt_events`` — unpivot several timestamp columns (created_at,
    approved_at, shipped_at) into one-event-per-row, each timestamp becoming an
    activity. This is the UNION-ALL pattern process-mining vendors (Celonis,
    QPR, UiPath) use to build a log from a status-stamped header table.
  * ``flatten``     — json_normalize nested record columns into dotted columns
    first (the Workday/Coupa/Ariba raw-JSON problem).
  * simple mapping  — pass an existing activity + timestamp column through.
  * ``optional``    — tolerate missing *optional* (resource) columns instead of
    raising; the case/activity/timestamp keys are always required.

The output always has columns: case_id, activity, timestamp (+ resource when
available). Connectors point ``get_default_column_mapping`` at these.
"""

from __future__ import annotations

from typing import Optional

import pandas as pd
from pydantic import BaseModel

CASE = "case_id"
ACTIVITY = "activity"
TIMESTAMP = "timestamp"
RESOURCE = "resource"


class EventDef(BaseModel):
    """One melt event: a timestamp column becomes an event whose activity is
    either a literal (``activity``) or taken from another column
    (``activity_column``)."""

    timestamp_column: str
    activity: Optional[str] = None
    activity_column: Optional[str] = None


class MappingSpec(BaseModel):
    case_id_column: str
    activity_column: Optional[str] = None
    timestamp_column: Optional[str] = None
    resource_column: Optional[str] = None
    melt_events: list[EventDef] = []
    flatten: bool = False
    optional: bool = True

    def default_column_mapping(self) -> dict:
        """The case/activity/timestamp mapping for the transformed output.

        After ``apply_mapping`` the columns are always the canonical
        case_id/activity/timestamp[/resource], so the connector's downstream
        column mapping is fixed regardless of the source schema.
        """
        mapping = {
            "case_id_column": CASE,
            "activity_column": ACTIVITY,
            "timestamp_column": TIMESTAMP,
        }
        if self.melt_events or self.resource_column:
            mapping["resource_column"] = RESOURCE
        return mapping


def spec_from_config(config: Optional[dict]) -> Optional[MappingSpec]:
    """Build a melt MappingSpec from a connector config that opts into
    event-log extraction by declaring::

        event_timestamps: [{"column": "created-at", "activity": "Created"}, ...]
        case_id_field:   "id"        # optional, default "id"
        resource_field:  "buyer"     # optional

    Returns None when the connector wasn't configured for it (the connector then
    falls back to its raw output + best-effort default mapping).
    """
    config = config or {}
    events = config.get("event_timestamps")
    if not events:
        return None
    return MappingSpec(
        case_id_column=config.get("case_id_field", "id"),
        resource_column=config.get("resource_field"),
        melt_events=[
            EventDef(
                timestamp_column=e["column"],
                activity=e.get("activity"),
                activity_column=e.get("activity_column"),
            )
            for e in events
        ],
    )


def apply_mapping(df: pd.DataFrame, spec: MappingSpec) -> pd.DataFrame:
    """Transform a source DataFrame into a canonical event log."""
    if df is None or len(df) == 0:
        raise ValueError("cannot transform an empty DataFrame")

    if spec.flatten:
        df = pd.json_normalize(df.to_dict("records"))

    if spec.case_id_column not in df.columns:
        raise KeyError(
            f"case id column {spec.case_id_column!r} not in source columns "
            f"{list(df.columns)}"
        )

    out = _melt(df, spec) if spec.melt_events else _simple(df, spec)
    # Drop events with no case id or no timestamp — they aren't valid events.
    out = out[out[CASE].notna() & out[TIMESTAMP].notna()]
    return out.reset_index(drop=True)


def _melt(df: pd.DataFrame, spec: MappingSpec) -> pd.DataFrame:
    parts: list[pd.DataFrame] = []
    for ed in spec.melt_events:
        if ed.timestamp_column not in df.columns:
            if spec.optional:
                continue
            raise KeyError(f"timestamp column {ed.timestamp_column!r} not in source")
        cols = {CASE: df[spec.case_id_column], TIMESTAMP: df[ed.timestamp_column]}
        if ed.activity_column and ed.activity_column in df.columns:
            cols[ACTIVITY] = df[ed.activity_column]
        else:
            cols[ACTIVITY] = ed.activity or ed.timestamp_column
        if spec.resource_column and spec.resource_column in df.columns:
            cols[RESOURCE] = df[spec.resource_column]
        part = pd.DataFrame(cols)
        # Only rows that actually carry this timestamp become events.
        parts.append(part[part[TIMESTAMP].notna()])
    if not parts:
        raise ValueError(
            "melt_events produced no events — none of the timestamp columns "
            "were present in the source"
        )
    return pd.concat(parts, ignore_index=True)


def _simple(df: pd.DataFrame, spec: MappingSpec) -> pd.DataFrame:
    if not (spec.activity_column and spec.timestamp_column):
        raise ValueError(
            "a non-melt mapping needs activity_column and timestamp_column"
        )
    out: dict[str, pd.Series] = {CASE: df[spec.case_id_column]}
    for logical, src, required in (
        (ACTIVITY, spec.activity_column, True),
        (TIMESTAMP, spec.timestamp_column, True),
        (RESOURCE, spec.resource_column, False),
    ):
        if not src:
            continue
        if src in df.columns:
            out[logical] = df[src]
        elif required:
            # case/activity/timestamp are required regardless of `optional`.
            raise KeyError(f"required source column {src!r} not in {list(df.columns)}")
        elif not spec.optional:
            raise KeyError(f"column {src!r} not in {list(df.columns)}")
        # optional + missing -> skip
    return pd.DataFrame(out)
