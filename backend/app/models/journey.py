"""Journey model — customer / employee journey mapping à la SAP Signavio.

A journey is an ordered list of stages, each with a label, a sentiment
score (0-100), and an optional embedded widget config that pulls a live
KPI from the project's dashboards.
"""

import uuid

from sqlalchemy import Column, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.sql import func

from app.database import Base


class Journey(Base):
    __tablename__ = "journeys"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    # Journey type: "customer" | "employee" | "supplier" | "user"
    journey_type = Column(String, nullable=False, default="customer")
    # Stages as a JSON list of {id, label, sentiment, touchpoints, widgets}
    stages = Column(JSON, default=[])
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
