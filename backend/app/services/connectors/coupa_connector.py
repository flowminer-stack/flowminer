"""Coupa connector — extract P2P (requisitions, POs, invoices) via REST API.

Config keys:
    instance_url: str — e.g. "https://your-company.coupahost.com"
    api_key: str
    resource: str — "purchase_orders" | "requisitions" | "invoices" | "approvals"
    limit: int — max rows
"""

from __future__ import annotations

import logging
import os
import uuid

import httpx
import pandas as pd

from app.services.connectors.base import BaseConnector, ConnectorMeta
from app.services.connectors.http_base import ApiKeyAuth, OffsetPaginator, paginate
from app.services.connectors.transform import apply_mapping, spec_from_config

logger = logging.getLogger(__name__)
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")


class CoupaConnector(BaseConnector):
    meta = ConnectorMeta(
        id="coupa", label="Coupa", category="procurement",
        mapping_mode="auto", supports_incremental=True,
    )

    async def test_connection(self, config: dict) -> dict:
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    f"{config['instance_url'].rstrip('/')}/api/purchase_orders",
                    params={"limit": 1},
                    headers={
                        "X-COUPA-API-KEY": config["api_key"],
                        "Accept": "application/json",
                    },
                )
                resp.raise_for_status()
            return {"success": True, "message": "Connected to Coupa"}
        except Exception as e:
            return {"success": False, "message": str(e)}

    async def get_schema(self, config: dict) -> dict:
        return {"resources": ["purchase_orders", "requisitions", "invoices", "approvals", "suppliers"]}

    async def fetch_data(self, config: dict, column_mapping: dict, since=None) -> str:
        base = config["instance_url"].rstrip("/")
        resource = config.get("resource", "purchase_orders")
        limit = int(config.get("limit", 10000))

        base_params: dict = {}
        if since is not None:
            try:
                base_params["updated-at"] = since.isoformat()
            except Exception:
                pass

        async with httpx.AsyncClient(timeout=60) as client:
            headers = {
                **await ApiKeyAuth("X-COUPA-API-KEY", config["api_key"]).headers(client),
                "Accept": "application/json",
            }
            rows = await paginate(
                client,
                f"{base}/api/{resource}",
                paginator=OffsetPaginator("limit", "offset"),
                # Coupa returns a top-level JSON array.
                extract=lambda body: body if isinstance(body, list) else [],
                headers=headers,
                base_params=base_params,
                page_size=100,
                max_records=limit,
            )

        if not rows:
            raise ValueError("Coupa returned no rows")

        df = pd.DataFrame(rows)
        # Opt-in event-log extraction: when the config declares event_timestamps,
        # unpivot the PO lifecycle into a case/activity/timestamp log.
        spec = spec_from_config(config)
        if spec is not None:
            df = apply_mapping(df, spec)
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        dest = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}_coupa_{resource}.parquet")
        df.to_parquet(dest, index=False)
        logger.info("Coupa %s → %s (%d rows)", resource, dest, len(df))
        return dest

    def get_default_column_mapping(self, config: dict) -> dict | None:
        spec = spec_from_config(config)
        if spec is not None:
            return spec.default_column_mapping()
        # Best-effort default for a Coupa header object (id + status + a
        # last-updated timestamp). Tenant-tunable; declare `event_timestamps`
        # in the config to unpivot the full lifecycle into activities instead.
        return {
            "case_id_column": "id",
            "activity_column": "status",
            "timestamp_column": "updated-at",
        }
