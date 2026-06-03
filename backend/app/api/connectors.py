"""
Connector management router: CRUD, connection testing, and manual sync.
"""

import logging
import os
import uuid as uuid_mod
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models import (
    Connector,
    ConnectorStatus,
    ConnectorType,
    EventLog,
    EventLogStatus,
    SourceType,
    User,
)
from app.api.deps import get_current_active_user, assert_project_access
from app.services.connectors.base import BaseConnector
from app.services.connectors.database_connector import DatabaseConnector
from app.services.connectors.csv_connector import CsvConnector
from app.services.connectors.api_connector import ApiConnector
from app.services.connectors.jira_connector import JiraConnector
from app.services.connectors.github_connector import GitHubConnector
from app.services.connectors.odoo_connector import OdooConnector
from app.services.connectors.zendesk_connector import ZendeskConnector

logger = logging.getLogger(__name__)

router = APIRouter()


def _get_connector_service(connector_type: ConnectorType) -> BaseConnector:
    """Return the appropriate connector service instance for the given type.

    Enterprise connector services are imported lazily so the app still
    boots if an optional client library (snowflake, google-cloud-bigquery,
    pyrfc, …) is not installed in the running environment.
    """
    if connector_type in (
        ConnectorType.postgresql,
        ConnectorType.mysql,
        ConnectorType.sqlserver,
        ConnectorType.oracle,
    ):
        return DatabaseConnector()
    elif connector_type == ConnectorType.csv_watch:
        return CsvConnector()
    elif connector_type == ConnectorType.api_endpoint:
        return ApiConnector()
    elif connector_type == ConnectorType.jira:
        return JiraConnector()
    elif connector_type == ConnectorType.github:
        return GitHubConnector()
    elif connector_type == ConnectorType.odoo:
        return OdooConnector()
    elif connector_type == ConnectorType.zendesk:
        return ZendeskConnector()
    elif connector_type == ConnectorType.sap:
        from app.services.connectors.sap_connector import SAPConnector
        return SAPConnector()
    elif connector_type == ConnectorType.salesforce:
        from app.services.connectors.salesforce_connector import SalesforceConnector
        return SalesforceConnector()
    elif connector_type == ConnectorType.servicenow:
        from app.services.connectors.servicenow_connector import ServiceNowConnector
        return ServiceNowConnector()
    elif connector_type == ConnectorType.snowflake:
        from app.services.connectors.snowflake_connector import SnowflakeConnector
        return SnowflakeConnector()
    elif connector_type == ConnectorType.bigquery:
        from app.services.connectors.bigquery_connector import BigQueryConnector
        return BigQueryConnector()
    elif connector_type == ConnectorType.workday:
        from app.services.connectors.workday_connector import WorkdayConnector
        return WorkdayConnector()
    elif connector_type == ConnectorType.coupa:
        from app.services.connectors.coupa_connector import CoupaConnector
        return CoupaConnector()
    elif connector_type == ConnectorType.ariba:
        from app.services.connectors.ariba_connector import AribaConnector
        return AribaConnector()
    elif connector_type == ConnectorType.oracle_fusion:
        from app.services.connectors.oracle_fusion_connector import OracleFusionConnector
        return OracleFusionConnector()
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown connector type: {connector_type}",
        )


# -- Pydantic models for connector create/update (inline since no schema file) --
from pydantic import BaseModel, Field


class ConnectorCreate(BaseModel):
    project_id: UUID = Field(..., description="Associated project ID")
    name: str = Field(..., min_length=1, description="Connector name")
    connector_type: str = Field(..., description="Connector type: postgresql, mysql, sqlserver, csv_watch, api_endpoint")
    config: dict = Field(default={}, description="Connector-specific configuration")
    column_mapping: dict = Field(default={}, description="Column mapping for the data source")
    schedule: str | None = Field(default=None, description="Cron schedule for auto-sync")


class ConnectorUpdate(BaseModel):
    name: str | None = Field(default=None, description="Updated connector name")
    config: dict | None = Field(default=None, description="Updated configuration")
    column_mapping: dict | None = Field(default=None, description="Updated column mapping")
    schedule: str | None = Field(default=None, description="Updated cron schedule")
    status: str | None = Field(default=None, description="Updated status")


class ConnectorResponse(BaseModel):
    id: UUID
    project_id: UUID
    name: str
    connector_type: str
    config: dict = {}
    column_mapping: dict = {}
    schedule: str | None = None
    last_sync: datetime | None = None
    status: str
    error_message: str | None = None
    created_by: UUID
    created_at: datetime

    class Config:
        from_attributes = True


@router.get("", response_model=list[ConnectorResponse])
async def list_connectors(
    project_id: UUID | None = Query(default=None, description="Filter by project ID"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """List connectors, optionally filtered by project ID."""
    if project_id is not None:
        await assert_project_access(project_id, db, current_user)
    query = select(Connector)
    if project_id is not None:
        query = query.where(Connector.project_id == project_id)
    else:
        from app.models import Project, UserRole
        if current_user.role != UserRole.admin:
            accessible = select(Project.id).where(
                (Project.created_by == current_user.id)
                | (
                    (Project.team_id.is_not(None))
                    & (Project.team_id == current_user.team_id)
                )
            )
            query = query.where(Connector.project_id.in_(accessible))
    query = query.order_by(Connector.created_at.desc()).limit(limit).offset(offset)

    result = await db.execute(query)
    connectors = result.scalars().all()
    return connectors


@router.post("", response_model=ConnectorResponse, status_code=status.HTTP_201_CREATED)
async def create_connector(
    body: ConnectorCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Create a new data source connector."""
    await assert_project_access(body.project_id, db, current_user)
    try:
        ct = ConnectorType(body.connector_type)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid connector_type: {body.connector_type}. "
            f"Must be one of: {[e.value for e in ConnectorType]}",
        )

    from app.services.infra.secret_box import encrypt_connector_config

    connector = Connector(
        project_id=body.project_id,
        name=body.name,
        connector_type=ct,
        config=encrypt_connector_config(body.config),
        column_mapping=body.column_mapping,
        schedule=body.schedule,
        status=ConnectorStatus.inactive,
        created_by=current_user.id,
    )
    db.add(connector)
    await db.commit()
    await db.refresh(connector)
    return connector


@router.get("/{connector_id}", response_model=ConnectorResponse)
async def get_connector(
    connector_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Get a connector by ID."""
    result = await db.execute(
        select(Connector).where(Connector.id == connector_id)
    )
    connector = result.scalar_one_or_none()
    if connector is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Connector not found"
        )
    await assert_project_access(connector.project_id, db, current_user)
    return connector


@router.put("/{connector_id}", response_model=ConnectorResponse)
async def update_connector(
    connector_id: UUID,
    body: ConnectorUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Update a connector's configuration."""
    result = await db.execute(
        select(Connector).where(Connector.id == connector_id)
    )
    connector = result.scalar_one_or_none()
    if connector is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Connector not found"
        )
    await assert_project_access(connector.project_id, db, current_user)

    if body.name is not None:
        connector.name = body.name
    if body.config is not None:
        from app.services.infra.secret_box import encrypt_connector_config
        connector.config = encrypt_connector_config(body.config)
    if body.column_mapping is not None:
        connector.column_mapping = body.column_mapping
    if body.schedule is not None:
        connector.schedule = body.schedule
    if body.status is not None:
        try:
            connector.status = ConnectorStatus(body.status)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid status: {body.status}. "
                f"Must be one of: active, inactive, error",
            )

    await db.commit()
    await db.refresh(connector)
    return connector


@router.delete("/{connector_id}", status_code=status.HTTP_200_OK)
async def delete_connector(
    connector_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Delete a connector."""
    result = await db.execute(
        select(Connector).where(Connector.id == connector_id)
    )
    connector = result.scalar_one_or_none()
    if connector is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Connector not found"
        )
    await assert_project_access(connector.project_id, db, current_user)

    await db.delete(connector)
    await db.commit()

    return {"detail": "Connector deleted", "connector_id": str(connector_id)}


@router.post("/{connector_id}/test")
async def test_connector(
    connector_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Test the connector's connection to its data source."""
    result = await db.execute(
        select(Connector).where(Connector.id == connector_id)
    )
    connector = result.scalar_one_or_none()
    if connector is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Connector not found"
        )
    await assert_project_access(connector.project_id, db, current_user)

    try:
        service = _get_connector_service(connector.connector_type)
        from app.services.infra.secret_box import decrypt_connector_config
        test_result = await service.test_connection(decrypt_connector_config(connector.config))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Connector test failed: {e}", exc_info=True)
        test_result = {"success": False, "message": f"Test failed: {str(e)}"}

    # Update connector status based on test result
    if test_result.get("success"):
        connector.status = ConnectorStatus.active
        connector.error_message = None
    else:
        connector.status = ConnectorStatus.error
        connector.error_message = test_result.get("message", "Connection test failed")

    await db.commit()
    await db.refresh(connector)

    return test_result


@router.get("/{connector_id}/schema")
async def get_connector_schema(
    connector_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Introspect the connector's data source and return the available
    columns/fields so the frontend can offer column-mapping dropdowns
    instead of free-text inputs.

    The raw shape returned by each connector's ``get_schema()`` varies
    (some return ``{"tables": [...]}`` with per-table columns, others
    return flat lists of endpoints/resources/views). This endpoint
    normalizes a best-effort ``columns`` list of unique column names on
    top of the raw payload. If the connector lacks introspection or the
    source is unreachable, it returns an empty result rather than 500.
    """
    result = await db.execute(
        select(Connector).where(Connector.id == connector_id)
    )
    connector = result.scalar_one_or_none()
    if connector is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Connector not found"
        )
    await assert_project_access(connector.project_id, db, current_user)

    raw: dict = {}
    error_message: str | None = None
    try:
        service = _get_connector_service(connector.connector_type)
        from app.services.infra.secret_box import decrypt_connector_config
        schema = await service.get_schema(decrypt_connector_config(connector.config))
        if isinstance(schema, dict):
            raw = schema
    except HTTPException:
        raise
    except Exception as e:
        # Introspection is best-effort: a missing client library or an
        # unreachable source should degrade to an empty result, not 500.
        logger.warning(f"Connector schema introspection failed: {e}")
        error_message = str(e)

    # Normalize the varied get_schema() shapes into a flat list of unique
    # column/field names, preserving order of first appearance.
    columns: list[str] = []
    seen: set[str] = set()

    def _add(name: object) -> None:
        if isinstance(name, str) and name and name not in seen:
            seen.add(name)
            columns.append(name)

    for table in raw.get("tables", []) or []:
        if isinstance(table, dict):
            for col in table.get("columns", []) or []:
                if isinstance(col, dict):
                    _add(col.get("name"))
                else:
                    _add(col)
    # Connectors that expose endpoint/resource/view catalogs rather than
    # column lists (Workday, Coupa, Ariba, Oracle Fusion) — surface those
    # names too so the UI has something to offer.
    for key in ("columns", "fields", "endpoints", "resources", "views"):
        for item in raw.get(key, []) or []:
            if isinstance(item, dict):
                _add(item.get("name"))
            else:
                _add(item)

    return {
        "connector_id": str(connector_id),
        "connector_type": connector.connector_type.value,
        "columns": columns,
        "schema": raw,
        "error": error_message,
    }


@router.post("/{connector_id}/sync")
async def sync_connector(
    connector_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Manually trigger a data sync. Fetches data from the connector's source,
    creates or updates the associated EventLog.
    """
    result = await db.execute(
        select(Connector).where(Connector.id == connector_id)
    )
    connector = result.scalar_one_or_none()
    if connector is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Connector not found"
        )
    await assert_project_access(connector.project_id, db, current_user)

    try:
        service = _get_connector_service(connector.connector_type)
    except HTTPException:
        raise

    # Fetch data from the source. Decrypt the stored config first so
    # the connector service sees the real credentials — the DB stores
    # them encrypted when an encryption key is present.
    from app.services.infra.secret_box import decrypt_connector_config
    decrypted_config = decrypt_connector_config(connector.config)
    try:
        file_path = await service.fetch_data(
            config=decrypted_config,
            column_mapping=connector.column_mapping,
        )
    except Exception as e:
        connector.status = ConnectorStatus.error
        connector.error_message = f"Sync failed: {str(e)}"
        await db.commit()
        logger.error(f"Connector sync failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Data sync failed: {str(e)}",
        )

    # Create a new EventLog record for the synced data
    event_log = EventLog(
        project_id=connector.project_id,
        name=f"Sync: {connector.name} ({datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')})",
        file_path=file_path,
        source_type=SourceType.connector,
        status=EventLogStatus.ready,
    )

    # Apply column mapping — use connector's default if user didn't specify one
    col_map = connector.column_mapping
    if not col_map:
        col_map = service.get_default_column_mapping(connector.config) or {}
    if col_map:
        event_log.case_id_column = col_map.get("case_id_column")
        event_log.activity_column = col_map.get("activity_column")
        event_log.timestamp_column = col_map.get("timestamp_column")
        event_log.resource_column = col_map.get("resource_column")
        event_log.cost_column = col_map.get("cost_column")

    db.add(event_log)

    # Update connector status
    connector.status = ConnectorStatus.active
    connector.last_sync = datetime.now(timezone.utc)
    connector.error_message = None

    await db.commit()
    await db.refresh(event_log)
    await db.refresh(connector)

    # Trigger stats computation if column mapping is set
    if event_log.case_id_column:
        try:
            from app.workers.tasks import compute_event_log_stats
            compute_event_log_stats.delay(str(event_log.id))
        except Exception:
            pass  # Stats computation is non-critical

    return {
        "detail": "Sync completed successfully",
        "connector_id": str(connector_id),
        "event_log_id": str(event_log.id),
        "file_path": file_path,
    }
