import uuid

from sqlalchemy import Column, DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base


class CaseTag(Base):
    __tablename__ = "case_tags"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_log_id = Column(UUID(as_uuid=True), ForeignKey("event_logs.id"), nullable=False, index=True)
    case_id = Column(String, nullable=False, index=True)
    tag = Column(String, nullable=False)
    color = Column(String, nullable=True, default="#06b6d4")
    note = Column(String, nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
