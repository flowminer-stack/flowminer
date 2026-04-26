"""Usage metering — per-team consumption tracking.

Records billable-ish events: mining minutes, LLM tokens, connector syncs,
event counts. Used by the admin usage page and (eventually) billing.
"""

import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Float
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base


class UsageEvent(Base):
    __tablename__ = "usage_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    team_id = Column(UUID(as_uuid=True), ForeignKey("teams.id"), nullable=True, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True, index=True)
    # Event kind — one of "mining_minutes", "llm_tokens", "connector_sync",
    # "event_ingested", "task_event", "api_call".
    kind = Column(String, nullable=False, index=True)
    # Numeric value for the event (minutes, tokens, rows, ...)
    quantity = Column(Float, nullable=False, default=0)
    resource_type = Column(String, nullable=True)
    resource_id = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
