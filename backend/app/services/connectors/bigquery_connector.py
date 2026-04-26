"""
BigQuery connector: query event data from Google BigQuery.

Config keys:
    - project_id: str — GCP project ID
    - credentials_json: str — Path to service account JSON key file
    - query: str — SQL query to extract event data
    - dataset: str — (optional) Default dataset
"""

import logging
import os
import uuid

import pandas as pd

from app.services.connectors.base import BaseConnector

logger = logging.getLogger(__name__)
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")


class BigQueryConnector(BaseConnector):

    async def test_connection(self, config: dict) -> dict:
        try:
            from google.cloud import bigquery
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = config.get("credentials_json", "")
            client = bigquery.Client(project=config["project_id"])
            client.query("SELECT 1").result()
            return {"success": True, "message": "Connected to BigQuery"}
        except ImportError:
            return {"success": False, "message": "google-cloud-bigquery not installed. Install with: pip install google-cloud-bigquery"}
        except Exception as e:
            return {"success": False, "message": str(e)}

    async def fetch_data(self, config: dict, column_mapping: dict) -> str:
        from google.cloud import bigquery

        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = config.get("credentials_json", "")
        client = bigquery.Client(project=config["project_id"])
        query = config.get("query", "")
        if not query:
            raise ValueError("No query specified in BigQuery connector config")

        df = client.query(query).to_dataframe()

        os.makedirs(UPLOAD_DIR, exist_ok=True)
        file_path = os.path.join(UPLOAD_DIR, f"bigquery_{uuid.uuid4().hex[:8]}.parquet")
        df.to_parquet(file_path, index=False)
        logger.info(f"BigQuery: fetched {len(df)} rows → {file_path}")
        return file_path

    async def get_schema(self, config: dict) -> dict:
        from google.cloud import bigquery

        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = config.get("credentials_json", "")
        client = bigquery.Client(project=config["project_id"])
        dataset = config.get("dataset")
        if not dataset:
            return {"tables": []}

        tables = []
        for table_ref in client.list_tables(dataset):
            table = client.get_table(table_ref)
            columns = [{"name": f.name, "type": f.field_type} for f in table.schema]
            tables.append({"name": table.table_id, "columns": columns})
        return {"tables": tables}
