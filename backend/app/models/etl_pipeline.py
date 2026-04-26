import uuid

from sqlalchemy import Column, DateTime, ForeignKey, String, Integer
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.sql import func

from app.database import Base


class ETLPipeline(Base):
    """A reusable data transformation pipeline that can be applied to event logs."""
    __tablename__ = "etl_pipelines"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    description = Column(String, nullable=True)
    # Ordered list of transformation steps
    # Each step: {"type": "filter_rows"|"rename_column"|"join"|"derive_column"|"drop_column"|"cast_type"|"fill_missing"|"deduplicate",
    #             ...step-specific params}
    steps = Column(JSON, default=[])
    # Source event log ID (optional — can be applied to any log)
    source_event_log_id = Column(UUID(as_uuid=True), ForeignKey("event_logs.id"), nullable=True)
    # Execution state
    last_run_at = Column(DateTime(timezone=True), nullable=True)
    last_run_rows = Column(Integer, nullable=True)
    last_run_status = Column(String, nullable=True)  # "success", "error"
    last_run_error = Column(String, nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
