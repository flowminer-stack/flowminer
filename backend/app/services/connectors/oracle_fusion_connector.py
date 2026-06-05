"""Oracle Fusion Cloud Applications connector.

Two modes:
  - BICC (BI Cloud Connector) — bulk extract for historical loads
  - REST API (/fscmRestApi/resources/11.13.18.05/...) — for incremental
    pulls against specific business objects (PurchaseOrders,
    ReceivingReceiptRequests, InvoiceHolds, etc.)

This connector uses the REST path; BICC exports land as CSVs in UCM
and can be picked up with the existing csv_connector.

Config keys:
    base_url: str — e.g. "https://abc-prod.oraclecloud.com"
    username: str — Oracle Fusion user
    password: str — Oracle Fusion password
    resource: str — e.g. "purchaseOrders" or "invoices"
    query: str  — (optional) oData-style filter
    limit: int  — max rows (default 10000)
"""

from __future__ import annotations

import logging
import os
import uuid

import httpx
import pandas as pd

from app.services.connectors.base import BaseConnector, ConnectorMeta
from app.services.connectors.http_base import BasicAuth, OffsetPaginator, paginate
from app.services.connectors.transform import apply_mapping, spec_from_config

logger = logging.getLogger(__name__)
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")


class OracleFusionConnector(BaseConnector):
    meta = ConnectorMeta(
        id="oracle_fusion", label="Oracle Fusion", category="erp",
        mapping_mode="auto", supports_incremental=True,
    )

    async def test_connection(self, config: dict) -> dict:
        base = config["base_url"].rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    f"{base}/fscmRestApi/resources/11.13.18.05",
                    auth=(config["username"], config["password"]),
                    headers={"Accept": "application/json"},
                )
                resp.raise_for_status()
            return {"success": True, "message": "Connected to Oracle Fusion"}
        except Exception as e:
            return {"success": False, "message": str(e)}

    async def get_schema(self, config: dict) -> dict:
        # Fusion catalog is huge; we return a small static list of common
        # business objects. A full implementation would hit
        # /fscmRestApi/resources/11.13.18.05 and parse the catalog.
        return {
            "resources": [
                "purchaseOrders", "invoices", "receivingReceiptRequests",
                "salesOrders", "creditMemos", "paymentTerms",
                "supplierPayments", "expenseReports",
            ]
        }

    async def fetch_data(
        self,
        config: dict,
        column_mapping: dict,
        since=None,
    ) -> str:
        base = config["base_url"].rstrip("/")
        resource = config.get("resource", "purchaseOrders")
        limit = int(config.get("limit", 10000))

        query_parts: list[str] = []
        if config.get("query"):
            query_parts.append(str(config["query"]))
        if since is not None:
            try:
                query_parts.append(f"LastUpdateDate >= '{since.isoformat()}'")
            except Exception:
                pass
        base_params: dict = {}
        if query_parts:
            base_params["q"] = " and ".join(query_parts)

        async with httpx.AsyncClient(timeout=60) as client:
            headers = {
                **await BasicAuth(config["username"], config["password"]).headers(client),
                "Accept": "application/json",
            }
            rows = await paginate(
                client,
                f"{base}/fscmRestApi/resources/11.13.18.05/{resource}",
                # Oracle Fusion exposes a hasMore flag alongside offset/limit.
                paginator=OffsetPaginator("limit", "offset", more_field="hasMore"),
                extract=lambda body: body.get("items", []),
                headers=headers,
                base_params=base_params,
                page_size=500,
                max_records=limit,
            )

        if not rows:
            raise ValueError("Oracle Fusion returned no rows for the configured resource/query")

        df = pd.DataFrame(rows[:limit])
        spec = spec_from_config(config)
        if spec is not None:
            df = apply_mapping(df, spec)
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        dest = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}_oracle_fusion_{resource}.parquet")
        df.to_parquet(dest, index=False)
        logger.info("Oracle Fusion %s → %s (%d rows)", resource, dest, len(df))
        return dest

    def get_default_column_mapping(self, config: dict) -> dict | None:
        spec = spec_from_config(config)
        if spec is not None:
            return spec.default_column_mapping()
        # Best-effort default for a Fusion business object (PO header by
        # default). Tenant-tunable; declare `event_timestamps` for the document
        # lifecycle. Most Fusion REST resources expose CreationDate + a *Number.
        resource = config.get("resource") or "purchaseOrders"
        case_col = "PurchaseOrderNumber" if "purchaseOrders" in resource else "Number"
        return {
            "case_id_column": case_col,
            "activity_column": "Status",
            "timestamp_column": "CreationDate",
        }
