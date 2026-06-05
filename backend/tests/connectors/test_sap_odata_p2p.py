"""Tier-1 tests for the SAP OData fetch path (``_fetch_odata``) + P2P join.

The change-document path is already covered (``test_sap_change_documents.py``);
the single-entity OData path that every other SAP extraction uses had **no
test**. These pin it with respx (no live SAP), then carry the fetched parquet
through ``build_event_log`` so the SAP-OData -> multi-table-join -> event-log
flow is exercised exactly as the ``sap_p2p`` recipe would drive it.

Note (documented gap, not fixed here): the api.sap.com sandbox authenticates
with an ``APIKey`` header, but ``_fetch_odata`` sends HTTP basic auth
(``auth=(username, password)``) — pointing the connector at the public sandbox
would 401. That is a connector change, out of scope for this test module.
"""

from __future__ import annotations

import httpx
import pandas as pd
import pytest
import respx

from app.services.connectors.sap_connector import SAPConnector
from app.services.log_builder import build_event_log

from .event_log_assertions import assert_valid_event_log

BASE = "https://sap.example.com/odata"

# A_PurchaseOrder header rows — one per PO, two lifecycle timestamps. The
# ``__metadata`` blob is what SAP OData v2 attaches and the connector strips.
_HDR_ROWS = [
    {
        "__metadata": {"uri": f"{BASE}/A_PurchaseOrder('4500000001')"},
        "PurchaseOrder": "4500000001",
        "Supplier": "0001000001",
        "CompanyCode": "1000",
        "CreationDate": "2026-01-05T09:00:00",
        "LastChangeDateTime": "2026-01-06T14:30:00",
    },
    {
        "__metadata": {"uri": f"{BASE}/A_PurchaseOrder('4500000002')"},
        "PurchaseOrder": "4500000002",
        "Supplier": "0001000002",
        "CompanyCode": "2000",
        "CreationDate": "2026-01-07T11:15:00",
        "LastChangeDateTime": "2026-01-09T08:45:00",
    },
]

# A_PurchaseOrderItem rows — several per PO (the natural one-to-many that a
# naive join must reject; the recipe aggregates them to one row per PO).
_ITEM_ROWS = [
    {"PurchaseOrder": "4500000001", "PurchaseOrderItem": "00010",
     "Material": "MAT-1001", "OrderQuantity": "10", "ScheduleLineDeliveryDate": "2026-01-20T00:00:00"},
    {"PurchaseOrder": "4500000001", "PurchaseOrderItem": "00020",
     "Material": "MAT-1002", "OrderQuantity": "5", "ScheduleLineDeliveryDate": "2026-01-25T00:00:00"},
    {"PurchaseOrder": "4500000002", "PurchaseOrderItem": "00010",
     "Material": "MAT-2001", "OrderQuantity": "8", "ScheduleLineDeliveryDate": "2026-01-22T00:00:00"},
]


def _odata(rows):
    return httpx.Response(200, json={"d": {"results": rows}})


def _odata_config(entity_set: str) -> dict:
    return {"mode": "odata", "base_url": BASE, "username": "u", "password": "p",
            "entity_set": entity_set, "limit": 1000}


@respx.mock
@pytest.mark.asyncio
async def test_fetch_odata_parses_results_and_strips_metadata(upload_dir):
    respx.get(f"{BASE}/A_PurchaseOrder").mock(return_value=_odata(_HDR_ROWS))

    path = await SAPConnector()._fetch_odata(_odata_config("A_PurchaseOrder"))
    df = pd.read_parquet(path)

    assert len(df) == 2
    assert "__metadata" not in df.columns          # OData metadata stripped
    assert set(df["PurchaseOrder"]) == {"4500000001", "4500000002"}
    assert {"CreationDate", "Supplier", "CompanyCode"}.issubset(df.columns)


@respx.mock
@pytest.mark.asyncio
async def test_fetch_odata_handles_v4_value_envelope(upload_dir):
    """OData v4 wraps rows in ``{"value": [...]}`` instead of ``{"d": {...}}``."""
    respx.get(f"{BASE}/A_PurchaseOrder").mock(
        return_value=httpx.Response(200, json={"value": _HDR_ROWS})
    )
    path = await SAPConnector()._fetch_odata(_odata_config("A_PurchaseOrder"))
    df = pd.read_parquet(path)
    assert len(df) == 2


@respx.mock
@pytest.mark.asyncio
async def test_sap_odata_p2p_join_to_event_log(upload_dir, tmp_path):
    """SAP OData header + aggregated items -> joined -> mineable event log."""
    respx.get(f"{BASE}/A_PurchaseOrder").mock(return_value=_odata(_HDR_ROWS))
    respx.get(f"{BASE}/A_PurchaseOrderItem").mock(return_value=_odata(_ITEM_ROWS))

    hdr_path = await SAPConnector()._fetch_odata(_odata_config("A_PurchaseOrder"))
    itm_path = await SAPConnector()._fetch_odata(_odata_config("A_PurchaseOrderItem"))

    # Collapse the line items to one representative row per PO (earliest
    # delivery) so the header->items join is many-to-one, as the recipe does.
    items = pd.read_parquet(itm_path)
    items_summary = items.groupby("PurchaseOrder", as_index=False).agg(
        delivery_date=("ScheduleLineDeliveryDate", "min"),
    )
    # Write as parquet (not CSV) so the join key keeps its string dtype, matching
    # the header parquet — the connector->connector flow is parquet on both
    # sides. (CSV would re-infer the numeric-looking PO as int64; see
    # test_join_key_dtype_mismatch_is_unhandled for that documented gap.)
    summary_path = tmp_path / "po_items_summary.parquet"
    items_summary.to_parquet(summary_path, index=False)

    out = tmp_path / "sap_p2p_log.csv"
    result = build_event_log(
        file_path=hdr_path,
        case_id_column="PurchaseOrder",
        events=[
            {"activity_name": "PO Created", "timestamp_column": "CreationDate"},
            {"activity_name": "PO Changed", "timestamp_column": "LastChangeDateTime"},
            {"activity_name": "Goods Delivery", "timestamp_column": "delivery_date"},
        ],
        additional_sources=[str(summary_path)],
        joins=[{"right_source": 0, "left_on": ["PurchaseOrder"],
                "right_on": ["PurchaseOrder"], "how": "left"}],
        output_path=str(out),
    )

    assert result["total_cases"] == 2
    assert result["total_events"] == 6  # 2 POs x 3 activities
    assert set(result["activities"]) == {"PO Created", "PO Changed", "Goods Delivery"}

    log = pd.read_csv(out)
    assert_valid_event_log(
        log, case_col="case_id", activity_col="activity", ts_col="timestamp",
        min_cases=2, min_activities=3,
    )


@respx.mock
@pytest.mark.asyncio
async def test_join_key_dtype_mismatch_is_handled(upload_dir, tmp_path):
    """Cross-source join-key dtype drift must not break the join.

    A parquet primary keeps the numeric-looking ``PurchaseOrder`` as a string;
    a CSV join source re-infers it as int64. ``_join_table`` now coerces both
    keys to string when their dtypes differ, so the merge succeeds. (Regression
    guard for the etl_executor dtype-normalization fix.)
    """
    respx.get(f"{BASE}/A_PurchaseOrder").mock(return_value=_odata(_HDR_ROWS))
    hdr_path = await SAPConnector()._fetch_odata(_odata_config("A_PurchaseOrder"))

    # One row per PO, numeric-looking key, as CSV -> pandas re-reads it as int64.
    summary = pd.DataFrame({
        "PurchaseOrder": [4500000001, 4500000002],
        "delivery_date": ["2026-01-20T00:00:00", "2026-01-22T00:00:00"],
    })
    csv_path = tmp_path / "summary_int_key.csv"
    summary.to_csv(csv_path, index=False)

    result = build_event_log(
        file_path=hdr_path,
        case_id_column="PurchaseOrder",
        events=[
            {"activity_name": "PO Created", "timestamp_column": "CreationDate"},
            {"activity_name": "Goods Delivery", "timestamp_column": "delivery_date"},
        ],
        additional_sources=[str(csv_path)],
        joins=[{"right_source": 0, "left_on": ["PurchaseOrder"],
                "right_on": ["PurchaseOrder"], "how": "left"}],
    )
    assert result["total_cases"] == 2
    assert "Goods Delivery" in result["activities"]


@respx.mock
@pytest.mark.asyncio
async def test_sap_odata_raw_items_join_rejected(upload_dir):
    """Joining the raw multi-line item table must raise (no row explosion)."""
    respx.get(f"{BASE}/A_PurchaseOrder").mock(return_value=_odata(_HDR_ROWS))
    respx.get(f"{BASE}/A_PurchaseOrderItem").mock(return_value=_odata(_ITEM_ROWS))

    hdr_path = await SAPConnector()._fetch_odata(_odata_config("A_PurchaseOrder"))
    itm_path = await SAPConnector()._fetch_odata(_odata_config("A_PurchaseOrderItem"))

    with pytest.raises(ValueError) as exc:
        build_event_log(
            file_path=hdr_path,
            case_id_column="PurchaseOrder",
            events=[{"activity_name": "PO Created", "timestamp_column": "CreationDate"}],
            additional_sources=[itm_path],
            joins=[{"right_source": 0, "left_on": ["PurchaseOrder"],
                    "right_on": ["PurchaseOrder"]}],
        )
    assert "duplicate" in str(exc.value).lower() or "many" in str(exc.value).lower()
