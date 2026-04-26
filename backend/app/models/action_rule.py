"""Process Execution Management — rule-based actions triggered by conditions."""

import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.sql import func

from app.database import Base


class ActionRule(Base):
    """An IF-THEN rule that triggers an action when a condition on a case is met.

    Conditions are expressed declaratively (e.g. case is still open AND
    duration > 5 days AND currently on activity "Approval"). Actions are
    named handlers (e.g. notify, escalate, webhook, create_task).
    """

    __tablename__ = "action_rules"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    event_log_id = Column(UUID(as_uuid=True), ForeignKey("event_logs.id"), nullable=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    # condition: dict with keys { metric, operator, value, current_activity, etc. }
    # Supported metrics: case_duration, time_on_activity, rework_count,
    #                    waiting_time, pending_cases, attribute_equals
    # Supported operators: gt, gte, lt, lte, eq, neq, in, not_in
    condition = Column(JSON, nullable=False)
    # action: dict with keys { type, params }
    # Supported action types: notify_email, notify_webhook, create_task,
    #                         tag_case, escalate, reassign
    action = Column(JSON, nullable=False)
    # Execution tracking
    trigger_count = Column(Integer, nullable=False, default=0)
    last_triggered_at = Column(DateTime(timezone=True), nullable=True)
    cooldown_seconds = Column(Integer, nullable=False, default=3600)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ActionRuleExecution(Base):
    """History of every time an ActionRule fired against a specific case."""

    __tablename__ = "action_rule_executions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rule_id = Column(UUID(as_uuid=True), ForeignKey("action_rules.id", ondelete="CASCADE"), nullable=False, index=True)
    case_id = Column(String, nullable=False)
    triggered_at = Column(DateTime(timezone=True), server_default=func.now())
    success = Column(Boolean, nullable=False, default=True)
    details = Column(JSON, nullable=True)
