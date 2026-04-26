"""
XES file connector.
Handles reading XES event log files and converting them to CSV for storage.
"""

import logging
import os
import uuid
from pathlib import Path

import pandas as pd
import pm4py

from app.services.connectors.base import BaseConnector
from app.services.ingestion import IngestionService

logger = logging.getLogger(__name__)

_ingestion = IngestionService()

UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")


class XesConnector(BaseConnector):
    """Connector for XES (eXtensible Event Stream) file data sources."""

    async def test_connection(self, config: dict) -> dict:
        """
        Test if the XES file exists and is parseable.

        Config keys:
            - file_path: str — path to the XES file
        """
        file_path = config.get("file_path")
        if not file_path:
            return {"success": False, "message": "No file_path provided in config."}

        path = Path(file_path)
        if not path.exists():
            return {"success": False, "message": f"File not found: {file_path}"}

        if not path.is_file():
            return {"success": False, "message": f"Path is not a file: {file_path}"}

        if path.suffix.lower() not in (".xes", ".xes.gz"):
            return {
                "success": False,
                "message": f"File does not appear to be XES: {path.suffix}",
            }

        # Try to parse the XES file. First bound the decompressed
        # size so a crafted gzip can't blow out the process.
        try:
            _ingestion._assert_xes_within_bomb_cap(file_path)
            df = pm4py.read_xes(file_path)
            if df.empty:
                return {
                    "success": False,
                    "message": "XES file was parsed but contains no events.",
                }
            return {
                "success": True,
                "message": f"XES file is valid. Contains {len(df)} events.",
            }
        except Exception as e:
            return {"success": False, "message": f"Cannot parse XES file: {e}"}

    async def fetch_data(self, config: dict, column_mapping: dict) -> str:
        """
        Read the XES file, convert to CSV, and save in the upload directory.

        Config keys:
            - file_path: str — path to the source XES file

        Returns:
            Path to the converted CSV file in the upload directory.
        """
        file_path = config.get("file_path")
        if not file_path:
            raise ValueError("No file_path provided in config.")

        source = Path(file_path)
        if not source.exists():
            raise FileNotFoundError(f"Source XES file not found: {file_path}")

        # Parse XES file with pm4py, guarded against gzip bombs.
        try:
            _ingestion._assert_xes_within_bomb_cap(file_path)
            df = pm4py.read_xes(file_path)
        except Exception as e:
            logger.error(f"Error parsing XES file {file_path}: {e}")
            raise ValueError(f"Failed to parse XES file: {e}")

        if df.empty:
            raise ValueError("XES file contains no events.")

        # Ensure upload directory exists
        os.makedirs(UPLOAD_DIR, exist_ok=True)

        # Save as CSV
        dest_name = f"{uuid.uuid4().hex}_{source.stem}.csv"
        dest_path = os.path.join(UPLOAD_DIR, dest_name)

        # Convert timestamp columns to string for CSV compatibility
        for col in df.columns:
            if pd.api.types.is_datetime64_any_dtype(df[col]):
                df[col] = df[col].astype(str)

        df.to_csv(dest_path, index=False)

        logger.info(
            f"XES file converted to CSV at {dest_path} ({len(df)} events)"
        )
        return dest_path

    async def get_schema(self, config: dict) -> dict:
        """
        Get the column schema of the XES file by parsing it.

        Returns:
            {"tables": [{"name": filename, "columns": [{"name": col, "type": dtype}, ...]}]}
        """
        file_path = config.get("file_path")
        if not file_path:
            raise ValueError("No file_path provided in config.")

        try:
            _ingestion._assert_xes_within_bomb_cap(file_path)
            df = pm4py.read_xes(file_path)

            columns = []
            for col_name, dtype in df.dtypes.items():
                columns.append(
                    {
                        "name": str(col_name),
                        "type": str(dtype),
                    }
                )

            file_name = Path(file_path).name

            return {
                "tables": [
                    {
                        "name": file_name,
                        "columns": columns,
                    }
                ]
            }

        except Exception as e:
            logger.error(f"Error reading XES schema: {e}", exc_info=True)
            raise
