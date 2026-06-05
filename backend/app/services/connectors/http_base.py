"""Shared HTTP building blocks for REST connectors.

Connectors used to each re-implement OAuth token exchange, offset/token
pagination loops, and (mostly absent) retry/backoff. These composable
primitives consolidate that:

  * AuthStrategy   — ApiKey / Bearer / Basic / OAuthClientCredentials / Composite
  * Paginator      — Offset / PageNumber / Token, driven by ``paginate()``
  * request_with_retries — 429/5xx exponential backoff honouring Retry-After

No new dependency: the retry helper is a small in-house loop on top of httpx
(deliberately not pulling in tenacity, to keep the sovereign/air-gapped image
lean).
"""

from __future__ import annotations

import asyncio
import base64
import logging
from abc import ABC, abstractmethod
from typing import Any, Callable, Optional

import httpx

logger = logging.getLogger(__name__)

_RETRYABLE = {429, 500, 502, 503, 504}


async def request_with_retries(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    max_retries: int = 3,
    backoff_base: float = 0.5,
    **kwargs: Any,
) -> httpx.Response:
    """Issue a request, retrying on 429/5xx with exponential backoff.

    Honours a numeric ``Retry-After`` header when present. Returns the final
    response (the caller calls ``raise_for_status()``); never raises on status.
    """
    response: Optional[httpx.Response] = None
    for attempt in range(max_retries + 1):
        response = await client.request(method, url, **kwargs)
        if response.status_code in _RETRYABLE and attempt < max_retries:
            retry_after = response.headers.get("Retry-After", "")
            if retry_after.strip().isdigit():
                delay = float(retry_after.strip())
            else:
                delay = backoff_base * (2**attempt)
            logger.warning(
                "HTTP %s on %s — retry %d/%d in %.1fs",
                response.status_code, url, attempt + 1, max_retries, delay,
            )
            if delay > 0:
                await asyncio.sleep(delay)
            continue
        return response
    return response  # type: ignore[return-value]


# ─── Auth strategies ──────────────────────────────────────────────────────────


class AuthStrategy(ABC):
    """Produces the auth headers for a request. OAuth strategies fetch (and
    cache) a token; static strategies just return a header."""

    @abstractmethod
    async def headers(self, client: httpx.AsyncClient) -> dict[str, str]: ...


class NoAuth(AuthStrategy):
    async def headers(self, client: httpx.AsyncClient) -> dict[str, str]:
        return {}


class ApiKeyAuth(AuthStrategy):
    def __init__(self, header_name: str, key: str):
        self.header_name = header_name
        self.key = key

    async def headers(self, client: httpx.AsyncClient) -> dict[str, str]:
        return {self.header_name: self.key}


class BearerAuth(AuthStrategy):
    def __init__(self, token: str):
        self.token = token

    async def headers(self, client: httpx.AsyncClient) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}


class BasicAuth(AuthStrategy):
    def __init__(self, username: str, password: str):
        self.username = username
        self.password = password

    async def headers(self, client: httpx.AsyncClient) -> dict[str, str]:
        raw = f"{self.username}:{self.password}".encode()
        return {"Authorization": "Basic " + base64.b64encode(raw).decode()}


class CompositeAuth(AuthStrategy):
    """Merge several strategies' headers (e.g. OAuth Bearer + an apiKey header)."""

    def __init__(self, strategies: list[AuthStrategy]):
        self.strategies = strategies

    async def headers(self, client: httpx.AsyncClient) -> dict[str, str]:
        merged: dict[str, str] = {}
        for s in self.strategies:
            merged.update(await s.headers(client))
        return merged


class OAuthClientCredentials(AuthStrategy):
    """OAuth2 client-credentials grant. Caches the token for its lifetime.

    ``auth_style="basic"`` sends client_id/secret as HTTP Basic (Workday,
    Ariba); ``"body"`` sends them in the form body.
    """

    def __init__(
        self,
        token_url: str,
        client_id: str,
        client_secret: str,
        *,
        auth_style: str = "basic",
        extra_data: Optional[dict[str, str]] = None,
        token_field: str = "access_token",
    ):
        self.token_url = token_url
        self.client_id = client_id
        self.client_secret = client_secret
        self.auth_style = auth_style
        self.extra_data = extra_data or {}
        self.token_field = token_field
        self._token: Optional[str] = None
        self._expires_at: float = 0.0
        self._lock = asyncio.Lock()

    async def headers(self, client: httpx.AsyncClient) -> dict[str, str]:
        async with self._lock:
            loop_now = asyncio.get_event_loop().time()
            if self._token is None or loop_now >= self._expires_at:
                await self._refresh(client, loop_now)
        return {"Authorization": f"Bearer {self._token}"}

    async def _refresh(self, client: httpx.AsyncClient, now: float) -> None:
        data = {"grant_type": "client_credentials", **self.extra_data}
        kwargs: dict[str, Any] = {"data": data}
        if self.auth_style == "basic":
            kwargs["auth"] = (self.client_id, self.client_secret)
        else:
            data["client_id"] = self.client_id
            data["client_secret"] = self.client_secret
        resp = await request_with_retries(client, "POST", self.token_url, **kwargs)
        resp.raise_for_status()
        body = resp.json()
        self._token = body[self.token_field]
        # Refresh a minute early; default to a short TTL if not supplied.
        ttl = float(body.get("expires_in", 300))
        self._expires_at = now + max(ttl - 60, 30)


# ─── Pagination ───────────────────────────────────────────────────────────────


class Paginator(ABC):
    """Computes per-request query params. ``first`` is the opening page;
    ``advance`` returns params for the next page (or None to stop). ``paginate``
    also stops when a page returns no records."""

    @abstractmethod
    def first(self, page_limit: int) -> dict[str, Any]: ...

    @abstractmethod
    def advance(
        self, fetched: int, page_limit: int, body: Any, records: list
    ) -> Optional[dict[str, Any]]: ...


class OffsetPaginator(Paginator):
    def __init__(
        self,
        limit_param: str = "limit",
        offset_param: str = "offset",
        *,
        more_field: Optional[str] = None,
    ):
        self.limit_param = limit_param
        self.offset_param = offset_param
        self.more_field = more_field  # e.g. Oracle Fusion's "hasMore"

    def first(self, page_limit: int) -> dict[str, Any]:
        return {self.limit_param: page_limit, self.offset_param: 0}

    def advance(self, fetched, page_limit, body, records):
        if self.more_field and isinstance(body, dict) and not body.get(self.more_field):
            return None
        return {self.limit_param: page_limit, self.offset_param: fetched}


class PageNumberPaginator(Paginator):
    def __init__(self, page_param: str = "page", size_param: str = "limit", start: int = 1):
        self.page_param = page_param
        self.size_param = size_param
        self.start = start
        self._page = start

    def first(self, page_limit: int) -> dict[str, Any]:
        self._page = self.start
        return {self.page_param: self._page, self.size_param: page_limit}

    def advance(self, fetched, page_limit, body, records):
        self._page += 1
        return {self.page_param: self._page, self.size_param: page_limit}


class TokenPaginator(Paginator):
    """Cursor/token pagination: the next-page token is read from the response
    body (``next_field``) and sent back as ``token_param``."""

    def __init__(self, token_param: str, next_field: str, limit_param: str = "limit"):
        self.token_param = token_param
        self.next_field = next_field
        self.limit_param = limit_param

    def first(self, page_limit: int) -> dict[str, Any]:
        return {self.limit_param: page_limit}

    def advance(self, fetched, page_limit, body, records):
        token = body.get(self.next_field) if isinstance(body, dict) else None
        if not token:
            return None
        return {self.limit_param: page_limit, self.token_param: token}


async def paginate(
    client: httpx.AsyncClient,
    url: str,
    *,
    paginator: Paginator,
    extract: Callable[[Any], list],
    headers: Optional[dict[str, str]] = None,
    base_params: Optional[dict[str, Any]] = None,
    page_size: int = 100,
    max_records: int = 10000,
) -> list[dict]:
    """Drive a paginated GET until ``max_records`` or the source is exhausted.

    ``extract`` maps a response body to its list of records (handles the
    top-level-list vs nested-under-"data"/"Records"/"items" variations).
    """
    base_params = dict(base_params or {})
    rows: list[dict] = []
    page_limit = max(min(page_size, max_records), 1)
    params = {**base_params, **paginator.first(page_limit)}

    while True:
        resp = await request_with_retries(client, "GET", url, headers=headers, params=params)
        resp.raise_for_status()
        body = resp.json()
        records = extract(body) or []
        rows.extend(records)
        if len(rows) >= max_records:
            return rows[:max_records]
        if not records:
            return rows
        page_limit = max(min(page_size, max_records - len(rows)), 1)
        nxt = paginator.advance(len(rows), page_limit, body, records)
        if nxt is None:
            return rows
        params = {**base_params, **nxt}
