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

import logging
import os
import uuid

import httpx
import pandas as pd

from app.services.connectors.base import BaseConnector

logger = logging.getLogger(__name__)
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")


class ServiceNowConnector(BaseConnector):

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

    def get_default_column_mapping(self, config: dict) -> dict | None:
        table = config.get("table", "").lower()
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
