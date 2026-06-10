"""
ServiceNow connector: extract incident/change/request event data via REST API.

Config keys:
    - instance_url: str — e.g., "https://yourinstance.service-now.com"
    - username: str — ServiceNow username
    - password: str — ServiceNow password
    - table: str — ServiceNow table (default: "incident")
    - query: str — (optional) ServiceNow encoded query filter
    - limit: int — Max records (default: 10000)
"""

import base64
import logging
import os
import uuid

import httpx
import pandas as pd

from app.services.connectors.base import BaseConnector, ConnectorMeta
from app.services.connectors.http_base import request_with_retries

logger = logging.getLogger(__name__)
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")


class ServiceNowConnector(BaseConnector):

    meta = ConnectorMeta(
        id="servicenow",
        label="ServiceNow",
        category="itsm",
        mapping_mode="auto",
        supports_write_back=True,
        write_back_label="Create ServiceNow record",
    )

    async def test_connection(self, config: dict) -> dict:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"{config['instance_url']}/api/now/table/sys_user",
                    params={"sysparm_limit": 1},
                    auth=(config["username"], config["password"]),
                    headers={"Accept": "application/json"},
                )
                resp.raise_for_status()
            return {"success": True, "message": "Connected to ServiceNow"}
        except Exception as e:
            return {"success": False, "message": str(e)}

    async def fetch_data(self, config: dict, column_mapping: dict) -> str:
        table = config.get("table", "incident")
        limit = config.get("limit", 10000)
        query = config.get("query", "")

        params = {
            "sysparm_limit": limit,
            "sysparm_display_value": "true",
        }
        if query:
            params["sysparm_query"] = query

        records = []
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{config['instance_url']}/api/now/table/{table}",
                params=params,
                auth=(config["username"], config["password"]),
                headers={"Accept": "application/json"},
                timeout=60,
            )
            resp.raise_for_status()
            records = resp.json().get("result", [])

        df = pd.DataFrame(records)

        os.makedirs(UPLOAD_DIR, exist_ok=True)
        file_path = os.path.join(UPLOAD_DIR, f"servicenow_{uuid.uuid4().hex[:8]}.parquet")
        df.to_parquet(file_path, index=False)
        logger.info(f"ServiceNow: fetched {len(df)} rows from {table} → {file_path}")
        return file_path

    async def get_schema(self, config: dict) -> dict:
        table = config.get("table", "incident")
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{config['instance_url']}/api/now/table/{table}",
                params={"sysparm_limit": 1},
                auth=(config["username"], config["password"]),
                headers={"Accept": "application/json"},
            )
            resp.raise_for_status()
            results = resp.json().get("result", [])

        if results:
            columns = [{"name": k, "type": "string"} for k in results[0].keys()]
        else:
            columns = []
        return {"tables": [{"name": table, "columns": columns}]}

    async def create_record(self, config: dict, payload: dict) -> dict:
        table = payload.get("fields", {}).get("table") or config.get("table") or "incident"
        base = config["instance_url"].rstrip("/")
        url = f"{base}/api/now/table/{table}"

        credentials = f"{config['username']}:{config['password']}"
        auth_header = "Basic " + base64.b64encode(credentials.encode()).decode()
        headers = {
            "Authorization": auth_header,
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

        body: dict = {
            "short_description": payload["title"],
            "description": payload["description"],
        }

        priority_map = {"urgent": "1", "high": "2", "medium": "3", "low": "3"}
        priority = payload.get("priority")
        if priority:
            urgency = priority_map.get(priority)
            if urgency:
                body["urgency"] = urgency

        record_fields = payload.get("fields", {}).get("record_fields") or {}
        body.update(record_fields)

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await request_with_retries(client, "POST", url, headers=headers, json=body)

        if resp.status_code >= 300:
            raise RuntimeError(
                f"ServiceNow create_record failed {resp.status_code}: {resp.text[:300]}"
            )

        data = resp.json()
        r = data["result"]
        return {
            "external_id": r.get("number") or r.get("sys_id"),
            "url": f"{base}/nav_to.do?uri={table}.do?sys_id={r['sys_id']}",
            "raw": data,
        }

    def get_default_column_mapping(self, config: dict) -> dict | None:
        # Default table mirrors fetch_data's default so an unconfigured
        # connector still declares a usable (tenant-tunable) mapping.
        table = config.get("table", "incident").lower()
        if table == "incident":
            return {
                "case_id_column": "number",
                "activity_column": "state",
                "timestamp_column": "sys_updated_on",
                "resource_column": "assigned_to",
            }
        if table == "change_request":
            return {
                "case_id_column": "number",
                "activity_column": "state",
                "timestamp_column": "sys_updated_on",
                "resource_column": "assigned_to",
            }
        return None
