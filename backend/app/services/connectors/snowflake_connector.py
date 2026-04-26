"""
Snowflake connector: query event data from Snowflake data warehouse.

Config keys:
    - account: str — Snowflake account identifier (e.g., "xy12345.us-east-1")
    - user: str — Snowflake username
    - password: str — Snowflake password
    - warehouse: str — Warehouse name
    - database: str — Database name
    - schema: str — Schema name (default: "PUBLIC")
    - query: str — SQL query to extract event data
"""

import logging
import os
import uuid

import pandas as pd

from app.services.connectors.base import BaseConnector

logger = logging.getLogger(__name__)
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")


class SnowflakeConnector(BaseConnector):

    async def test_connection(self, config: dict) -> dict:
        try:
            import snowflake.connector
            conn = snowflake.connector.connect(
                account=config["account"],
                user=config["user"],
                password=config["password"],
                warehouse=config.get("warehouse"),
                database=config.get("database"),
                schema=config.get("schema", "PUBLIC"),
            )
            conn.cursor().execute("SELECT 1")
            conn.close()
            return {"success": True, "message": "Connected to Snowflake"}
        except ImportError:
            return {"success": False, "message": "snowflake-connector-python not installed. Install with: pip install snowflake-connector-python"}
        except Exception as e:
            return {"success": False, "message": str(e)}

    async def fetch_data(self, config: dict, column_mapping: dict) -> str:
        import snowflake.connector

        conn = snowflake.connector.connect(
            account=config["account"],
            user=config["user"],
            password=config["password"],
            warehouse=config.get("warehouse"),
            database=config.get("database"),
            schema=config.get("schema", "PUBLIC"),
        )
        query = config.get("query", "")
        if not query:
            raise ValueError("No query specified in Snowflake connector config")

        df = pd.read_sql(query, conn)
        conn.close()

        os.makedirs(UPLOAD_DIR, exist_ok=True)
        file_path = os.path.join(UPLOAD_DIR, f"snowflake_{uuid.uuid4().hex[:8]}.parquet")
        df.to_parquet(file_path, index=False)
        logger.info(f"Snowflake: fetched {len(df)} rows → {file_path}")
        return file_path

    async def get_schema(self, config: dict) -> dict:
        import snowflake.connector

        conn = snowflake.connector.connect(
            account=config["account"],
            user=config["user"],
            password=config["password"],
            warehouse=config.get("warehouse"),
            database=config.get("database"),
            schema=config.get("schema", "PUBLIC"),
        )
        cursor = conn.cursor()
        cursor.execute("SHOW TABLES")
        tables = []
        for row in cursor.fetchall():
            table_name = row[1]
            cursor.execute(f"DESCRIBE TABLE {table_name}")
            columns = [{"name": r[0], "type": r[1]} for r in cursor.fetchall()]
            tables.append({"name": table_name, "columns": columns})
        conn.close()
        return {"tables": tables}
