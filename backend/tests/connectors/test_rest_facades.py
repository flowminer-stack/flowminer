"""Integration tests for the REST connectors migrated onto the shared HTTP
primitives (Workday / Coupa / Ariba / Oracle Fusion). respx mocks the source so
each connector's fetch_data is exercised end-to-end (auth + pagination + parquet
write) with no live system.
"""

from __future__ import annotations

import httpx
import pandas as pd
import pytest
import respx

from app.services.connectors.ariba_connector import AribaConnector
from app.services.connectors.coupa_connector import CoupaConnector
from app.services.connectors.oracle_fusion_connector import OracleFusionConnector
from app.services.connectors.workday_connector import WorkdayConnector


def _offset_serve(all_rows, *, key, page_size, more_field=None):
    """respx side_effect serving offset pages; `key=None` -> top-level list."""

    def _se(request):
        off = int(request.url.params.get("offset", 0))
        chunk = all_rows[off : off + page_size]
        if key is None:
            return httpx.Response(200, json=chunk)
        body = {key: chunk}
        if more_field:
            body[more_field] = off + len(chunk) < len(all_rows)
        return httpx.Response(200, json=body)

    return _se


@respx.mock
@pytest.mark.asyncio
async def test_workday_fetch(upload_dir):
    rows = [{"id": i, "name": f"w{i}"} for i in range(5)]
    respx.post("https://wd.test/ccx/oauth2/t/token").mock(
        return_value=httpx.Response(200, json={"access_token": "T", "expires_in": 3600})
    )
    respx.get("https://wd.test/ccx/api/common/v1/workers").mock(
        side_effect=_offset_serve(rows, key="data", page_size=100)
    )
    config = {
        "base_url": "https://wd.test",
        "tenant": "t",
        "client_id": "c",
        "client_secret": "s",
        "endpoint": "common/v1/workers",
        "limit": 1000,
    }
    path = await WorkdayConnector().fetch_data(config, {})
    df = pd.read_parquet(path)
    assert len(df) == 5 and list(df["name"]) == [f"w{i}" for i in range(5)]


@respx.mock
@pytest.mark.asyncio
async def test_coupa_fetch_top_level_list(upload_dir):
    rows = [{"id": i} for i in range(3)]
    respx.get("https://coupa.test/api/purchase_orders").mock(
        side_effect=_offset_serve(rows, key=None, page_size=100)
    )
    config = {"instance_url": "https://coupa.test", "api_key": "k", "resource": "purchase_orders", "limit": 1000}
    path = await CoupaConnector().fetch_data(config, {})
    df = pd.read_parquet(path)
    assert len(df) == 3


@respx.mock
@pytest.mark.asyncio
async def test_oracle_fusion_fetch_stops_on_hasmore(upload_dir):
    rows = [{"PurchaseOrderNumber": f"PO{i}", "Status": "OPEN"} for i in range(4)]
    route = respx.get(
        "https://ofusion.test/fscmRestApi/resources/11.13.18.05/purchaseOrders"
    ).mock(side_effect=_offset_serve(rows, key="items", page_size=500, more_field="hasMore"))
    config = {
        "base_url": "https://ofusion.test",
        "username": "u",
        "password": "p",
        "resource": "purchaseOrders",
        "limit": 1000,
    }
    path = await OracleFusionConnector().fetch_data(config, {})
    df = pd.read_parquet(path)
    assert len(df) == 4
    assert route.call_count == 1  # hasMore=False -> single request


@respx.mock
@pytest.mark.asyncio
async def test_ariba_fetch_follows_page_token(upload_dir):
    pages = [[{"id": 0}, {"id": 1}], [{"id": 2}]]

    def _se(request):
        tok = request.url.params.get("pageToken")
        idx = int(tok) if tok else 0
        body = {"Records": pages[idx]}
        if idx + 1 < len(pages):
            body["PageToken"] = str(idx + 1)
        return httpx.Response(200, json=body)

    respx.post("https://ariba.test/v2/oauth/token").mock(
        return_value=httpx.Response(200, json={"access_token": "T", "expires_in": 3600})
    )
    respx.get(
        "https://ariba.test/api/analytics-reporting-view/v1/views/PurchaseOrderHeader"
    ).mock(side_effect=_se)
    config = {
        "base_url": "https://ariba.test",
        "realm": "r",
        "client_id": "c",
        "client_secret": "s",
        "api_key": "k",
        "view": "PurchaseOrderHeader",
        "limit": 1000,
    }
    path = await AribaConnector().fetch_data(config, {})
    df = pd.read_parquet(path)
    assert [int(x) for x in df["id"]] == [0, 1, 2]


@respx.mock
@pytest.mark.asyncio
async def test_ariba_sends_bearer_and_apikey_headers(upload_dir):
    """The Composite auth must send both the OAuth Bearer and the apiKey header."""
    captured = {}

    respx.post("https://ariba.test/v2/oauth/token").mock(
        return_value=httpx.Response(200, json={"access_token": "T", "expires_in": 3600})
    )

    def _se(request):
        captured["auth"] = request.headers.get("Authorization")
        captured["apiKey"] = request.headers.get("apiKey")
        return httpx.Response(200, json={"Records": [{"id": 1}]})

    respx.get(
        "https://ariba.test/api/analytics-reporting-view/v1/views/PurchaseOrderHeader"
    ).mock(side_effect=_se)
    config = {
        "base_url": "https://ariba.test",
        "realm": "r",
        "client_id": "c",
        "client_secret": "s",
        "api_key": "APPKEY",
        "limit": 1000,
    }
    await AribaConnector().fetch_data(config, {})
    assert captured["auth"] == "Bearer T"
    assert captured["apiKey"] == "APPKEY"


@respx.mock
@pytest.mark.asyncio
async def test_coupa_melt_extracts_event_log(upload_dir):
    """With event_timestamps configured, Coupa's raw POs are unpivoted into a
    case/activity/timestamp event log via the transform engine (Phase 6)."""
    pos = [
        {"id": "PO1", "created-at": "2026-01-01", "approved-at": "2026-01-02"},
        {"id": "PO2", "created-at": "2026-01-03", "approved-at": None},
    ]
    respx.get("https://coupa.test/api/purchase_orders").mock(
        side_effect=_offset_serve(pos, key=None, page_size=100)
    )
    config = {
        "instance_url": "https://coupa.test",
        "api_key": "k",
        "resource": "purchase_orders",
        "limit": 1000,
        "case_id_field": "id",
        "event_timestamps": [
            {"column": "created-at", "activity": "Created"},
            {"column": "approved-at", "activity": "Approved"},
        ],
    }
    conn = CoupaConnector()
    path = await conn.fetch_data(config, {})
    df = pd.read_parquet(path)
    # PO1 -> Created + Approved, PO2 -> Created (approved-at is null, dropped) = 3
    assert len(df) == 3
    assert set(df["case_id"]) == {"PO1", "PO2"}
    assert set(df["activity"]) == {"Created", "Approved"}
    # the default mapping now points at the canonical melted columns
    m = conn.get_default_column_mapping(config)
    assert m["case_id_column"] == "case_id" and m["timestamp_column"] == "timestamp"
