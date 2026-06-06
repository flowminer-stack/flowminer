"""
REST API connector.
Fetches JSON from any URL, handles pagination, and converts the result to CSV.
"""

import asyncio
import logging
import os
import uuid

import httpx
import pandas as pd

from app.services.connectors.base import BaseConnector, ConnectorMeta
from app.services.infra.url_guard import UnsafeUrlError, validate_public_url

logger = logging.getLogger(__name__)

UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")
CONNECTOR_DIR = os.path.join(UPLOAD_DIR, "connectors")

_TIMEOUT = 30  # seconds


def _extract_by_path(data: dict, path: str):
    """
    Traverse a nested dict using dot-notation path.
    E.g. path="data.items" on {"data": {"items": [...]}} returns the list.
    Returns data unchanged if path is empty or falsy.
    """
    if not path:
        return data
    parts = path.split(".")
    current = data
    for part in parts:
        if isinstance(current, dict):
            current = current.get(part)
        else:
            return None
        if current is None:
            return None
    return current


def _build_auth_headers(config: dict) -> dict:
    """Return auth headers derived from ``auth_type`` / ``token`` config keys.

    auth_type values:
      'bearer'  → ``Authorization: Bearer <token>``
      'api_key' → ``<key_header>: <token>``  (key_header defaults to 'X-API-Key')
      'none' / absent → empty dict (no auth header added)
    """
    auth_type = (config.get("auth_type") or "none").lower()
    token = config.get("token", "")

    if auth_type == "bearer" and token:
        return {"Authorization": f"Bearer {token}"}
    if auth_type == "api_key" and token:
        header_name = config.get("key_header", "X-API-Key")
        return {header_name: token}
    return {}


class ApiConnector(BaseConnector):
    """Generic REST API connector with offset/page/cursor pagination support."""

    meta = ConnectorMeta(id="api_endpoint", label="REST API", category="api", mapping_mode="manual")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _single_request(self, client: httpx.AsyncClient, config: dict, extra_params: dict | None = None) -> httpx.Response:
        """Execute one HTTP request, retrying once on HTTP 429.

        The URL is SSRF-validated here — every individual request is
        bounced against the shared guard, so redirect chains cannot
        land us on a private address after the initial check.
        """
        url = validate_public_url(config["url"])
        method = config.get("method", "GET").upper()
        # Merge explicit per-request headers with auth headers; auth wins on collision.
        headers = {**config.get("headers", {}), **_build_auth_headers(config)}
        body = config.get("body", None)
        params = dict(extra_params or {})

        for attempt in range(2):
            if method == "GET":
                response = await client.get(
                    url, headers=headers, params=params, timeout=_TIMEOUT,
                    follow_redirects=False,
                )
            else:
                response = await client.post(
                    url, headers=headers, params=params, json=body, timeout=_TIMEOUT,
                    follow_redirects=False,
                )

            if response.status_code == 429 and attempt == 0:
                retry_after = int(response.headers.get("Retry-After", 5))
                logger.warning(f"ApiConnector: rate limited (429), retrying in {retry_after}s")
                await asyncio.sleep(retry_after)
                continue

            return response

        return response  # return last response even if still 429

    async def _fetch_all_records(self, config: dict) -> list[dict]:
        """Fetch all records, handling pagination transparently."""
        pagination = config.get("pagination") or {}
        pag_type = pagination.get("type", "none")
        data_path = config.get("data_path", "")
        page_size = pagination.get("page_size", 100)

        records: list[dict] = []

        async with httpx.AsyncClient() as client:
            if pag_type == "offset":
                limit_param = pagination.get("limit_param", "limit")
                offset_param = pagination.get("offset_param", "offset")
                offset = 0
                while True:
                    params = {limit_param: page_size, offset_param: offset}
                    resp = await self._single_request(client, config, params)
                    resp.raise_for_status()
                    page_data = _extract_by_path(resp.json(), data_path)
                    if not isinstance(page_data, list) or len(page_data) == 0:
                        break
                    records.extend(page_data)
                    if len(page_data) < page_size:
                        break
                    offset += page_size

            elif pag_type == "page":
                page_param = pagination.get("page_param", "page")
                limit_param = pagination.get("limit_param", "limit")
                page = 1
                while True:
                    params = {page_param: page, limit_param: page_size}
                    resp = await self._single_request(client, config, params)
                    resp.raise_for_status()
                    page_data = _extract_by_path(resp.json(), data_path)
                    if not isinstance(page_data, list) or len(page_data) == 0:
                        break
                    records.extend(page_data)
                    if len(page_data) < page_size:
                        break
                    page += 1

            elif pag_type == "cursor":
                cursor_param = pagination.get("cursor_param", "cursor")
                next_path = pagination.get("next_path", "next_cursor")
                cursor = None
                while True:
                    params = {cursor_param: cursor} if cursor else {}
                    resp = await self._single_request(client, config, params)
                    resp.raise_for_status()
                    body = resp.json()
                    page_data = _extract_by_path(body, data_path)
                    if not isinstance(page_data, list) or len(page_data) == 0:
                        break
                    records.extend(page_data)
                    cursor = _extract_by_path(body, next_path)
                    if not cursor:
                        break

            else:  # "none" or anything else — single request
                resp = await self._single_request(client, config)
                resp.raise_for_status()
                page_data = _extract_by_path(resp.json(), data_path)
                if isinstance(page_data, list):
                    records = page_data
                elif isinstance(page_data, dict):
                    records = [page_data]

        return records

    # ------------------------------------------------------------------
    # BaseConnector interface
    # ------------------------------------------------------------------

    async def test_connection(self, config: dict) -> dict:
        """
        Make one request to the configured URL and check for a successful HTTP status.

        Required config keys: url
        Optional: method, headers, body, data_path
        """
        if not config.get("url"):
            raise ValueError("Config must include 'url'.")

        try:
            async with httpx.AsyncClient() as client:
                resp = await self._single_request(client, config)
            if resp.status_code < 400:
                return {
                    "success": True,
                    "message": f"Connected successfully (HTTP {resp.status_code}).",
                }
            return {
                "success": False,
                "message": f"Server returned HTTP {resp.status_code}: {resp.text[:200]}",
            }
        except Exception as e:
            logger.error(f"ApiConnector.test_connection error: {e}", exc_info=True)
            return {"success": False, "message": f"Connection failed: {e}"}

    async def fetch_data(self, config: dict, column_mapping: dict) -> str:
        """
        Fetch all records from the REST API and save as CSV.

        Required config keys: url
        Optional: method, headers, body, data_path, pagination

        Returns:
            Path to the saved CSV file.
        """
        if not config.get("url"):
            raise ValueError("Config must include 'url'.")

        try:
            records = await self._fetch_all_records(config)
        except Exception as e:
            logger.error(f"ApiConnector.fetch_data error: {e}", exc_info=True)
            raise

        if not records:
            raise ValueError("API returned no records.")

        df = pd.DataFrame(records)

        os.makedirs(CONNECTOR_DIR, exist_ok=True)
        dest_name = f"{uuid.uuid4().hex}_api_export.csv"
        dest_path = os.path.join(CONNECTOR_DIR, dest_name)
        df.to_csv(dest_path, index=False)

        logger.info(
            f"ApiConnector: saved {len(df)} rows to {dest_path}"
        )
        return dest_path

    async def get_schema(self, config: dict) -> dict:
        """
        Infer schema by making one request and examining the first returned record.

        Required config keys: url
        """
        if not config.get("url"):
            raise ValueError("Config must include 'url'.")

        try:
            async with httpx.AsyncClient() as client:
                resp = await self._single_request(client, config)
                resp.raise_for_status()

            body = resp.json()
            data_path = config.get("data_path", "")
            data = _extract_by_path(body, data_path)

            if isinstance(data, list) and len(data) > 0:
                first = data[0]
            elif isinstance(data, dict):
                first = data
            else:
                return {"tables": [{"name": "response", "columns": []}]}

            columns = [{"name": k, "type": type(v).__name__} for k, v in first.items()]
            return {
                "tables": [
                    {
                        "name": config.get("url"),
                        "columns": columns,
                    }
                ]
            }
        except Exception as e:
            logger.error(f"ApiConnector.get_schema error: {e}", exc_info=True)
            raise
