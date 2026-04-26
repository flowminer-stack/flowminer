import uuid

from sqlalchemy import Column, DateTime, ForeignKey, String, Boolean
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.sql import func

from app.database import Base


class PrivacyConfig(Base):
    """Per-project privacy and anonymization configuration."""
    __tablename__ = "privacy_configs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, unique=True, index=True)
    # Which columns to anonymize (hash/mask resource names, case IDs, etc.)
    anonymize_resources = Column(Boolean, default=False)
    anonymize_case_ids = Column(Boolean, default=False)
    # Specific columns to mask (list of column names)
    masked_columns = Column(JSON, default=[])
    # Role-based visibility: which roles can see raw data
    # "admin" always sees raw data; this controls analyst/viewer
    viewer_sees_raw = Column(Boolean, default=True)
    analyst_sees_raw = Column(Boolean, default=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
