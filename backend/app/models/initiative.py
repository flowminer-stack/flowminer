"""Value/ROI Tracker — tracks optimization initiatives and realized savings."""

import uuid

from sqlalchemy import Column, DateTime, Float, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.sql import func

from app.database import Base


class Initiative(Base):
    """A process optimization initiative tracked over time.

    Stores a baseline metric, a target, and a current (realized) value so
    the platform can surface ROI for each improvement effort.
    """

    __tablename__ = "initiatives"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    event_log_id = Column(UUID(as_uuid=True), ForeignKey("event_logs.id"), nullable=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    # What metric this initiative targets
    # avg_case_duration, rework_rate, throughput, cost_per_case, fitness,
    # bottleneck_duration, activity_frequency, custom
    metric = Column(String, nullable=False)
    unit = Column(String, nullable=True)  # "days", "%", "$"
    baseline_value = Column(Float, nullable=False)
    baseline_at = Column(DateTime(timezone=True), nullable=True)
    target_value = Column(Float, nullable=False)
    current_value = Column(Float, nullable=True)
    last_measured_at = Column(DateTime(timezone=True), nullable=True)
    # Financial modeling
    value_per_unit_improvement = Column(Float, nullable=True)  # $/unit saved
    estimated_annual_savings = Column(Float, nullable=True)
    # "planning" | "active" | "achieved" | "cancelled"
    status = Column(String, nullable=False, default="active")
    # Optional list of activities / variants / cases this initiative targets
    scope = Column(JSON, nullable=True)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
