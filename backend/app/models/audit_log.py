"""Audit log — immutable record of every mutating action across the platform.

One row per non-GET request from an authenticated user. Used for:
- Compliance (who did what, when, from where)
- Incident investigation
- Undo / version-history context
- Security monitoring (spotting credential abuse)
"""

import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.sql import func

from app.database import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # Who
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    user_email = Column(String, nullable=True)  # Denormalized so audit survives user deletion

    # Where
    ip_address = Column(String, nullable=True)
    user_agent = Column(String, nullable=True)

    # What
    method = Column(String, nullable=False)  # POST / PUT / PATCH / DELETE
    path = Column(String, nullable=False, index=True)  # Request URL path
    status_code = Column(Integer, nullable=True)

    # Resource targeted (derived from URL path or request body)
    resource_type = Column(String, nullable=True, index=True)  # "project" / "event_log" / "dashboard" / ...
    resource_id = Column(String, nullable=True, index=True)  # UUID or other identifier

    # Optional context about what changed
    action = Column(String, nullable=True)  # "create" / "update" / "delete" / "execute" / ...
    payload_snapshot = Column(JSON, nullable=True)  # Sanitized request body (no passwords)

    # When
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)

    __table_args__ = (
        Index("ix_audit_logs_user_created", "user_id", "created_at"),
        Index("ix_audit_logs_resource", "resource_type", "resource_id", "created_at"),
    )
