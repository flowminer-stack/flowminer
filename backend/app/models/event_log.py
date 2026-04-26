import enum
import uuid

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum as SQLEnum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class SourceType(str, enum.Enum):
    upload = "upload"
    connector = "connector"
    api = "api"


class LogType(str, enum.Enum):
    standard = "standard"
    ocel = "ocel"


class EventLogStatus(str, enum.Enum):
    processing = "processing"
    ready = "ready"
    error = "error"


class EventLog(Base):
    __tablename__ = "event_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(
        UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False
    )
    name = Column(String, nullable=False)
    file_path = Column(String, nullable=True)
    source_type = Column(
        SQLEnum(SourceType), default=SourceType.upload, nullable=False
    )
    # NOTE: stored as VARCHAR (not an enum type) in PostgreSQL — predates the
    # alembic migration regime. We keep the LogType enum as a Python-side
    # helper but bind it to String to match the actual DB column type.
    log_type = Column(
        String, default=LogType.standard.value, nullable=False, server_default="standard"
    )

    # Object types (OCEL only)
    object_types = Column(JSON, default=[])

    # Column mapping
    case_id_column = Column(String, nullable=True)
    activity_column = Column(String, nullable=True)
    timestamp_column = Column(String, nullable=True)
    resource_column = Column(String, nullable=True)
    cost_column = Column(String, nullable=True)
    additional_columns = Column(JSON, default=[])

    # Computed statistics
    total_cases = Column(Integer, default=0)
    total_events = Column(Integer, default=0)
    total_activities = Column(Integer, default=0)
    activities_list = Column(JSON, default=[])

    # Status tracking
    status = Column(
        SQLEnum(EventLogStatus), default=EventLogStatus.processing, nullable=False
    )
    error_message = Column(Text, nullable=True)

    # Derived logs (e.g. OCEL flattening) are persisted but hidden from the
    # project file list so they don't clutter it.
    hidden = Column(Boolean, nullable=False, default=False, server_default="false")

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    project = relationship("Project", back_populates="event_logs")

    __table_args__ = (
        # Project detail page list query: filter by project + hidden, sort by created_at desc
        Index("ix_event_logs_project_hidden_created", "project_id", "hidden", "created_at"),
    )
