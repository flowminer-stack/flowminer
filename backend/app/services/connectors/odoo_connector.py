"""
Odoo connector.
Reads state-change history directly from an Odoo PostgreSQL database using
the mail_tracking_value + mail_message tables.
"""

import logging
import os
import uuid

import pandas as pd
from sqlalchemy import create_engine, text

from app.services.connectors.base import BaseConnector

logger = logging.getLogger(__name__)

UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")
CONNECTOR_DIR = os.path.join(UPLOAD_DIR, "connectors")

# SQL that fetches all tracked state changes for a given Odoo model
_TRACKING_QUERY = """
SELECT
    mm.res_id                                                          AS case_id,
    mm.subtype_id,
    mtv.field_desc                                                     AS field_changed,
    COALESCE(
        mtv.new_value_char,
        mtv.new_value_text,
        CAST(mtv.new_value_integer AS TEXT)
    )                                                                  AS new_value,
    mm.date                                                            AS timestamp,
    rp.name                                                            AS resource
FROM mail_message mm
LEFT JOIN mail_tracking_value mtv ON mtv.mail_message_id = mm.id
LEFT JOIN res_partner             rp  ON rp.id = mm.author_id
WHERE mm.model = :model
  AND mm.message_type = 'notification'
ORDER BY mm.date
"""

# Well-known Odoo models that are interesting for process mining
_KNOWN_MODELS = [
    "sale.order",
    "purchase.order",
    "account.move",
    "helpdesk.ticket",
    "mrp.production",
    "project.task",
    "stock.picking",
    "hr.leave",
]


def _build_dsn(config: dict) -> str:
    host = config.get("host", "localhost")
    port = config.get("port", 5432)
    database = config.get("database", "")
    user = config.get("user", "")
    password = config.get("password", "")
    if password:
        return f"postgresql://{user}:{password}@{host}:{port}/{database}"
    return f"postgresql://{user}@{host}:{port}/{database}"


class OdooConnector(BaseConnector):
    """Connector for Odoo — reads state changes from mail tracking tables."""

    # ------------------------------------------------------------------
    # BaseConnector interface
    # ------------------------------------------------------------------

    def get_default_column_mapping(self, config: dict) -> dict | None:
        return {
            "case_id_column": "Case ID",
            "activity_column": "Activity",
            "timestamp_column": "Timestamp",
            "resource_column": "Resource",
        }

    async def test_connection(self, config: dict) -> dict:
        """
        Verify PostgreSQL connectivity by executing SELECT 1.

        Required config keys: host, database, user, password
        Optional: port (default 5432)
        """
        for key in ("host", "database", "user", "password"):
            if not config.get(key):
                raise ValueError(f"Config must include '{key}'.")

        try:
            dsn = _build_dsn(config)
            engine = create_engine(dsn, pool_pre_ping=True)
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            engine.dispose()
            return {
                "success": True,
                "message": (
                    f"Connected to Odoo database '{config['database']}' "
                    f"at {config['host']}:{config.get('port', 5432)}."
                ),
            }
        except Exception as e:
            logger.error(f"OdooConnector.test_connection error: {e}", exc_info=True)
            return {"success": False, "message": f"Connection failed: {e}"}

    async def fetch_data(self, config: dict, column_mapping: dict) -> str:
        """
        Query mail tracking tables for state changes on the configured Odoo model.

        Required config keys: host, database, user, password, model
        Optional: port (default 5432)

        Returns:
            Path to the saved CSV file.
        """
        for key in ("host", "database", "user", "password", "model"):
            if not config.get(key):
                raise ValueError(f"Config must include '{key}'.")

        model = config["model"]

        try:
            dsn = _build_dsn(config)
            engine = create_engine(dsn)
            df = pd.read_sql(text(_TRACKING_QUERY), engine, params={"model": model})
            engine.dispose()
        except Exception as e:
            logger.error(f"OdooConnector.fetch_data error: {e}", exc_info=True)
            raise

        if df.empty:
            raise ValueError(f"No tracking events found for Odoo model '{model}'.")

        # Rename to process-mining-friendly column names
        df = df.rename(columns={
            "case_id":      "Case ID",
            "field_changed": "Field Changed",
            "new_value":    "Activity",
            "timestamp":    "Timestamp",
            "resource":     "Resource",
        })

        os.makedirs(CONNECTOR_DIR, exist_ok=True)
        dest_name = f"{uuid.uuid4().hex}_odoo_export.csv"
        dest_path = os.path.join(CONNECTOR_DIR, dest_name)
        df.to_csv(dest_path, index=False)

        logger.info(
            f"OdooConnector: saved {len(df)} events for model '{model}' to {dest_path}"
        )
        return dest_path

    async def get_schema(self, config: dict) -> dict:
        """
        List available Odoo models from the ir_model table.

        Falls back to a hardcoded list of common models if the query fails
        (e.g. insufficient permissions).
        """
        try:
            dsn = _build_dsn(config)
            engine = create_engine(dsn)
            query = text(
                "SELECT model, name FROM ir_model ORDER BY model"
            )
            df = pd.read_sql(query, engine)
            engine.dispose()

            tables = [
                {
                    "name": row["model"],
                    "columns": [
                        {"name": "Case ID",       "type": "integer"},
                        {"name": "Field Changed",  "type": "string"},
                        {"name": "Activity",       "type": "string"},
                        {"name": "Timestamp",      "type": "datetime"},
                        {"name": "Resource",       "type": "string"},
                    ],
                }
                for _, row in df.iterrows()
            ]
            return {"tables": tables}

        except Exception as e:
            logger.warning(f"OdooConnector.get_schema: could not query ir_model, using defaults: {e}")

        # Fallback: return well-known models
        default_columns = [
            {"name": "Case ID",      "type": "integer"},
            {"name": "Field Changed", "type": "string"},
            {"name": "Activity",     "type": "string"},
            {"name": "Timestamp",    "type": "datetime"},
            {"name": "Resource",     "type": "string"},
        ]
        return {
            "tables": [
                {"name": model, "columns": default_columns}
                for model in _KNOWN_MODELS
            ]
        }
