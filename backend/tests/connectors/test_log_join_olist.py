"""Log-join tests over the REAL Olist e-commerce dataset (multi-table).

Complements the synthetic P2P tests with genuine real-world data: orders
(header, 4 lifecycle timestamps) joined to aggregated payments, plus the
many-to-many reject on the raw order-items table.

Skips cleanly when the data is absent (it is git-ignored — fetch with
``python backend/scripts/fetch_olist.py``), so CI without the data stays green.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from app.services.log_builder import build_event_log

from .event_log_assertions import assert_valid_event_log

_OLIST_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "olist"

_ORDERS = "olist_orders_dataset.csv"
_ITEMS = "olist_order_items_dataset.csv"
_PAYMENTS = "olist_order_payments_dataset.csv"

# Header lifecycle timestamps -> activities (order-to-cash).
_ORDER_EVENTS = [
    {"activity_name": "Order Purchased", "timestamp_column": "order_purchase_timestamp"},
    {"activity_name": "Payment Approved", "timestamp_column": "order_approved_at"},
    {"activity_name": "Handed to Carrier", "timestamp_column": "order_delivered_carrier_date"},
    {"activity_name": "Delivered to Customer", "timestamp_column": "order_delivered_customer_date"},
]

_MAX_ORDERS = 4000  # cap for a fast test; the join/aggregation logic is unaffected


def _require(*names: str) -> None:
    missing = [n for n in names if not (_OLIST_DIR / n).exists()]
    if missing:
        pytest.skip(
            f"Olist data not present ({missing}); run "
            "`python backend/scripts/fetch_olist.py` to enable these tests."
        )


def test_olist_orders_plus_payments_join(tmp_path):
    _require(_ORDERS, _PAYMENTS)

    orders = pd.read_csv(_OLIST_DIR / _ORDERS, nrows=_MAX_ORDERS)
    orders_path = tmp_path / "orders.csv"
    orders.to_csv(orders_path, index=False)

    # Aggregate the multi-row payments to one row per order (sum) so the join is
    # one-to-one; restrict to the sampled orders to keep it light.
    pay = pd.read_csv(_OLIST_DIR / _PAYMENTS)
    pay = pay[pay["order_id"].isin(orders["order_id"])]
    pay_summary = pay.groupby("order_id", as_index=False).agg(
        payment_total=("payment_value", "sum"),
    )
    pay_path = tmp_path / "payments_summary.csv"
    pay_summary.to_csv(pay_path, index=False)

    out = tmp_path / "olist_log.csv"
    result = build_event_log(
        file_path=str(orders_path),
        case_id_column="order_id",
        events=_ORDER_EVENTS,
        passthrough_columns=["payment_total"],  # only exists post-join -> proves the join
        additional_sources=[str(pay_path)],
        joins=[{"right_source": 0, "left_on": ["order_id"], "right_on": ["order_id"], "how": "left"}],
        output_path=str(out),
    )

    assert result["total_cases"] <= len(orders)
    assert "Order Purchased" in result["activities"]
    log = pd.read_csv(out)
    assert "payment_total" in log.columns       # the joined column rode through
    assert_valid_event_log(
        log, case_col="case_id", activity_col="activity", ts_col="timestamp",
        min_cases=100, min_activities=3,
    )


def test_olist_raw_items_join_rejected(tmp_path):
    """Raw order-items (N rows per order) must be rejected by the join guard."""
    _require(_ORDERS, _ITEMS)

    orders = pd.read_csv(_OLIST_DIR / _ORDERS, nrows=500)
    orders_path = tmp_path / "orders.csv"
    orders.to_csv(orders_path, index=False)

    items = pd.read_csv(_OLIST_DIR / _ITEMS)
    items = items[items["order_id"].isin(orders["order_id"])]
    items_path = tmp_path / "items.csv"
    items.to_csv(items_path, index=False)

    # Only meaningful if the sample actually contains a multi-item order.
    if not items["order_id"].duplicated().any():
        pytest.skip("sampled Olist orders happen to be single-item; no many-to-many to reject")

    with pytest.raises(ValueError) as exc:
        build_event_log(
            file_path=str(orders_path),
            case_id_column="order_id",
            events=[{"activity_name": "Order Purchased",
                     "timestamp_column": "order_purchase_timestamp"}],
            additional_sources=[str(items_path)],
            joins=[{"right_source": 0, "left_on": ["order_id"], "right_on": ["order_id"]}],
        )
    assert "duplicate" in str(exc.value).lower() or "many" in str(exc.value).lower()
