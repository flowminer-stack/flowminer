"""
Salesforce connector: extract event data from Salesforce CRM via REST API.

Config keys:
    - instance_url: str — e.g., "https://yourorg.my.salesforce.com"
    - access_token: str — OAuth bearer token (or use client_id/client_secret/refresh_token)
    - client_id: str — OAuth client ID
    - client_secret: str — OAuth client secret
    - refresh_token: str — OAuth refresh token
    - soql_query: str — SOQL query to extract event data
    - object_type: str — Salesforce object (e.g., "Case", "Opportunity", "Task")
"""

import logging
import os
import uuid

import httpx
import pandas as pd

from app.services.connectors.base import BaseConnector, ConnectorMeta
from app.services.connectors.http_base import request_with_retries

logger = logging.getLogger(__name__)
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")


class SalesforceConnector(BaseConnector):

    meta = ConnectorMeta(id="salesforce", label="Salesforce", category="crm", mapping_mode="auto", supports_write_back=True, write_back_label="Create Salesforce record")

    def _get_token(self, config: dict) -> tuple[str, str]:
        """Get access token, refreshing if needed."""
        if config.get("access_token"):
            return config["instance_url"], config["access_token"]

        # OAuth refresh flow
        resp = httpx.post(f"{config['instance_url']}/services/oauth2/token", data={
            "grant_type": "refresh_token",
            "client_id": config["client_id"],
            "client_secret": config["client_secret"],
            "refresh_token": config["refresh_token"],
        })
        resp.raise_for_status()
        data = resp.json()
        return data["instance_url"], data["access_token"]

    async def test_connection(self, config: dict) -> dict:
        try:
            instance_url, token = self._get_token(config)
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"{instance_url}/services/data/v59.0/query",
                    params={"q": "SELECT Id FROM Account LIMIT 1"},
                    headers={"Authorization": f"Bearer {token}"},
                )
                resp.raise_for_status()
            return {"success": True, "message": "Connected to Salesforce"}
        except Exception as e:
            return {"success": False, "message": str(e)}

    async def fetch_data(self, config: dict, column_mapping: dict) -> str:
        instance_url, token = self._get_token(config)
        query = config.get("soql_query", "")
        if not query:
            obj = config.get("object_type", "Task")
            query = f"SELECT Id, Subject, Status, CreatedDate, LastModifiedDate, OwnerId FROM {obj} ORDER BY CreatedDate DESC LIMIT 10000"

        headers = {"Authorization": f"Bearer {token}"}
        records = []

        async with httpx.AsyncClient() as client:
            url = f"{instance_url}/services/data/v59.0/query"
            resp = await client.get(url, params={"q": query}, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            records.extend(data.get("records", []))

            # Handle pagination
            while data.get("nextRecordsUrl"):
                resp = await client.get(f"{instance_url}{data['nextRecordsUrl']}", headers=headers)
                resp.raise_for_status()
                data = resp.json()
                records.extend(data.get("records", []))

        # Remove Salesforce metadata from records
        for r in records:
            r.pop("attributes", None)

        df = pd.DataFrame(records)

        os.makedirs(UPLOAD_DIR, exist_ok=True)
        file_path = os.path.join(UPLOAD_DIR, f"salesforce_{uuid.uuid4().hex[:8]}.parquet")
        df.to_parquet(file_path, index=False)
        logger.info(f"Salesforce: fetched {len(df)} rows → {file_path}")
        return file_path

    async def get_schema(self, config: dict) -> dict:
        instance_url, token = self._get_token(config)
        obj = config.get("object_type", "Task")
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{instance_url}/services/data/v59.0/sobjects/{obj}/describe",
                headers={"Authorization": f"Bearer {token}"},
            )
            resp.raise_for_status()
            data = resp.json()
        fields = [{"name": f["name"], "type": f["type"]} for f in data.get("fields", [])]
        return {"tables": [{"name": obj, "columns": fields}]}

    def get_default_column_mapping(self, config: dict) -> dict | None:
        # Default to the most common process-mining object so an unconfigured
        # connector still declares a usable (tenant-tunable) mapping.
        obj = config.get("object_type", "opportunity").lower()
        if obj == "case":
            return {
                "case_id_column": "CaseNumber",
                "activity_column": "Status",
                "timestamp_column": "LastModifiedDate",
                "resource_column": "OwnerId",
            }
        if obj in ("opportunity", "lead"):
            return {
                "case_id_column": "Id",
                "activity_column": "StageName" if obj == "opportunity" else "Status",
                "timestamp_column": "LastModifiedDate",
                "resource_column": "OwnerId",
            }
        return None

    async def create_record(self, config: dict, payload: dict) -> dict:
        """Write-back: create a Salesforce record (default: Case) from a process-mining action."""
        instance_url, token = self._get_token(config)

        object_type = payload.get("fields", {}).get("object_type") or config.get("object_type") or "Case"

        body: dict = {
            "Subject": payload["title"],
            "Description": payload["description"],
        }

        priority = payload.get("priority")
        if priority and object_type == "Case":
            priority_map = {
                "urgent": "High",
                "high": "High",
                "medium": "Medium",
                "low": "Low",
            }
            mapped = priority_map.get(priority)
            if mapped:
                body["Priority"] = mapped

        record_fields = payload.get("fields", {}).get("record_fields") or {}
        body.update(record_fields)

        url = f"{instance_url}/services/data/v59.0/sobjects/{object_type}"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await request_with_retries(client, "POST", url, headers=headers, json=body)

        if resp.status_code >= 300:
            raise RuntimeError(
                f"Salesforce create_record failed for object '{object_type}': "
                f"{resp.status_code}: {resp.text[:300]}"
            )

        data = resp.json()
        return {
            "external_id": data["id"],
            "url": f"{instance_url}/lightning/r/{object_type}/{data['id']}/view",
            "raw": data,
        }
