import uuid

from sqlalchemy import Column, DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.sql import func

from app.database import Base


class VersionHistory(Base):
    __tablename__ = "version_history"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Polymorphic: what entity this version belongs to
    entity_type = Column(String, nullable=False, index=True)  # "dashboard", "alert", "kpi", "connector"
    entity_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    # Version data
    version_number = Column(String, nullable=False)  # e.g., "v1", "v2", ...
    snapshot = Column(JSON, nullable=False)  # full JSON snapshot of the entity at this point
    change_summary = Column(String, nullable=True)  # e.g., "Updated layout widgets"
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
