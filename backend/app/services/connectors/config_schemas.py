"""Declarative config schemas — the single source of truth for connector config.

Each connector type maps to a Pydantic v2 model describing its configuration:
field names, types, which are required, and which are secrets (``SecretStr``,
which pydantic renders into JSON Schema as ``{"format": "password",
"writeOnly": true}``). ``model_json_schema()`` is served to the frontend by
``GET /connectors/registry`` so the setup form can be generated from — and
validated against — the same definition the backend uses, instead of being
hand-coded twice (the source of the historical frontend/backend drift).

Fields are declared in display order; the frontend renders them in that order.
``extra="allow"`` is set everywhere so configs that also carry column-mapping
keys (``case_id_column`` …, which the UI tucks into ``config``) still validate.

NOTE: these models reflect what each connector's code ACTUALLY reads today.
Where the legacy frontend diverged (e.g. the REST connector's nested
``pagination`` object vs. the old flat ``pagination_type``/``page_size``), the
model follows the backend, and Phase 3 regenerates the form to match.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, SecretStr


class _Base(BaseModel):
    # Tolerate extra keys (column-mapping fields the UI stores inside config,
    # and forward-compat keys) rather than rejecting otherwise-valid configs.
    model_config = ConfigDict(extra="allow", populate_by_name=True)


# ─── File ─────────────────────────────────────────────────────────────────────


class CsvConfig(_Base):
    file_path: str = Field(title="CSV file path", description="Absolute path to the CSV/TSV file")
    delimiter: str = Field(default=",", title="Delimiter")
    encoding: str = Field(default="utf-8", title="Encoding")


# ─── Generic REST ───────────────────────────────────────────────────────────


class PaginationConfig(_Base):
    type: Literal["none", "offset", "page", "cursor"] = Field(default="none", title="Pagination type")
    page_size: int = Field(default=100, title="Page size")
    limit_param: str = Field(default="limit")
    offset_param: str = Field(default="offset")
    page_param: str = Field(default="page")
    cursor_param: str = Field(default="cursor")
    next_path: str = Field(default="next_cursor", description="Dotted path to the next cursor in the response")


class ApiEndpointConfig(_Base):
    url: str = Field(title="URL", description="Endpoint URL to fetch from")
    method: Literal["GET", "POST"] = Field(default="GET", title="HTTP method")
    headers: dict[str, str] = Field(default_factory=dict, title="Headers")
    body: Optional[dict] = Field(default=None, title="Request body (POST)")
    data_path: str = Field(default="", title="Records path", description="Dotted path to the records array, e.g. data.items")
    pagination: PaginationConfig = Field(default_factory=PaginationConfig, title="Pagination")


# ─── Databases (one model, four dialects) ─────────────────────────────────────


class DatabaseConfig(_Base):
    dialect: Literal["postgresql", "mysql", "sqlserver", "oracle"] = Field(
        default="postgresql", title="Dialect"
    )
    host: str = Field(default="localhost", title="Host")
    port: Optional[int] = Field(default=None, title="Port")
    database: str = Field(title="Database")
    user: str = Field(default="", title="User")
    password: SecretStr = Field(default=SecretStr(""), title="Password")
    table: Optional[str] = Field(default=None, title="Table", description="Table to read (or use Query)")
    query: Optional[str] = Field(default=None, title="Query", description="Single read-only SELECT/WITH statement")
    incremental_column: Optional[str] = Field(default=None, title="Incremental column")
    db_schema: Optional[str] = Field(default=None, alias="schema", title="Schema")
    driver: Optional[str] = Field(default=None, title="ODBC driver", description="SQL Server only")


# ─── Warehouses ───────────────────────────────────────────────────────────────


class SnowflakeConfig(_Base):
    account: str = Field(title="Account", description="e.g. xy12345.us-east-1")
    user: str = Field(title="User")
    password: SecretStr = Field(title="Password")
    warehouse: str = Field(title="Warehouse")
    database: str = Field(title="Database")
    db_schema: str = Field(default="PUBLIC", alias="schema", title="Schema")
    query: str = Field(title="Query")


class BigQueryConfig(_Base):
    project_id: str = Field(title="Project ID")
    credentials_json: str = Field(title="Service-account key", description="Path to (or contents of) the service-account JSON")
    query: str = Field(title="Query")
    dataset: Optional[str] = Field(default=None, title="Default dataset")


# ─── ITSM / DevOps / CRM ──────────────────────────────────────────────────────


class JiraConfig(_Base):
    url: str = Field(title="Instance URL", description="e.g. https://yourorg.atlassian.net")
    email: str = Field(title="Email")
    api_token: SecretStr = Field(title="API token")
    project_key: str = Field(title="Project key")
    max_results: int = Field(default=1000, title="Max results")


class GithubConfig(_Base):
    token: SecretStr = Field(title="Personal access token")
    owner: str = Field(title="Owner / org")
    repo: str = Field(title="Repository")
    event_type: Literal["pull_requests", "issues"] = Field(default="pull_requests", title="Event type")
    max_items: int = Field(default=500, title="Max items")


class ZendeskConfig(_Base):
    subdomain: str = Field(title="Subdomain", description="The xxx in xxx.zendesk.com")
    email: str = Field(title="Email")
    api_token: SecretStr = Field(title="API token")
    max_tickets: int = Field(default=1000, title="Max tickets")


class ServiceNowConfig(_Base):
    instance_url: str = Field(title="Instance URL", description="e.g. https://yourinstance.service-now.com")
    username: str = Field(title="Username")
    password: SecretStr = Field(title="Password")
    table: str = Field(default="incident", title="Table")
    query: Optional[str] = Field(default=None, title="Encoded query")
    limit: int = Field(default=10000, title="Max records")


class SalesforceConfig(_Base):
    instance_url: str = Field(title="Instance URL", description="e.g. https://yourorg.my.salesforce.com")
    access_token: Optional[SecretStr] = Field(default=None, title="Access token")
    client_id: Optional[str] = Field(default=None, title="OAuth client ID")
    client_secret: Optional[SecretStr] = Field(default=None, title="OAuth client secret")
    refresh_token: Optional[SecretStr] = Field(default=None, title="OAuth refresh token")
    soql_query: Optional[str] = Field(default=None, title="SOQL query")
    object_type: Optional[str] = Field(default=None, title="Object type", description="e.g. Case, Opportunity")


class OdooConfig(_Base):
    host: str = Field(default="localhost", title="Host")
    port: int = Field(default=5432, title="Port")
    database: str = Field(title="Database")
    user: str = Field(default="odoo", title="User")
    password: SecretStr = Field(title="Password")
    model: str = Field(default="sale.order", title="Odoo model")


# ─── ERP / procurement / HCM ──────────────────────────────────────────────────


class SapConfig(_Base):
    mode: Literal["odata", "rfc", "change_documents"] = Field(default="odata", title="Mode")
    # OData / change-documents
    base_url: Optional[str] = Field(default=None, title="OData base URL")
    username: Optional[str] = Field(default=None, title="Username")
    password: Optional[SecretStr] = Field(default=None, title="Password")
    entity_set: Optional[str] = Field(default=None, title="Entity set")
    query_filter: Optional[str] = Field(default=None, title="OData $filter")
    limit: int = Field(default=10000, title="Max records")
    # change_documents
    use_change_documents: bool = Field(default=False, title="Use change documents (CDHDR/CDPOS)")
    cdhdr_entity_set: str = Field(default="CDHDRSet", title="CDHDR entity set")
    cdpos_entity_set: str = Field(default="CDPOSSet", title="CDPOS entity set")
    object_class: Optional[str] = Field(default=None, title="Object class", description="e.g. EINKBELEG")
    cdpos_filter_batch_size: int = Field(default=50, title="CDPOS filter batch size")
    # RFC
    ashost: Optional[str] = Field(default=None, title="RFC app server host")
    sysnr: Optional[str] = Field(default=None, title="RFC system number")
    client: Optional[str] = Field(default=None, title="RFC client")
    function_module: Optional[str] = Field(default=None, title="RFC function module")


class WorkdayConfig(_Base):
    tenant: str = Field(title="Tenant")
    base_url: str = Field(title="Base URL", description="e.g. https://wd1-impl-services1.workday.com")
    client_id: str = Field(title="Client ID")
    client_secret: SecretStr = Field(title="Client secret")
    endpoint: str = Field(default="common/v1/workers", title="REST endpoint")
    limit: int = Field(default=10000, title="Max rows")


class CoupaConfig(_Base):
    instance_url: str = Field(title="Instance URL", description="e.g. https://your-company.coupahost.com")
    api_key: SecretStr = Field(title="API key")
    resource: Literal["purchase_orders", "requisitions", "invoices", "approvals"] = Field(
        default="purchase_orders", title="Resource"
    )
    limit: int = Field(default=10000, title="Max rows")


class AribaConfig(_Base):
    base_url: str = Field(default="https://openapi.ariba.com", title="Base URL")
    realm: str = Field(title="Realm")
    client_id: str = Field(title="Client ID")
    client_secret: SecretStr = Field(title="Client secret")
    api_key: SecretStr = Field(title="Application key")
    view: Optional[str] = Field(default=None, title="View", description="e.g. PurchaseOrderHeader")
    limit: int = Field(default=10000, title="Max rows")


class OracleFusionConfig(_Base):
    base_url: str = Field(title="Base URL", description="e.g. https://abc-prod.oraclecloud.com")
    username: str = Field(title="Username")
    password: SecretStr = Field(title="Password")
    resource: str = Field(default="purchaseOrders", title="Resource")
    query: Optional[str] = Field(default=None, title="oData-style filter")
    limit: int = Field(default=10000, title="Max rows")


# ─── Registry: connector_type id -> config model ─────────────────────────────
# DatabaseConfig serves all four SQL dialects.
CONFIG_MODELS: dict[str, type[BaseModel]] = {
    "csv_watch": CsvConfig,
    "api_endpoint": ApiEndpointConfig,
    "postgresql": DatabaseConfig,
    "mysql": DatabaseConfig,
    "sqlserver": DatabaseConfig,
    "oracle": DatabaseConfig,
    "snowflake": SnowflakeConfig,
    "bigquery": BigQueryConfig,
    "jira": JiraConfig,
    "github": GithubConfig,
    "zendesk": ZendeskConfig,
    "servicenow": ServiceNowConfig,
    "salesforce": SalesforceConfig,
    "odoo": OdooConfig,
    "sap": SapConfig,
    "workday": WorkdayConfig,
    "coupa": CoupaConfig,
    "ariba": AribaConfig,
    "oracle_fusion": OracleFusionConfig,
}


def get_config_model(type_id: str) -> Optional[type[BaseModel]]:
    """Return the Pydantic config model for a connector type id, or None."""
    return CONFIG_MODELS.get(type_id)


def validate_config(type_id: str, config: dict) -> tuple[bool, list[str]]:
    """Validate a config dict against its connector's model.

    Returns ``(ok, errors)``. Never raises. ``ok`` is True if there is no model
    for the type (nothing to validate against) or the config validates.
    """
    model = CONFIG_MODELS.get(type_id)
    if model is None:
        return True, []
    try:
        model.model_validate(config)
        return True, []
    except Exception as exc:  # pydantic ValidationError (or anything)
        errors = [str(e) for e in getattr(exc, "errors", lambda: [exc])()]
        return False, errors
