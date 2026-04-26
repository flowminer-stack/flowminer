"""SAP Ariba connector — extract sourcing / procurement events via REST API.

Uses Ariba's Operational Reporting API. OAuth2 client-credentials flow.

Config keys:
    base_url: str — e.g. "https://openapi.ariba.com"
    realm: str — Ariba realm
    client_id: str
    client_secret: str
    api_key: str — Application key
    view: str — e.g. "PurchaseOrderHeader" or "InvoiceHeader"
    limit: int
"""

from __future__ import annotations

import logging
import os
import uuid

import httpx
import pandas as pd

from app.services.connectors.base import BaseConnector

logger = logging.getLogger(__name__)
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")


class AribaConnector(BaseConnector):
    async def _get_token(self, config: dict) -> str:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{config['base_url'].rstrip('/')}/v2/oauth/token",
                data={"grant_type": "client_credentials"},
                auth=(config["client_id"], config["client_secret"]),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            resp.raise_for_status()
            return resp.json()["access_token"]

    async def test_connection(self, config: dict) -> dict:
        try:
            await self._get_token(config)
            return {"success": True, "message": "Ariba OAuth exchange OK"}
        except Exception as e:
            return {"success": False, "message": str(e)}

    async def get_schema(self, config: dict) -> dict:
        return {
            "views": [
                "PurchaseOrderHeader",
                "PurchaseOrderItem",
                "InvoiceHeader",
                "InvoiceItem",
                "ContractHeader",
                "SupplierHeader",
            ]
        }

    async def fetch_data(self, config: dict, column_mapping: dict, since=None) -> str:
        token = await self._get_token(config)
        base = config["base_url"].rstrip("/")
        realm = config["realm"]
        view = config.get("view", "PurchaseOrderHeader")
        limit = int(config.get("limit", 10000))

        rows: list[dict] = []
        page_token: str | None = None
        async with httpx.AsyncClient(timeout=60) as client:
            while len(rows) < limit:
                params: dict[str, str] = {"realm": realm, "limit": str(min(limit - len(rows), 100))}
                if page_token:
                    params["pageToken"] = page_token
                if since is not None:
                    try:
                        params["updatedDateFrom"] = since.isoformat()
                    except Exception:
                        pass
                resp = await client.get(
                    f"{base}/api/analytics-reporting-view/v1/views/{view}",
                    params=params,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "apiKey": config["api_key"],
                        "Accept": "application/json",
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                records = data.get("Records", data.get("items", []))
                if not records:
                    break
                rows.extend(records)
                page_token = data.get("PageToken")
                if not page_token:
                    break

        if not rows:
            raise ValueError("Ariba returned no rows")

        df = pd.DataFrame(rows)
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        dest = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}_ariba_{view}.parquet")
        df.to_parquet(dest, index=False)
        logger.info("Ariba %s → %s (%d rows)", view, dest, len(df))
        return dest
