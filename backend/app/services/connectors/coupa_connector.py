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

        rows: list[dict] = []
        offset = 0
        async with httpx.AsyncClient(timeout=60) as client:
            while len(rows) < limit:
                params = {"limit": min(limit - len(rows), 100), "offset": offset}
                if since is not None:
                    try:
                        params["updated-at"] = since.isoformat()
                    except Exception:
                        pass
                resp = await client.get(
                    f"{base}/api/{resource}",
                    params=params,
                    headers={
                        "X-COUPA-API-KEY": config["api_key"],
                        "Accept": "application/json",
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, list) or not data:
                    break
                rows.extend(data)
                offset += len(data)

        if not rows:
            raise ValueError("Coupa returned no rows")

        df = pd.DataFrame(rows)
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        dest = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}_coupa_{resource}.parquet")
        df.to_parquet(dest, index=False)
        logger.info("Coupa %s → %s (%d rows)", resource, dest, len(df))
        return dest
