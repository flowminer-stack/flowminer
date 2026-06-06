"""
Shopify connector.

Extracts order lifecycle events from the Shopify Admin REST API (API version
2024-01). Each Shopify order maps to one process-mining case; lifecycle
milestones derived from order timestamps (created, paid, fulfilled, delivered,
cancelled, refunded) become individual activity events.

Config keys
-----------
shop_domain : str
    The myshopify.com subdomain, e.g. ``"acme"`` → acme.myshopify.com.
    A full hostname (acme.myshopify.com) is also accepted.
access_token : str
    Shopify Admin API access token (private app or custom app with
    read_orders scope).  Treated as a secret — never echoed back.
lookback_days : int, optional
    Number of days to backfill on a first-ever sync (default 90).
max_orders : int, optional
    Hard cap on orders fetched per sync run (default 5 000).
incremental_overlap_minutes : int, optional
    Extra minutes to rewind the high-watermark cursor (default 10).
    Handled by the shared incremental machinery; not Shopify-specific.
"""

from __future__ import annotations

import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
import pandas as pd

from app.services.connectors.base import BaseConnector, ConnectorMeta
from app.services.connectors.http_base import (
    ApiKeyAuth,
    TokenPaginator,
    paginate,
    request_with_retries,
)
from app.services.infra.url_guard import validate_public_url

logger = logging.getLogger(__name__)

UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")
CONNECTOR_DIR = os.path.join(UPLOAD_DIR, "connectors")

_API_VERSION = "2024-01"
_PAGE_SIZE = 250  # Shopify max per page
_DEFAULT_LOOKBACK_DAYS = 90
_DEFAULT_MAX_ORDERS = 5_000
_TIMEOUT = 30

# Strict allowlist: myshopify.com only (or myshopify.com subdomain).
# Prevents SSRF via user-supplied shop_domain pointing at internal hosts.
_SHOPIFY_DOMAIN_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9\-]{0,61}(\.myshopify\.com)?$"
)


def _normalise_shop_domain(raw: str) -> str:
    """Return the canonical myshopify.com hostname.

    Accepts ``"acme"``, ``"acme.myshopify.com"``, or
    ``"https://acme.myshopify.com"`` and always returns
    ``"acme.myshopify.com"``.
    """
    domain = raw.strip().lower().removeprefix("https://").removeprefix("http://").rstrip("/")
    if not domain:
        raise ValueError("Config must include a non-empty 'shop_domain'.")
    if not _SHOPIFY_DOMAIN_RE.match(domain):
        raise ValueError(
            f"Invalid Shopify shop_domain: {domain!r}. "
            "Expected a bare subdomain (e.g. 'acme') or 'acme.myshopify.com'."
        )
    if not domain.endswith(".myshopify.com"):
        domain = f"{domain}.myshopify.com"
    return domain


def _base_url(shop_domain: str) -> str:
    """Return the SSRF-validated Admin API base URL for ``shop_domain``."""
    url = f"https://{shop_domain}/admin/api/{_API_VERSION}"
    validate_public_url(url)
    return url


def _make_auth(config: dict) -> ApiKeyAuth:
    access_token = config.get("access_token", "").strip()
    if not access_token:
        raise ValueError("Config must include 'access_token'.")
    return ApiKeyAuth("X-Shopify-Access-Token", access_token)


# ─── Activity mapping ─────────────────────────────────────────────────────────
#
# Shopify orders don't have an explicit event log; we reconstruct one from the
# timestamp fields present on each order object and its fulfillments.  Each
# non-null timestamp that is later than the order's created_at yields one event.

_ISO_FMT = "%Y-%m-%dT%H:%M:%S%z"


def _parse_ts(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except (ValueError, TypeError):
        return None


def _extract_events(order: dict) -> list[dict]:
    """Derive process-mining event rows from a single Shopify order object."""
    order_id = str(order["id"])
    order_number = str(order.get("order_number", order_id))
    customer = (order.get("customer") or {})
    customer_name = customer.get("first_name", "")
    financial_status = order.get("financial_status") or ""
    fulfillment_status = order.get("fulfillment_status") or ""

    events: list[dict] = []

    def _add(activity: str, ts: Optional[str], resource: str = "") -> None:
        parsed = _parse_ts(ts)
        if parsed is None:
            return
        events.append({
            "Order ID":          order_id,
            "Order Number":      order_number,
            "Activity":          activity,
            "Timestamp":         parsed.isoformat(),
            "Resource":          resource,
            "Financial Status":  financial_status,
            "Fulfillment Status": fulfillment_status,
        })

    # Core lifecycle timestamps on the order itself
    _add("Order Placed",   order.get("created_at"),    customer_name)
    _add("Order Updated",  order.get("updated_at"),    customer_name)
    _add("Payment Received", order.get("processed_at"), customer_name)

    # Financial transitions inferred from the current status + closed_at
    if financial_status == "paid" and order.get("processed_at"):
        pass  # already captured as "Payment Received"
    if financial_status == "refunded" and order.get("closed_at"):
        _add("Refunded", order.get("closed_at"), customer_name)
    if financial_status == "partially_refunded" and order.get("closed_at"):
        _add("Partially Refunded", order.get("closed_at"), customer_name)

    # Cancellation
    if order.get("cancelled_at"):
        _add("Order Cancelled", order.get("cancelled_at"), customer_name)

    # Fulfillment events — each fulfillment produces shipping milestones
    for ful in order.get("fulfillments", []):
        tracking_company = ful.get("tracking_company") or ""
        _add("Fulfillment Created", ful.get("created_at"),  tracking_company)
        _add("Shipment Sent",       ful.get("updated_at"),  tracking_company)

        # If all items are delivered the fulfillment status is "success"
        if ful.get("status") == "success":
            _add("Delivered",       ful.get("updated_at"),  tracking_company)

    # Order closed (archived)
    if order.get("closed_at"):
        _add("Order Closed", order.get("closed_at"), customer_name)

    # Deduplicate: same (activity, timestamp) pairs can occur when "Order Updated"
    # overlaps with another milestone.
    seen: set[tuple] = set()
    unique: list[dict] = []
    for e in events:
        key = (e["Activity"], e["Timestamp"])
        if key not in seen:
            seen.add(key)
            unique.append(e)

    # Sort chronologically within a case
    unique.sort(key=lambda e: e["Timestamp"])
    return unique


# ─── Connector class ───────────────────────────────────────────────────────────


class ShopifyConnector(BaseConnector):
    """Connector for Shopify — backfills order lifecycle events via Admin REST."""

    meta = ConnectorMeta(
        id="shopify",
        label="Shopify",
        category="other",  # ecommerce; closest bucket in the current set
        mapping_mode="auto",
        supports_incremental=True,
        produces_event_log=True,
    )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _fetch_orders(
        self,
        client: httpx.AsyncClient,
        base_url: str,
        auth: ApiKeyAuth,
        *,
        since: Optional[datetime],
        max_orders: int,
        lookback_days: int,
    ) -> list[dict]:
        """Page through orders/json, newest-first, until max_orders or exhausted.

        Shopify supports cursor-based pagination via the ``Link`` header
        (``rel="next"``).  We drive it with the generic ``TokenPaginator``
        using the ``page_info`` query parameter which Shopify injects into the
        next URL.

        For incremental runs the ``updated_at_min`` filter is applied so only
        orders touched since the last sync are fetched.
        """
        auth_headers = await auth.headers(client)
        base_params: dict = {
            "status": "any",
            "fields": (
                "id,order_number,created_at,updated_at,processed_at,"
                "closed_at,cancelled_at,financial_status,fulfillment_status,"
                "customer,fulfillments"
            ),
        }

        if since is not None:
            # Shopify uses updated_at_min for incremental filtering
            base_params["updated_at_min"] = since.astimezone(timezone.utc).isoformat()
        else:
            # First-ever sync: use lookback window
            cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
            base_params["created_at_min"] = cutoff.isoformat()

        # Shopify cursor pagination: ``page_info`` is injected by the platform
        # as a query param in the Link rel="next" URL.  We can't use our
        # standard TokenPaginator because the token lives in a header, not the
        # body. Drive manually instead.
        orders: list[dict] = []
        next_url: Optional[str] = f"{base_url}/orders.json"
        first_page = True

        while next_url and len(orders) < max_orders:
            remaining = max_orders - len(orders)
            params: dict = {**base_params, "limit": min(_PAGE_SIZE, remaining)}
            if not first_page:
                # On subsequent pages the page_info token is embedded in
                # next_url; send no other params except limit.
                params = {"limit": min(_PAGE_SIZE, remaining)}

            resp = await request_with_retries(
                client, "GET", next_url,
                headers={**auth_headers, "Accept": "application/json"},
                params=params,
                timeout=_TIMEOUT,
            )
            resp.raise_for_status()
            body = resp.json()
            page = body.get("orders", [])
            orders.extend(page)

            # Parse Link header for next cursor
            next_url = None
            link_header = resp.headers.get("Link", "")
            for part in link_header.split(","):
                part = part.strip()
                if 'rel="next"' in part:
                    raw_url = part.split(";")[0].strip().strip("<>")
                    # SSRF guard: next URL must stay on myshopify.com
                    try:
                        next_url = validate_public_url(raw_url)
                    except Exception:
                        logger.warning("ShopifyConnector: unsafe next-page URL skipped: %s", raw_url)
                        next_url = None
                    break

            first_page = False
            if not page:
                break

        return orders[:max_orders]

    # ------------------------------------------------------------------
    # BaseConnector interface
    # ------------------------------------------------------------------

    def get_default_column_mapping(self, config: dict) -> dict | None:
        return {
            "case_id_column": "Order ID",
            "activity_column": "Activity",
            "timestamp_column": "Timestamp",
            "resource_column": "Resource",
        }

    async def test_connection(self, config: dict) -> dict:
        """Verify credentials by calling the shop endpoint (GET /shop.json).

        Required config keys: shop_domain, access_token
        """
        try:
            shop_domain = _normalise_shop_domain(config.get("shop_domain", ""))
            auth = _make_auth(config)
            base_url = _base_url(shop_domain)
            auth_headers = {}
            async with httpx.AsyncClient() as client:
                auth_headers = await auth.headers(client)
                resp = await request_with_retries(
                    client, "GET", f"{base_url}/shop.json",
                    headers={**auth_headers, "Accept": "application/json"},
                    timeout=_TIMEOUT,
                )
            if resp.status_code == 200:
                shop_name = resp.json().get("shop", {}).get("name", shop_domain)
                return {"success": True, "message": f"Connected to Shopify store '{shop_name}'."}
            return {
                "success": False,
                "message": f"Shopify API returned HTTP {resp.status_code}.",
            }
        except Exception as exc:
            logger.error("ShopifyConnector.test_connection error: %s", exc, exc_info=True)
            return {"success": False, "message": f"Connection failed: {exc}"}

    async def fetch_data(
        self,
        config: dict,
        column_mapping: dict,
        since: Optional[datetime] = None,
    ) -> str:
        """Backfill / incremental fetch of Shopify order lifecycle events.

        Required config keys: shop_domain, access_token
        Optional: lookback_days (default 90), max_orders (default 5 000)

        Returns the path to the saved CSV file.
        """
        shop_domain = _normalise_shop_domain(config.get("shop_domain", ""))
        auth = _make_auth(config)
        base_url = _base_url(shop_domain)
        lookback_days = int(config.get("lookback_days", _DEFAULT_LOOKBACK_DAYS) or _DEFAULT_LOOKBACK_DAYS)
        max_orders = int(config.get("max_orders", _DEFAULT_MAX_ORDERS) or _DEFAULT_MAX_ORDERS)

        try:
            async with httpx.AsyncClient() as client:
                orders = await self._fetch_orders(
                    client, base_url, auth,
                    since=since,
                    max_orders=max_orders,
                    lookback_days=lookback_days,
                )
        except Exception as exc:
            logger.error("ShopifyConnector.fetch_data error: %s", exc, exc_info=True)
            raise

        if not orders:
            raise ValueError(
                f"No orders found for Shopify store '{shop_domain}' "
                f"({'since ' + since.isoformat() if since else f'last {lookback_days} days'})."
            )

        all_events: list[dict] = []
        for order in orders:
            all_events.extend(_extract_events(order))

        if not all_events:
            raise ValueError(f"Orders found but no lifecycle events could be derived for '{shop_domain}'.")

        df = pd.DataFrame(all_events)
        os.makedirs(CONNECTOR_DIR, exist_ok=True)
        dest_name = f"{uuid.uuid4().hex}_shopify_export.csv"
        dest_path = os.path.join(CONNECTOR_DIR, dest_name)
        df.to_csv(dest_path, index=False)

        logger.info(
            "ShopifyConnector: saved %d events from %d orders to %s",
            len(df), len(orders), dest_path,
        )
        return dest_path

    async def get_schema(self, config: dict) -> dict:
        """Return the fixed column schema for Shopify event exports."""
        columns = [
            {"name": "Order ID",           "type": "string"},
            {"name": "Order Number",        "type": "string"},
            {"name": "Activity",            "type": "string"},
            {"name": "Timestamp",           "type": "datetime"},
            {"name": "Resource",            "type": "string"},
            {"name": "Financial Status",    "type": "string"},
            {"name": "Fulfillment Status",  "type": "string"},
        ]
        shop = config.get("shop_domain", "")
        try:
            shop = _normalise_shop_domain(shop)
        except ValueError:
            pass
        return {"tables": [{"name": f"{shop} Orders", "columns": columns}]}
