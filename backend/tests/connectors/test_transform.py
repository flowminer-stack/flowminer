"""Phase 6: the raw -> event-log transform engine (MappingSpec / apply_mapping)."""

from __future__ import annotations

import pandas as pd
import pytest

from app.services.connectors.transform import EventDef, MappingSpec, apply_mapping

from .event_log_assertions import assert_valid_event_log


def _wide_orders():
    # A status-stamped header table: one row per PO, several lifecycle dates.
    return pd.DataFrame(
        [
            {"po": "PO1", "created": "2026-01-01", "approved": "2026-01-02", "shipped": "2026-01-05", "buyer": "alice"},
            {"po": "PO2", "created": "2026-01-03", "approved": "2026-01-04", "shipped": None, "buyer": "bob"},
        ]
    )


def test_melt_unpivots_lifecycle_columns_into_events():
    spec = MappingSpec(
        case_id_column="po",
        resource_column="buyer",
        melt_events=[
            EventDef(timestamp_column="created", activity="Created"),
            EventDef(timestamp_column="approved", activity="Approved"),
            EventDef(timestamp_column="shipped", activity="Shipped"),
        ],
    )
    out = apply_mapping(_wide_orders(), spec)
    # PO1 -> 3 events, PO2 -> 2 (shipped is null and dropped) = 5
    assert len(out) == 5
    assert set(out["activity"]) == {"Created", "Approved", "Shipped"}
    assert set(out["case_id"]) == {"PO1", "PO2"}
    assert "resource" in out.columns
    assert_valid_event_log(
        out, case_col="case_id", activity_col="activity", ts_col="timestamp",
        min_cases=2, min_activities=3,
    )


def test_melt_activity_from_column():
    df = pd.DataFrame([{"id": "A", "ts": "2026-01-01", "step": "Submitted"}])
    spec = MappingSpec(
        case_id_column="id",
        melt_events=[EventDef(timestamp_column="ts", activity_column="step")],
    )
    out = apply_mapping(df, spec)
    assert out.iloc[0]["activity"] == "Submitted"


def test_melt_optional_skips_missing_timestamp_column():
    spec = MappingSpec(
        case_id_column="po",
        melt_events=[
            EventDef(timestamp_column="created", activity="Created"),
            EventDef(timestamp_column="does_not_exist", activity="Ghost"),
        ],
        optional=True,
    )
    out = apply_mapping(_wide_orders(), spec)
    assert set(out["activity"]) == {"Created"}


def test_melt_non_optional_raises_on_missing_column():
    spec = MappingSpec(
        case_id_column="po",
        melt_events=[EventDef(timestamp_column="nope", activity="X")],
        optional=False,
    )
    with pytest.raises(KeyError):
        apply_mapping(_wide_orders(), spec)


def test_simple_mapping_passes_columns_through():
    df = pd.DataFrame(
        [{"cid": "C1", "act": "Open", "when": "2026-01-01", "who": "alice"}]
    )
    spec = MappingSpec(
        case_id_column="cid",
        activity_column="act",
        timestamp_column="when",
        resource_column="who",
    )
    out = apply_mapping(df, spec)
    assert list(out.columns) == ["case_id", "activity", "timestamp", "resource"]
    assert out.iloc[0]["case_id"] == "C1"


def test_simple_mapping_missing_required_column_raises():
    df = pd.DataFrame([{"cid": "C1", "when": "2026-01-01"}])  # no activity col
    spec = MappingSpec(case_id_column="cid", activity_column="act", timestamp_column="when")
    with pytest.raises(KeyError):
        apply_mapping(df, spec)


def test_simple_mapping_optional_resource_missing_is_skipped():
    df = pd.DataFrame([{"cid": "C1", "act": "Open", "when": "2026-01-01"}])
    spec = MappingSpec(
        case_id_column="cid", activity_column="act", timestamp_column="when",
        resource_column="who", optional=True,
    )
    out = apply_mapping(df, spec)
    assert "resource" not in out.columns  # tolerated


def test_flatten_normalizes_nested_json():
    df = pd.DataFrame(
        [{"id": "1", "header": {"created": "2026-01-01", "status": "Open"}}]
    )
    spec = MappingSpec(
        case_id_column="id",
        activity_column="header.status",
        timestamp_column="header.created",
        flatten=True,
    )
    out = apply_mapping(df, spec)
    assert out.iloc[0]["activity"] == "Open"
    assert out.iloc[0]["timestamp"] == "2026-01-01"


def test_default_column_mapping_is_canonical():
    spec = MappingSpec(case_id_column="po", melt_events=[EventDef(timestamp_column="created", activity="Created")])
    m = spec.default_column_mapping()
    assert m["case_id_column"] == "case_id"
    assert m["activity_column"] == "activity"
    assert m["timestamp_column"] == "timestamp"


def test_empty_dataframe_raises():
    with pytest.raises(ValueError):
        apply_mapping(pd.DataFrame(), MappingSpec(case_id_column="x"))
