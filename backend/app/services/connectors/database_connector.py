"""
Database connector for SQL data sources.
Supports PostgreSQL, MySQL, and SQL Server via SQLAlchemy.
"""

import logging
import os
import re
import uuid

import pandas as pd
from sqlalchemy import create_engine, inspect, text

from app.services.connectors.base import BaseConnector

# Safe SQL identifier: letters, digits, underscores, optional single dot
# between schema and table. Rejects ';', '--', spaces, quotes — i.e. the
# character classes that appear in every real SQL-injection PoC.
_SQL_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$")


def _assert_safe_ident(value: str, kind: str) -> str:
    """Reject anything that isn't a plain `[schema.]name` identifier."""
    if not isinstance(value, str) or not _SQL_IDENT_RE.match(value):
        raise ValueError(
            f"Unsafe SQL {kind}: {value!r}. "
            f"Only letters, digits and underscores are allowed "
            f"(optional single schema prefix)."
        )
    return value

logger = logging.getLogger(__name__)

UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")

# Supported database dialects and their SQLAlchemy URL prefixes
DIALECT_MAP = {
    "postgresql": "postgresql",
    "postgres": "postgresql",
    "mysql": "mysql+pymysql",
    "mariadb": "mysql+pymysql",
    "mssql": "mssql+pyodbc",
    "sqlserver": "mssql+pyodbc",
}


def _build_connection_url(config: dict) -> str:
    """
    Build a SQLAlchemy connection URL from the config dict.

    Config keys:
        - dialect: str — database type (postgresql, mysql, mssql)
        - host: str — database host
        - port: int — database port
        - database: str — database name
        - user: str — database username
        - password: str — database password
        - driver: str (optional) — ODBC driver for SQL Server
    """
    dialect = config.get("dialect", "postgresql").lower()
    sa_prefix = DIALECT_MAP.get(dialect)
    if sa_prefix is None:
        raise ValueError(
            f"Unsupported database dialect: '{dialect}'. "
            f"Supported: {list(DIALECT_MAP.keys())}"
        )

    host = config.get("host", "localhost")
    port = config.get("port")
    database = config.get("database", "")
    user = config.get("user", "")
    password = config.get("password", "")

    # Build base URL
    auth = ""
    if user:
        auth = user
        if password:
            auth += f":{password}"
        auth += "@"

    host_port = host
    if port:
        host_port += f":{port}"

    url = f"{sa_prefix}://{auth}{host_port}/{database}"

    # For SQL Server, add ODBC driver if specified
    if dialect in ("mssql", "sqlserver"):
        driver = config.get("driver", "ODBC Driver 17 for SQL Server")
        url += f"?driver={driver}"

    return url


class DatabaseConnector(BaseConnector):
    """Connector for SQL database data sources (PostgreSQL, MySQL, SQL Server)."""

    async def test_connection(self, config: dict) -> dict:
        """
        Test the database connection.

        Config keys: dialect, host, port, database, user, password
        """
        try:
            url = _build_connection_url(config)
            engine = create_engine(url, pool_pre_ping=True)

            # Try a simple query to verify connectivity
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))

            engine.dispose()
            return {
                "success": True,
                "message": f"Successfully connected to {config.get('dialect', 'database')} "
                f"at {config.get('host', 'localhost')}.",
            }

        except Exception as e:
            logger.warning(f"Database connection test failed: {e}")
            return {"success": False, "message": f"Connection failed: {e}"}

    async def get_schema(self, config: dict) -> dict:
        """
        Query the database to get available tables and their columns.

        Config keys: dialect, host, port, database, user, password
            Optional: schema (database schema name, default varies by dialect)

        Returns:
            {"tables": [{"name": str, "columns": [{"name": str, "type": str}, ...]}, ...]}
        """
        try:
            url = _build_connection_url(config)
            engine = create_engine(url)
            inspector = inspect(engine)

            db_schema = config.get("schema", None)

            table_names = inspector.get_table_names(schema=db_schema)

            tables = []
            for table_name in table_names:
                columns = []
                for col_info in inspector.get_columns(table_name, schema=db_schema):
                    columns.append(
                        {
                            "name": col_info["name"],
                            "type": str(col_info["type"]),
                        }
                    )
                tables.append(
                    {
                        "name": table_name,
                        "columns": columns,
                    }
                )

            engine.dispose()

            return {"tables": tables}

        except Exception as e:
            logger.error(f"Error getting database schema: {e}", exc_info=True)
            raise

    async def fetch_data(self, config: dict, column_mapping: dict, since=None) -> str:
        """
        Execute a SQL query or read a table, and save the result as a Parquet file.

        Config keys: dialect, host, port, database, user, password
            Plus one of:
            - query: str — SQL query to execute
            - table: str — table name to read (with optional where_clause)
            - where_clause: str (optional) — WHERE clause for table reads
            - incremental_column: str (optional) — timestamp column used for
              incremental syncs. If set AND ``since`` is provided, only rows
              where this column is > since are fetched.

        Args:
            config: connector config dict
            column_mapping: dict mapping logical columns to source columns
                (used to select only needed columns if no query is provided)
            since: last successful sync time (``datetime``). Hint for
                incremental fetching — ignored unless ``incremental_column``
                is set in the config.

        Returns:
            Path to the saved Parquet file in the upload directory.
        """
        try:
            url = _build_connection_url(config)
            engine = create_engine(url)

            query = config.get("query")
            table = config.get("table")
            incremental_col = config.get("incremental_column")

            if query:
                # User-supplied raw SQL. Restrict to a single read-only
                # SELECT/WITH statement so a connector operator cannot
                # escalate into arbitrary DDL/DML on the upstream DB.
                # Multi-statement queries are refused outright.
                stripped = query.strip().rstrip(";")
                if ";" in stripped:
                    raise ValueError(
                        "connector query may not contain ';' — single "
                        "statement only."
                    )
                first = stripped.lstrip().split(None, 1)[0].upper() if stripped else ""
                if first not in {"SELECT", "WITH"}:
                    raise ValueError(
                        "connector query must start with SELECT or WITH."
                    )
                params: dict = {}
                if incremental_col and since is not None:
                    params["since"] = since
                df = pd.read_sql(text(stripped), engine, params=params or None)
            elif table:
                # Validate the table name as a plain identifier — the
                # old code f-stringed an arbitrary value inside double
                # quotes, which broke on a name containing `"`.
                _assert_safe_ident(table, "table name")

                select_cols = "*"
                if column_mapping:
                    cols = [
                        _assert_safe_ident(v, "column name")
                        for v in column_mapping.values()
                        if v is not None
                    ]
                    if cols:
                        select_cols = ", ".join(f'"{c}"' for c in cols)

                sql = f'SELECT {select_cols} FROM "{table}"'

                conditions: list[str] = []
                params: dict = {}

                # Incremental filter — only fetch rows newer than last sync.
                if incremental_col and since is not None:
                    _assert_safe_ident(incremental_col, "column name")
                    conditions.append(f'"{incremental_col}" > :since')
                    params["since"] = since

                # where_clause is no longer concatenated into SQL. The
                # old behaviour of f-stringing a user-supplied WHERE
                # fragment was a direct SQL-injection vector: a
                # configured where_clause of
                #     "1=1 UNION SELECT username,password,NULL FROM users--"
                # ended up inside the generated SELECT verbatim.
                # Callers that need custom filtering should use the
                # ``query`` field instead (which is now SELECT-only
                # and single-statement).
                where_clause = config.get("where_clause")
                if where_clause:
                    logger.warning(
                        "Ignoring where_clause on connector: raw WHERE "
                        "fragments are no longer supported. Move the "
                        "filter into the query field instead."
                    )

                if conditions:
                    sql += " WHERE " + " AND ".join(conditions)

                df = pd.read_sql(text(sql), engine, params=params or None)
            else:
                engine.dispose()
                raise ValueError(
                    "Config must include either 'query' or 'table' to fetch data."
                )

            engine.dispose()

            if df.empty:
                raise ValueError("Query returned no results.")

            # Ensure upload directory exists
            os.makedirs(UPLOAD_DIR, exist_ok=True)

            # Save as Parquet
            dest_name = f"{uuid.uuid4().hex}_db_export.parquet"
            dest_path = os.path.join(UPLOAD_DIR, dest_name)
            df.to_parquet(dest_path, index=False)

            logger.info(
                f"Database data saved to {dest_path} ({len(df)} rows, "
                f"{len(df.columns)} columns)"
            )
            return dest_path

        except Exception as e:
            logger.error(f"Error fetching database data: {e}", exc_info=True)
            raise
