"""Unit tests for the shared HTTP primitives (auth, pagination, retry)."""

from __future__ import annotations

import httpx
import pytest
import respx

from app.services.connectors.http_base import (
    ApiKeyAuth,
    BasicAuth,
    BearerAuth,
    CompositeAuth,
    OAuthClientCredentials,
    OffsetPaginator,
    TokenPaginator,
    paginate,
    request_with_retries,
)

URL = "https://api.test/items"
TOKEN_URL = "https://api.test/oauth/token"


# ─── retry ────────────────────────────────────────────────────────────────────


@respx.mock
@pytest.mark.asyncio
async def test_request_with_retries_retries_on_429_then_succeeds():
    route = respx.get(URL).mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "0"}),  # 0 -> no real sleep
            httpx.Response(200, json={"ok": True}),
        ]
    )
    async with httpx.AsyncClient() as client:
        resp = await request_with_retries(client, "GET", URL)
    assert resp.status_code == 200
    assert route.call_count == 2


@respx.mock
@pytest.mark.asyncio
async def test_request_with_retries_gives_up_after_max():
    route = respx.get(URL).mock(
        return_value=httpx.Response(503, headers={"Retry-After": "0"})
    )
    async with httpx.AsyncClient() as client:
        resp = await request_with_retries(client, "GET", URL, max_retries=2)
    assert resp.status_code == 503
    assert route.call_count == 3  # initial + 2 retries


# ─── auth ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_static_auth_headers():
    async with httpx.AsyncClient() as c:
        assert await ApiKeyAuth("X-KEY", "abc").headers(c) == {"X-KEY": "abc"}
        assert await BearerAuth("tok").headers(c) == {"Authorization": "Bearer tok"}
        basic = await BasicAuth("u", "p").headers(c)
        assert basic["Authorization"].startswith("Basic ")
        composite = await CompositeAuth(
            [BearerAuth("tok"), ApiKeyAuth("apiKey", "k")]
        ).headers(c)
        assert composite == {"Authorization": "Bearer tok", "apiKey": "k"}


@respx.mock
@pytest.mark.asyncio
async def test_oauth_client_credentials_fetches_and_caches_token():
    route = respx.post(TOKEN_URL).mock(
        return_value=httpx.Response(200, json={"access_token": "T0", "expires_in": 3600})
    )
    auth = OAuthClientCredentials(TOKEN_URL, "cid", "csecret")
    async with httpx.AsyncClient() as client:
        h1 = await auth.headers(client)
        h2 = await auth.headers(client)  # cached — no second token request
    assert h1 == {"Authorization": "Bearer T0"} == h2
    assert route.call_count == 1


# ─── pagination ───────────────────────────────────────────────────────────────


def _offset_pages(all_rows, page_size, wrapper):
    def _se(request):
        off = int(request.url.params.get("offset", 0))
        chunk = all_rows[off : off + page_size]
        return httpx.Response(200, json=wrapper(chunk, off, page_size, len(all_rows)))
    return _se


@respx.mock
@pytest.mark.asyncio
async def test_offset_paginator_collects_all_pages():
    rows = [{"id": i} for i in range(250)]
    respx.get(URL).mock(
        side_effect=_offset_pages(rows, 100, lambda c, *_: {"data": c})
    )
    async with httpx.AsyncClient() as client:
        got = await paginate(
            client, URL,
            paginator=OffsetPaginator("limit", "offset"),
            extract=lambda b: b.get("data", []),
            page_size=100, max_records=10000,
        )
    assert [r["id"] for r in got] == list(range(250))


@respx.mock
@pytest.mark.asyncio
async def test_paginate_respects_max_records():
    rows = [{"id": i} for i in range(250)]
    respx.get(URL).mock(side_effect=_offset_pages(rows, 100, lambda c, *_: {"data": c}))
    async with httpx.AsyncClient() as client:
        got = await paginate(
            client, URL,
            paginator=OffsetPaginator("limit", "offset"),
            extract=lambda b: b.get("data", []),
            page_size=100, max_records=120,
        )
    assert len(got) == 120


@respx.mock
@pytest.mark.asyncio
async def test_offset_paginator_stops_on_more_field_false():
    rows = [{"id": i} for i in range(80)]

    def wrapper(chunk, off, size, total):
        return {"items": chunk, "hasMore": off + len(chunk) < total}

    route = respx.get(URL).mock(side_effect=_offset_pages(rows, 100, wrapper))
    async with httpx.AsyncClient() as client:
        got = await paginate(
            client, URL,
            paginator=OffsetPaginator("limit", "offset", more_field="hasMore"),
            extract=lambda b: b.get("items", []),
            page_size=100, max_records=10000,
        )
    assert len(got) == 80
    assert route.call_count == 1  # hasMore=False on the only page -> no extra request


@respx.mock
@pytest.mark.asyncio
async def test_token_paginator_follows_cursor():
    pages = [[{"id": 0}, {"id": 1}], [{"id": 2}, {"id": 3}], [{"id": 4}]]

    def _se(request):
        tok = request.url.params.get("pageToken")
        idx = int(tok) if tok else 0
        body = {"Records": pages[idx]}
        if idx + 1 < len(pages):
            body["PageToken"] = str(idx + 1)
        return httpx.Response(200, json=body)

    respx.get(URL).mock(side_effect=_se)
    async with httpx.AsyncClient() as client:
        got = await paginate(
            client, URL,
            paginator=TokenPaginator("pageToken", "PageToken", "limit"),
            extract=lambda b: b.get("Records", []),
            page_size=100, max_records=10000,
        )
    assert [r["id"] for r in got] == [0, 1, 2, 3, 4]
