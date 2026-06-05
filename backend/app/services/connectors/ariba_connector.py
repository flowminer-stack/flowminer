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

from app.services.connectors.base import BaseConnector, ConnectorMeta
from app.services.connectors.http_base import (
    ApiKeyAuth,
    CompositeAuth,
    OAuthClientCredentials,
    TokenPaginator,
    paginate,
)
from app.services.connectors.transform import apply_mapping, spec_from_config

logger = logging.getLogger(__name__)
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")


class AribaConnector(BaseConnector):
    meta = ConnectorMeta(
        id="ariba", label="SAP Ariba", category="procurement",
        mapping_mode="auto", supports_incremental=True,
    )

    def _auth(self, config: dict) -> CompositeAuth:
        base = config["base_url"].rstrip("/")
        return CompositeAuth(
            [
                OAuthClientCredentials(
                    token_url=f"{base}/v2/oauth/token",
                    client_id=config["client_id"],
                    client_secret=config["client_secret"],
                ),
                ApiKeyAuth("apiKey", config["api_key"]),
            ]
        )

    async def test_connection(self, config: dict) -> dict:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                await self._auth(config).headers(client)
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
        base = config["base_url"].rstrip("/")
        view = config.get("view", "PurchaseOrderHeader")
        limit = int(config.get("limit", 10000))

        base_params: dict = {"realm": config["realm"]}
        if since is not None:
            try:
                base_params["updatedDateFrom"] = since.isoformat()
            except Exception:
                pass

        async with httpx.AsyncClient(timeout=60) as client:
            headers = {**await self._auth(config).headers(client), "Accept": "application/json"}
            rows = await paginate(
                client,
                f"{base}/api/analytics-reporting-view/v1/views/{view}",
                paginator=TokenPaginator(
                    token_param="pageToken", next_field="PageToken", limit_param="limit"
                ),
                extract=lambda body: body.get("Records", body.get("items", [])),
                headers=headers,
                base_params=base_params,
                page_size=100,
                max_records=limit,
            )

        if not rows:
            raise ValueError("Ariba returned no rows")

        df = pd.DataFrame(rows)
        spec = spec_from_config(config)
        if spec is not None:
            df = apply_mapping(df, spec)
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        dest = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}_ariba_{view}.parquet")
        df.to_parquet(dest, index=False)
        logger.info("Ariba %s → %s (%d rows)", view, dest, len(df))
        return dest

    def get_default_column_mapping(self, config: dict) -> dict | None:
        spec = spec_from_config(config)
        if spec is not None:
            return spec.default_column_mapping()
        # Best-effort default for an Ariba reporting-view header (tenant-tunable);
        # declare `event_timestamps` to unpivot the document lifecycle.
        return {
            "case_id_column": "DocumentNumber",
            "activity_column": "DocumentStatus",
            "timestamp_column": "CreatedDate",
        }
