import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base


class Annotation(Base):
    __tablename__ = "annotations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(
        UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False
    )
    event_log_id = Column(
        UUID(as_uuid=True), ForeignKey("event_logs.id"), nullable=False
    )
    activity_name = Column(String, nullable=True)
    edge_source = Column(String, nullable=True)
    edge_target = Column(String, nullable=True)
    content = Column(Text, nullable=False)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Threading: nullable FK back to the same table for replies
    parent_id = Column(
        UUID(as_uuid=True), ForeignKey("annotations.id"), nullable=True
    )

    # Resolution tracking
    resolved = Column(Boolean, nullable=False, default=False, server_default="false")
    resolved_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    resolved_at = Column(DateTime(timezone=True), nullable=True)

    # Assignment
    assignee_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
