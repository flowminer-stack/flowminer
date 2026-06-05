"""End-to-end tests for the log-join / automatic-consolidation engine.

These exercise ``build_event_log`` over genuine **multi-table** relational input
(header + line-items + history sharing ``order_id``) produced by the synthetic
P2P generator — the real shape the ``sap_p2p`` recipe joins on ``EBELN``. They
cover the path the user actually cares about: separate source tables ->
``_assemble_wide_table`` join by source index -> wide table -> unpivot ->
mineable event log.

The negative test pins the most important guardrail: a non-unique (many-to-many)
right key must be REJECTED, not silently fan out and multiply the event count.
"""

from __future__ import annotations

import pandas as pd
import pytest

from app.services.log_builder import build_event_log

from .event_log_assertions import assert_valid_event_log
from tests.fixtures.generate_p2p_data import P2P_EVENTS


def test_p2p_multitable_join_builds_event_log(p2p_tables, tmp_path):
    """header + lines_summary + receipts -> joined wide table -> event log.

    Joins reference the two additional sources by 0-based index, exactly as
    ``_assemble_wide_table`` resolves them.
    """
    n = p2p_tables["n_orders"]
    paths = p2p_tables["join_ready_paths"]
    out = tmp_path / "p2p_event_log.csv"

    result = build_event_log(
        file_path=paths["orders"],
        case_id_column="order_id",
        events=P2P_EVENTS,
        additional_sources=[paths["lines_summary"], paths["receipts"]],
        joins=[
            {"right_source": 0, "left_on": ["order_id"], "right_on": ["order_id"], "how": "left"},
            {"right_source": 1, "left_on": ["order_id"], "right_on": ["order_id"], "how": "left"},
        ],
        output_path=str(out),
    )

    # Every order is a case; nothing dropped, nothing fanned out by the joins.
    assert result["total_cases"] == n
    # Created + Approved + Delivery fire for every case; receipts for most.
    assert result["total_events"] >= 3 * n
    assert {"PO Created", "PO Approved", "First Delivery", "Goods Receipt"}.issubset(
        set(result["activities"])
    )

    log = pd.read_csv(out)
    assert_valid_event_log(
        log, case_col="case_id", activity_col="activity", ts_col="timestamp",
        min_cases=n, min_activities=4,
    )
    # The join actually brought the additional-source timestamps in: the
    # delivery + goods-receipt activities only exist post-join.
    assert (log["activity"] == "First Delivery").sum() == n
    assert (log["activity"] == "Goods Receipt").sum() == n


def test_p2p_raw_lines_join_rejected_as_many_to_many(p2p_tables, tmp_path):
    """Joining the RAW (multi-row-per-order) line table must raise.

    This is the silent-row-explosion bug the ``validate="many_to_one"`` guard
    exists to prevent: ``order_lines`` has several rows per ``order_id``.
    """
    norm = p2p_tables["normalized"]
    with pytest.raises(ValueError) as exc:
        build_event_log(
            file_path=norm["orders"],
            case_id_column="order_id",
            events=[{"activity_name": "PO Created", "timestamp_column": "created_at"}],
            additional_sources=[norm["order_lines"]],
            joins=[{"right_source": 0, "left_on": ["order_id"], "right_on": ["order_id"]}],
        )
    msg = str(exc.value).lower()
    assert "duplicate" in msg or "many" in msg or "order_id" in msg


def test_p2p_header_only_unpivot_without_joins(p2p_tables, tmp_path):
    """Single-source path (no joins) still unpivots the header timestamps."""
    out = tmp_path / "header_only.csv"
    result = build_event_log(
        file_path=p2p_tables["normalized"]["orders"],
        case_id_column="order_id",
        events=[
            {"activity_name": "PO Created", "timestamp_column": "created_at"},
            {"activity_name": "PO Approved", "timestamp_column": "approved_at"},
        ],
        output_path=str(out),
    )
    n = p2p_tables["n_orders"]
    assert result["total_cases"] == n
    assert result["total_events"] == 2 * n
    assert set(result["activities"]) == {"PO Created", "PO Approved"}


def test_join_ready_tables_are_unique_per_order(p2p_tables):
    """Generator contract: the aggregated tables are one row per order.

    If this regresses, the many-to-one join above would start rejecting valid
    input — so pin it directly.
    """
    jr = p2p_tables["join_ready"]
    for name in ("orders", "lines_summary", "receipts"):
        df = jr[name]
        assert df["order_id"].is_unique, f"{name} has duplicate order_id rows"
