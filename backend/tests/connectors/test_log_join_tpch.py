"""Integration test: the log-join engine over TPC-H (DuckDB) at scale.

TPC-H's orders↔lineitem on ``orderkey`` is the exact header→lines 1:N shape the
``many_to_one`` guard targets. Default SF is tiny (0.01, ~60k line items) for a
fast CI gate; bump ``FLOWMINER_TPCH_SF`` (e.g. 10) to stress the join + connectors
at 60M+ rows for perf.

Marked ``integration`` (excluded from the default ``-m "not integration"`` run)
and skips cleanly when duckdb or the tpch extension is unavailable.
"""

from __future__ import annotations

import os

import pandas as pd
import pytest

pytest.importorskip("duckdb")

from app.services.log_builder import build_event_log  # noqa: E402

from .event_log_assertions import assert_valid_event_log  # noqa: E402
from tests.fixtures.tpch import TPCH_EVENTS, generate_tpch, tpch_join_args  # noqa: E402

pytestmark = pytest.mark.integration

_SF = float(os.environ.get("FLOWMINER_TPCH_SF", "0.01"))


@pytest.fixture(scope="module")
def tpch_paths(tmp_path_factory):
    out = tmp_path_factory.mktemp("tpch")
    try:
        return generate_tpch(out, sf=_SF)
    except Exception as e:  # offline first-run / extension unavailable
        pytest.skip(f"TPC-H generation unavailable (duckdb tpch extension/network): {e}")


def test_tpch_lineitem_primary_join(tpch_paths, tmp_path):
    """lineitem (N-side) primary + orders (unique key) joined -> event log."""
    orders = pd.read_parquet(tpch_paths["orders"])
    lineitem = pd.read_parquet(tpch_paths["lineitem"])
    n_lines = len(lineitem)
    n_cases = lineitem["l_orderkey"].nunique()

    out = tmp_path / "tpch_log.csv"
    result = build_event_log(**tpch_join_args(tpch_paths, output_path=str(out)))

    # case = order; 4 timestamp columns unpivot to 4 events per line item.
    assert result["total_cases"] == n_cases
    assert result["total_events"] == 4 * n_lines
    assert set(result["activities"]) == {"Order Placed", "Committed", "Shipped", "Received"}

    log = pd.read_csv(out)
    assert_valid_event_log(
        log, case_col="case_id", activity_col="activity", ts_col="timestamp",
        min_cases=n_cases, min_activities=4,
    )


def test_tpch_header_primary_with_aggregated_lines(tpch_paths, tmp_path):
    """The other valid orientation: orders header primary + aggregated lines.

    Collapse lineitem to one row per order (the recipe's intent) so each
    activity fires once per case.
    """
    lineitem = pd.read_parquet(tpch_paths["lineitem"])
    agg = lineitem.groupby("l_orderkey", as_index=False).agg(
        first_commit=("l_commitdate", "min"),
        first_ship=("l_shipdate", "min"),
        last_receipt=("l_receiptdate", "max"),
    )
    agg_path = tmp_path / "lines_agg.parquet"
    agg.to_parquet(agg_path, index=False)

    out = tmp_path / "tpch_header_log.csv"
    result = build_event_log(
        file_path=tpch_paths["orders"],
        case_id_column="o_orderkey",
        events=[
            {"activity_name": "Order Placed", "timestamp_column": "o_orderdate"},
            {"activity_name": "Committed", "timestamp_column": "first_commit"},
            {"activity_name": "Shipped", "timestamp_column": "first_ship"},
            {"activity_name": "Received", "timestamp_column": "last_receipt"},
        ],
        additional_sources=[str(agg_path)],
        joins=[{"right_source": 0, "left_on": ["o_orderkey"],
                "right_on": ["l_orderkey"], "how": "left"}],
        output_path=str(out),
    )
    n_orders = len(pd.read_parquet(tpch_paths["orders"]))
    assert result["total_cases"] == n_orders
    assert result["total_events"] == 4 * n_orders  # one event per activity per order


def test_tpch_raw_lineitem_as_additional_is_rejected(tpch_paths):
    """Putting raw multi-row lineitem on the RIGHT must be rejected.

    This is the orientation mistake the many-to-one guard exists to catch:
    orders primary + RAW lineitem (duplicate orderkey) as additional_source.
    """
    with pytest.raises(ValueError) as exc:
        build_event_log(
            file_path=tpch_paths["orders"],
            case_id_column="o_orderkey",
            events=[{"activity_name": "Order Placed", "timestamp_column": "o_orderdate"}],
            additional_sources=[tpch_paths["lineitem"]],
            joins=[{"right_source": 0, "left_on": ["o_orderkey"], "right_on": ["l_orderkey"]}],
        )
    assert "duplicate" in str(exc.value).lower() or "many" in str(exc.value).lower()
