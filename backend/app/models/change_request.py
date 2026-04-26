"""ChangeRequest model — SAP Signavio-style process governance.

When a project has ``governance_enabled`` (new Project flag — see the
governance migration) any edit to a dashboard / process model /
template goes through a ChangeRequest review+approve flow before being
persisted.

Lifecycle:
  draft → submitted → in_review → approved | rejected
  approved requests auto-apply if apply_on_approve is True.
"""

import uuid

from sqlalchemy import Column, DateTime, ForeignKey, String, Text, Boolean
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.sql import func

from app.database import Base


class ChangeRequest(Base):
    __tablename__ = "change_requests"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    # What entity this CR is changing
    entity_type = Column(String, nullable=False)  # "dashboard" | "template" | "action_rule" | ...
    entity_id = Column(String, nullable=False)  # as string so we can target builtin_* etc.
    title = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    # Serialized diff — before / after JSON blobs
    before_payload = Column(JSON, nullable=True)
    after_payload = Column(JSON, nullable=True)
    status = Column(String, nullable=False, default="draft")  # draft | submitted | in_review | approved | rejected
    reviewers = Column(JSON, default=[])  # list of user ids that can approve
    apply_on_approve = Column(Boolean, default=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    approver_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    rejection_reason = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
