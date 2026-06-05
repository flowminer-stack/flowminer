"""Workday connector — extract HCM / Financials event data via REST API.

Workday exposes many report-as-a-service and RaaS endpoints; we use
the generic REST path /ccx/api/v1/{tenant}/{endpoint}. Auth is
OAuth2 client credentials.

Config keys:
    tenant: str — Workday tenant short name
    base_url: str — e.g. "https://wd1-impl-services1.workday.com"
    client_id: str
    client_secret: str
    endpoint: str — REST endpoint path (default: "common/v1/workers")
    limit: int — max rows (default: 10000)
"""

from __future__ import annotations

import logging
import os
import uuid

import httpx
import pandas as pd

from app.services.connectors.base import BaseConnector, ConnectorMeta
from app.services.connectors.http_base import (
    OAuthClientCredentials,
    OffsetPaginator,
    paginate,
)

logger = logging.getLogger(__name__)
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")


class WorkdayConnector(BaseConnector):
    meta = ConnectorMeta(
        id="workday", label="Workday", category="hcm",
        mapping_mode="auto", supports_incremental=True,
    )

    def _auth(self, config: dict) -> OAuthClientCredentials:
        base = config["base_url"].rstrip("/")
        return OAuthClientCredentials(
            token_url=f"{base}/ccx/oauth2/{config['tenant']}/token",
            client_id=config["client_id"],
            client_secret=config["client_secret"],
        )

    async def test_connection(self, config: dict) -> dict:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                await self._auth(config).headers(client)
            return {"success": True, "message": "Workday OAuth exchange OK"}
        except Exception as e:
            return {"success": False, "message": str(e)}

    async def get_schema(self, config: dict) -> dict:
        return {
            "endpoints": [
                "common/v1/workers",
                "financialManagement/v1/journals",
                "recruiting/v1/jobRequisitions",
                "talent/v1/talentReviews",
            ]
        }

    async def fetch_data(self, config: dict, column_mapping: dict, since=None) -> str:
        base = config["base_url"].rstrip("/")
        endpoint = config.get("endpoint", "common/v1/workers")
        limit = int(config.get("limit", 10000))

        async with httpx.AsyncClient(timeout=60) as client:
            headers = {
                **await self._auth(config).headers(client),
                "Accept": "application/json",
            }
            rows = await paginate(
                client,
                f"{base}/ccx/api/{endpoint}",
                paginator=OffsetPaginator("limit", "offset"),
                extract=lambda body: body.get("data", []),
                headers=headers,
                page_size=100,
                max_records=limit,
            )

        if not rows:
            raise ValueError("Workday returned no rows")

        df = pd.DataFrame(rows)
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        dest = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}_workday.parquet")
        df.to_parquet(dest, index=False)
        logger.info("Workday %s → %s (%d rows)", endpoint, dest, len(df))
        return dest
