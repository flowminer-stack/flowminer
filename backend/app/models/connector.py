import enum
import uuid

from sqlalchemy import Column, DateTime, Enum as SQLEnum, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.sql import func

from app.database import Base


class ConnectorType(str, enum.Enum):
    postgresql = "postgresql"
    mysql = "mysql"
    sqlserver = "sqlserver"
    csv_watch = "csv_watch"
    api_endpoint = "api_endpoint"
    jira = "jira"
    github = "github"
    odoo = "odoo"
    zendesk = "zendesk"
    # Enterprise connectors
    sap = "sap"
    salesforce = "salesforce"
    servicenow = "servicenow"
    snowflake = "snowflake"
    bigquery = "bigquery"
    oracle = "oracle"
    dynamics365 = "dynamics365"
    workday = "workday"
    oracle_fusion = "oracle_fusion"
    coupa = "coupa"
    ariba = "ariba"


class ConnectorStatus(str, enum.Enum):
    active = "active"
    inactive = "inactive"
    error = "error"


class Connector(Base):
    __tablename__ = "connectors"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(
        UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False
    )
    name = Column(String, nullable=False)
    connector_type = Column(SQLEnum(ConnectorType), nullable=False)
    config = Column(JSON, default={})
    column_mapping = Column(JSON, default={})
    schedule = Column(String, nullable=True)
    last_sync = Column(DateTime(timezone=True), nullable=True)
    status = Column(
        SQLEnum(ConnectorStatus), default=ConnectorStatus.inactive, nullable=False
    )
    error_message = Column(Text, nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
