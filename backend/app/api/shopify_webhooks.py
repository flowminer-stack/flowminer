"""
Shopify webhook ingestion router.

POST /webhooks/shopify/{connector_id}

Shopify sends signed POST requests whenever an order event occurs. This
router:

  1. Looks up the Connector record and verifies it is a Shopify connector
     with a matching app secret (stored in ``connector.config["webhook_secret"]``).
  2. HMAC-verifies the ``X-Shopify-Hmac-Sha256`` header (SHA-256, base64).
  3. Maps the webhook topic (``X-Shopify-Topic``) to a process-mining activity
     name.
  4. Appends the event to the connector's ``sync_state["webhook_buffer"]``
     JSON array so the next scheduled sync can incorporate it without a full
     API backfill.

Design notes
------------
* The connector's ``config["webhook_secret"]`` is the Shopify app's webhook
  signing secret (NOT the access_token).  It should be configured when the
  webhook subscription is registered in Shopify Partner Dashboard / Admin.
* The buffer is a lightweight append-only list.  For high-volume stores the
  operator should reduce the scheduled sync interval (e.g. every 15 min) so
  the buffer does not grow unboundedly.
* The endpoint must return HTTP 200 quickly; Shopify retries on non-2xx
  within 48 h (up to 19 times).  All work is done inline but is O(1).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.connector import Connector, ConnectorStatus, ConnectorType
from app.services.infra.secret_box import decrypt_connector_config

logger = logging.getLogger(__name__)

router = APIRouter()

# ─── Topic → activity mapping ─────────────────────────────────────────────────
#
# Shopify delivers webhooks under dot-separated topic names, e.g.
# "orders/create".  We map the most common order lifecycle topics to human-
# readable activity labels for process mining.  Unknown topics are logged and
# stored with a ``"Webhook: <topic>"`` label so no data is silently dropped.

_TOPIC_TO_ACTIVITY: dict[str, str] = {
    "orders/create":              "Order Placed",
    "orders/updated":             "Order Updated",
    "orders/paid":                "Payment Received",
    "orders/cancelled":           "Order Cancelled",
    "orders/fulfilled":           "Order Fulfilled",
    "orders/partially_fulfilled": "Order Partially Fulfilled",
    "orders/delete":              "Order Deleted",
    "checkouts/create":           "Checkout Started",
    "checkouts/update":           "Checkout Updated",
    "fulfillments/create":        "Fulfillment Created",
    "fulfillments/update":        "Fulfillment Updated",
    "refunds/create":             "Refund Created",
    "draft_orders/create":        "Draft Order Created",
    "draft_orders/update":        "Draft Order Updated",
    "draft_orders/delete":        "Draft Order Deleted",
}


def _topic_to_activity(topic: str) -> str:
    """Resolve a Shopify webhook topic to a process-mining activity name."""
    mapped = _TOPIC_TO_ACTIVITY.get(topic)
    if mapped:
        return mapped
    # Produce a readable default for unmapped topics ("products/create" →
    # "Webhook: products/create") so analysts can see the data even if it
    # hasn't been classified yet.
    return f"Webhook: {topic}"


# ─── HMAC verification ────────────────────────────────────────────────────────


def _verify_shopify_hmac(
    raw_body: bytes,
    shopify_hmac_header: str,
    webhook_secret: str,
) -> bool:
    """Return True iff the HMAC header matches the body.

    Shopify signs the raw request body with HMAC-SHA256 using the webhook
    secret and base64-encodes the digest.
    """
    digest = hmac.new(
        webhook_secret.encode("utf-8"),
        raw_body,
        hashlib.sha256,
    ).digest()
    expected = base64.b64encode(digest).decode()
    # Constant-time comparison to resist timing attacks
    return hmac.compare_digest(expected, shopify_hmac_header)


# ─── Event extraction ─────────────────────────────────────────────────────────


def _extract_event_from_payload(topic: str, payload: dict, received_at: str) -> dict:
    """Build a process-mining event record from a webhook payload.

    We extract the order/object id as the case id, derive the activity from
    the topic, and use the payload's ``updated_at`` / ``created_at`` as the
    event timestamp (falling back to the server's receive time).
    """
    # Order webhooks carry "id"; draft order / checkout webhooks also carry "id".
    case_id = str(payload.get("id", "unknown"))

    # Prefer the object's own timestamp for accurate process chronology
    ts = payload.get("updated_at") or payload.get("created_at") or received_at

    activity = _topic_to_activity(topic)

    # Derive a meaningful resource: the last modifier or the customer
    resource = ""
    customer = payload.get("customer") or {}
    if customer:
        first = customer.get("first_name", "")
        last = customer.get("last_name", "")
        resource = f"{first} {last}".strip()

    return {
        "Order ID":          case_id,
        "Order Number":      str(payload.get("order_number", "")),
        "Activity":          activity,
        "Timestamp":         ts,
        "Resource":          resource,
        "Financial Status":  payload.get("financial_status", ""),
        "Fulfillment Status": payload.get("fulfillment_status", ""),
        "Webhook Topic":     topic,
        "Received At":       received_at,
    }


# ─── Router ───────────────────────────────────────────────────────────────────


@router.post(
    "/{connector_id}",
    status_code=status.HTTP_200_OK,
    summary="Receive a Shopify webhook",
    description=(
        "HMAC-verified Shopify webhook endpoint. "
        "Resolves the connector, verifies the payload signature, maps the "
        "topic to a process-mining activity, and appends the event to the "
        "connector's webhook buffer for incorporation on the next sync."
    ),
    include_in_schema=False,  # not a public API; no auth token required
)
async def receive_shopify_webhook(
    connector_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    x_shopify_hmac_sha256: str = Header(
        ...,
        alias="X-Shopify-Hmac-Sha256",
        description="HMAC-SHA256 of the raw request body, base64-encoded",
    ),
    x_shopify_topic: str = Header(
        ...,
        alias="X-Shopify-Topic",
        description="Webhook topic, e.g. orders/create",
    ),
    x_shopify_shop_domain: Optional[str] = Header(
        default=None,
        alias="X-Shopify-Shop-Domain",
    ),
) -> dict:
    # 1. Load connector (no auth token — webhook is HMAC-authenticated)
    result = await db.execute(select(Connector).where(Connector.id == connector_id))
    connector = result.scalar_one_or_none()

    if connector is None:
        # Return 404 but log; Shopify will retry — avoid amplification by
        # logging only at debug level for unknown connectors.
        logger.debug("Shopify webhook: connector %s not found", connector_id)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Connector not found")

    if connector.connector_type != ConnectorType.shopify:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Connector is not a Shopify connector",
        )

    # 2. Decrypt config and extract the webhook secret
    config = decrypt_connector_config(connector.config or {}) or {}
    webhook_secret: str = config.get("webhook_secret", "").strip()

    if not webhook_secret:
        logger.error(
            "Shopify webhook received for connector %s but 'webhook_secret' is not configured",
            connector_id,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Webhook secret not configured for this connector",
        )

    # 3. Read raw body BEFORE consuming the JSON stream
    raw_body: bytes = await request.body()

    # 4. HMAC verification — reject before touching the payload
    if not _verify_shopify_hmac(raw_body, x_shopify_hmac_sha256, webhook_secret):
        logger.warning(
            "Shopify webhook HMAC mismatch for connector %s (topic=%s shop=%s)",
            connector_id, x_shopify_topic, x_shopify_shop_domain,
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="HMAC verification failed",
        )

    # 5. Parse payload
    try:
        payload: dict = json.loads(raw_body)
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Shopify webhook: malformed JSON for connector %s: %s", connector_id, exc)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Malformed JSON payload",
        )

    # 6. Build the event record
    received_at = datetime.now(timezone.utc).isoformat()
    event = _extract_event_from_payload(x_shopify_topic, payload, received_at)

    logger.info(
        "Shopify webhook: connector=%s topic=%s order_id=%s activity=%s",
        connector_id, x_shopify_topic, event["Order ID"], event["Activity"],
    )

    # 7. Append to the connector's webhook buffer (sync_state["webhook_buffer"])
    #    The buffer is read + merged during the next scheduled sync run.
    sync_state: dict = connector.sync_state or {}
    buffer: list = list(sync_state.get("webhook_buffer", []))
    buffer.append(event)

    # Keep a bounded buffer (latest 10 000 events) to prevent unbounded growth
    # on misconfigured connectors with no scheduled sync.
    if len(buffer) > 10_000:
        buffer = buffer[-10_000:]
        logger.warning(
            "Shopify webhook buffer for connector %s exceeded 10 000 events — "
            "oldest events trimmed. Increase sync frequency.",
            connector_id,
        )

    connector.sync_state = {**sync_state, "webhook_buffer": buffer}

    # SQLAlchemy JSON column mutation detection requires explicit flag
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(connector, "sync_state")

    await db.commit()

    return {"status": "ok", "activity": event["Activity"], "order_id": event["Order ID"]}
