"""Operational task — items in the user's inbox, typically created by
action rules when a process condition fires (e.g. "case exceeded SLA",
"duplicate invoice detected"). Users work through their inbox and
resolve / snooze / reassign items.
"""

import uuid

from sqlalchemy import Column, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.sql import func

from app.database import Base


# Status lifecycle: open -> in_progress -> (closed | resolved)
# Users can also snooze (open -> snoozed -> open) to hide until a later
# date.
TASK_STATUSES = ("open", "in_progress", "snoozed", "closed", "resolved")
TASK_PRIORITIES = ("low", "medium", "high", "urgent")


class Task(Base):
    __tablename__ = "tasks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(
        UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True
    )
    event_log_id = Column(
        UUID(as_uuid=True), ForeignKey("event_logs.id"), nullable=True, index=True
    )
    case_id = Column(String, nullable=True, index=True)

    title = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    priority = Column(String, nullable=False, default="medium")
    status = Column(String, nullable=False, default="open", index=True)

    assignee_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    source_rule_id = Column(
        UUID(as_uuid=True), ForeignKey("action_rules.id"), nullable=True
    )
    context = Column(JSON, nullable=True)  # arbitrary metadata (finding payload, etc.)

    created_by = Column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    snoozed_until = Column(DateTime(timezone=True), nullable=True)
    resolved_at = Column(DateTime(timezone=True), nullable=True)
