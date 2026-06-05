"""
CSV file connector.
Handles reading and previewing CSV files as a data source.
"""

import logging
import os
import shutil
import uuid
from pathlib import Path

import pandas as pd

from app.services.connectors.base import BaseConnector, ConnectorMeta

logger = logging.getLogger(__name__)

# Default storage directory for imported files
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")


class CsvConnector(BaseConnector):
    """Connector for CSV file data sources."""

    meta = ConnectorMeta(id="csv_watch", label="CSV Watch", category="file", mapping_mode="manual")

    async def test_connection(self, config: dict) -> dict:
        """
        Test if the CSV file exists and is readable.

        Config keys:
            - file_path: str — path to the CSV file
            - encoding: str (optional) — file encoding, default "utf-8"
        """
        file_path = config.get("file_path")
        if not file_path:
            return {"success": False, "message": "No file_path provided in config."}

        path = Path(file_path)
        if not path.exists():
            return {"success": False, "message": f"File not found: {file_path}"}

        if not path.is_file():
            return {"success": False, "message": f"Path is not a file: {file_path}"}

        if path.suffix.lower() not in (".csv", ".tsv", ".txt"):
            return {
                "success": False,
                "message": f"File does not appear to be a CSV: {path.suffix}",
            }

        # Try to read the first few rows to verify the file is parseable
        encoding = config.get("encoding", "utf-8")
        delimiter = config.get("delimiter")
        try:
            read_kwargs = {"encoding": encoding, "nrows": 5}
            if delimiter:
                read_kwargs["sep"] = delimiter
            pd.read_csv(file_path, **read_kwargs)
            return {"success": True, "message": "CSV file is readable."}
        except UnicodeDecodeError:
            # Try fallback encoding
            try:
                read_kwargs["encoding"] = "latin-1"
                pd.read_csv(file_path, **read_kwargs)
                return {
                    "success": True,
                    "message": "CSV file is readable (using latin-1 encoding).",
                }
            except Exception as e:
                return {"success": False, "message": f"Cannot read CSV file: {e}"}
        except Exception as e:
            return {"success": False, "message": f"Cannot read CSV file: {e}"}

    async def fetch_data(self, config: dict, column_mapping: dict) -> str:
        """
        Fetch data from a CSV file. If the file is already in the upload directory,
        return its path. Otherwise, copy it to the upload directory.

        Config keys:
            - file_path: str — path to the source CSV file
            - encoding: str (optional) — file encoding
            - delimiter: str (optional) — column delimiter

        Returns:
            Path to the CSV file in the upload directory.
        """
        file_path = config.get("file_path")
        if not file_path:
            raise ValueError("No file_path provided in config.")

        source = Path(file_path)
        if not source.exists():
            raise FileNotFoundError(f"Source CSV file not found: {file_path}")

        # Ensure upload directory exists
        os.makedirs(UPLOAD_DIR, exist_ok=True)

        # If file is already in upload dir, return as-is
        if str(source).startswith(UPLOAD_DIR):
            return str(source)

        # Copy file to upload directory with a unique name
        dest_name = f"{uuid.uuid4().hex}_{source.name}"
        dest_path = os.path.join(UPLOAD_DIR, dest_name)
        shutil.copy2(str(source), dest_path)

        logger.info(f"CSV file copied to {dest_path}")
        return dest_path

    async def get_schema(self, config: dict) -> dict:
        """
        Get the column schema of the CSV file.

        Returns:
            {"tables": [{"name": filename, "columns": [{"name": col, "type": dtype}, ...]}]}
        """
        file_path = config.get("file_path")
        if not file_path:
            raise ValueError("No file_path provided in config.")

        encoding = config.get("encoding", "utf-8")
        delimiter = config.get("delimiter")

        try:
            read_kwargs = {"encoding": encoding, "nrows": 100}
            if delimiter:
                read_kwargs["sep"] = delimiter

            try:
                df = pd.read_csv(file_path, **read_kwargs)
            except UnicodeDecodeError:
                read_kwargs["encoding"] = "latin-1"
                df = pd.read_csv(file_path, **read_kwargs)

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
            logger.error(f"Error reading CSV schema: {e}", exc_info=True)
            raise
