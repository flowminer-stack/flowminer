"""
SAP connector: extract event data from SAP ERP via RFC or OData.

Config keys:
    - mode: str — "odata" or "rfc"
    - base_url: str — OData endpoint URL (for odata mode)
    - username: str
    - password: str
    - entity_set: str — OData entity set (e.g., "PurchaseOrderSet")
    - query_filter: str — (optional) OData $filter expression
    - limit: int — Max records (default: 10000)

    For RFC mode:
    - ashost: str — SAP application server host
    - sysnr: str — System number
    - client: str — SAP client number
    - function_module: str — RFC function module to call
"""

import logging
import os
import uuid

import httpx
import pandas as pd

from app.services.connectors.base import BaseConnector

logger = logging.getLogger(__name__)
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")


class SAPConnector(BaseConnector):

    async def test_connection(self, config: dict) -> dict:
        mode = config.get("mode", "odata")
        if mode == "odata":
            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.get(
                        config["base_url"],
                        auth=(config["username"], config["password"]),
                        headers={"Accept": "application/json"},
                        params={"$top": 1},
                    )
                    resp.raise_for_status()
                return {"success": True, "message": "Connected to SAP OData"}
            except Exception as e:
                return {"success": False, "message": str(e)}
        elif mode == "rfc":
            try:
                import pyrfc
                conn = pyrfc.Connection(
                    ashost=config["ashost"],
                    sysnr=config["sysnr"],
                    client=config["client"],
                    user=config["username"],
                    passwd=config["password"],
                )
                conn.ping()
                conn.close()
                return {"success": True, "message": "Connected to SAP via RFC"}
            except ImportError:
                return {"success": False, "message": "pyrfc not installed. Install SAP NW RFC SDK + pyrfc."}
            except Exception as e:
                return {"success": False, "message": str(e)}
        return {"success": False, "message": f"Unknown SAP mode: {mode}"}

    async def fetch_data(self, config: dict, column_mapping: dict) -> str:
        mode = config.get("mode", "odata")
        if mode == "odata":
            return await self._fetch_odata(config)
        elif mode == "rfc":
            return self._fetch_rfc(config)
        raise ValueError(f"Unknown SAP mode: {mode}")

    async def _fetch_odata(self, config: dict) -> str:
        entity_set = config.get("entity_set", "")
        if not entity_set:
            raise ValueError("No entity_set specified")

        url = f"{config['base_url']}/{entity_set}"
        params = {
            "$format": "json",
            "$top": config.get("limit", 10000),
        }
        if config.get("query_filter"):
            params["$filter"] = config["query_filter"]

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.get(
                url,
                auth=(config["username"], config["password"]),
                params=params,
                headers={"Accept": "application/json"},
            )
            resp.raise_for_status()

        data = resp.json()
        results = data.get("d", {}).get("results", data.get("value", []))
        df = pd.DataFrame(results)

        # Remove OData metadata columns
        for col in ["__metadata", "@odata.etag"]:
            if col in df.columns:
                df = df.drop(columns=[col])

        os.makedirs(UPLOAD_DIR, exist_ok=True)
        file_path = os.path.join(UPLOAD_DIR, f"sap_{uuid.uuid4().hex[:8]}.parquet")
        df.to_parquet(file_path, index=False)
        logger.info(f"SAP OData: fetched {len(df)} rows → {file_path}")
        return file_path

    def _fetch_rfc(self, config: dict) -> str:
        import pyrfc

        conn = pyrfc.Connection(
            ashost=config["ashost"],
            sysnr=config["sysnr"],
            client=config["client"],
            user=config["username"],
            passwd=config["password"],
        )

        fm = config.get("function_module", "")
        if not fm:
            raise ValueError("No function_module specified for RFC mode")

        result = conn.call(fm)
        conn.close()

        # Attempt to find a table-like structure in the result
        records = []
        for key, val in result.items():
            if isinstance(val, list) and len(val) > 0 and isinstance(val[0], dict):
                records = val
                break

        df = pd.DataFrame(records)
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        file_path = os.path.join(UPLOAD_DIR, f"sap_rfc_{uuid.uuid4().hex[:8]}.parquet")
        df.to_parquet(file_path, index=False)
        logger.info(f"SAP RFC: fetched {len(df)} rows → {file_path}")
        return file_path

    async def get_schema(self, config: dict) -> dict:
        mode = config.get("mode", "odata")
        if mode == "odata":
            # Fetch metadata from OData $metadata endpoint
            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.get(
                        f"{config['base_url']}/$metadata",
                        auth=(config["username"], config["password"]),
                    )
                    return {"tables": [], "raw_metadata": resp.text[:5000]}
            except Exception:
                pass
        return {"tables": []}

    def get_default_column_mapping(self, config: dict) -> dict | None:
        entity = config.get("entity_set", "").lower()
        if "purchaseorder" in entity:
            return {
                "case_id_column": "PurchaseOrder",
                "activity_column": "Status",
                "timestamp_column": "CreatedDate",
            }
        if "salesorder" in entity:
            return {
                "case_id_column": "SalesOrder",
                "activity_column": "Status",
                "timestamp_column": "CreatedDate",
            }
        return None
