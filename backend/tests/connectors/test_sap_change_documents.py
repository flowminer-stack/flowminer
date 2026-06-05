"""Tier-1 test: SAP change-document (CDHDR/CDPOS) extraction over mocked OData.

This is the only connector that does a real raw->event-log transform today
(a CHANGENR inner-join + UDATE/UTIME -> timestamp + TABNAME.FNAME -> activity),
so it is the highest-value connector to pin. We mock the two OData entity sets
with respx and assert the join, the derived columns, and that out-of-scope
CDPOS rows are dropped.
"""

from __future__ import annotations

import httpx
import pandas as pd
import pytest
import respx

from app.services.connectors.sap_connector import SAPConnector

from .event_log_assertions import assert_valid_event_log

BASE = "https://sap.example.com/odata"

# Two in-scope change headers (purchase orders).
_HDR_ROWS = [
    {
        "OBJECTCLAS": "EINKBELEG",
        "OBJECTID": "4500000001",
        "CHANGENR": "0000000001",
        "USERNAME": "ALICE",
        "UDATE": "20260101",
        "UTIME": "090000",
        "CHANGE_IND": "U",
        "TCODE": "ME22N",
    },
    {
        "OBJECTCLAS": "EINKBELEG",
        "OBJECTID": "4500000002",
        "CHANGENR": "0000000002",
        "USERNAME": "BOB",
        "UDATE": "20260102",
        "UTIME": "101500",
        "CHANGE_IND": "U",
        "TCODE": "ME22N",
    },
]

# Three in-scope field changes + one belonging to an out-of-scope CHANGENR.
_POS_ROWS = [
    {"CHANGENR": "0000000001", "TABNAME": "EKKO", "FNAME": "FRGKE", "VALUE_NEW": "X"},
    {"CHANGENR": "0000000001", "TABNAME": "EKPO", "FNAME": "MENGE", "VALUE_NEW": "20"},
    {"CHANGENR": "0000000002", "TABNAME": "EKPO", "FNAME": "NETPR", "VALUE_NEW": "6"},
    {"CHANGENR": "9999999999", "TABNAME": "EKPO", "FNAME": "GHOST", "VALUE_NEW": "?"},
]


def _odata(rows):
    return httpx.Response(200, json={"d": {"results": rows}})


@respx.mock
@pytest.mark.asyncio
async def test_sap_change_documents_join_and_derivation(upload_dir):
    respx.get(f"{BASE}/CDHDRSet").mock(return_value=_odata(_HDR_ROWS))
    respx.get(f"{BASE}/CDPOSSet").mock(return_value=_odata(_POS_ROWS))

    config = {
        "mode": "change_documents",
        "base_url": BASE,
        "username": "u",
        "password": "p",
        "limit": 1000,
    }
    path = await SAPConnector()._fetch_change_documents(config)
    df = pd.read_parquet(path)

    # The out-of-scope CDPOS row (CHANGENR 9999999999) must be dropped by the
    # inner-join -> 3 events, not 4.
    assert len(df) == 3
    assert "GHOST" not in "".join(df["activity"].tolist())

    for col in ("OBJECTID", "activity", "event_timestamp", "USERNAME"):
        assert col in df.columns

    assert set(df["activity"]) == {"EKKO.FRGKE", "EKPO.MENGE", "EKPO.NETPR"}
    assert df["OBJECTID"].notna().all()

    # UDATE 20260101 + UTIME 090000 -> 2026-01-01 09:00:00
    ts = pd.to_datetime(df["event_timestamp"])
    assert (ts.dt.year == 2026).all()

    mapping = SAPConnector().get_default_column_mapping(config)
    assert_valid_event_log(
        df,
        case_col=mapping["case_id_column"],
        activity_col=mapping["activity_column"],
        ts_col=mapping["timestamp_column"],
        min_cases=2,
        min_activities=3,
    )


@respx.mock
@pytest.mark.asyncio
async def test_sap_change_documents_falls_back_to_header_only_on_cdpos_failure(upload_dir):
    respx.get(f"{BASE}/CDHDRSet").mock(return_value=_odata(_HDR_ROWS))
    respx.get(f"{BASE}/CDPOSSet").mock(return_value=httpx.Response(500))

    config = {
        "mode": "change_documents",
        "base_url": BASE,
        "username": "u",
        "password": "p",
    }
    path = await SAPConnector()._fetch_change_documents(config)
    df = pd.read_parquet(path)

    # Header-only: one event per change header, activity from CHANGE_IND.
    assert len(df) == 2
    assert set(df["activity"]) == {"U"}
    assert df["OBJECTID"].notna().all()
