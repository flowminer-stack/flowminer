import uuid

from sqlalchemy import Column, DateTime, ForeignKey, String, Float
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.sql import func

from app.database import Base


class CustomKPI(Base):
    __tablename__ = "custom_kpis"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    description = Column(String, nullable=True)
    # KPI definition: what to compute
    # metric: avg_case_duration, case_count, activity_frequency, rework_rate,
    #         conformance_fitness, bottleneck_count, variant_count,
    #         custom_expression
    metric = Column(String, nullable=False)
    # For custom_expression: a simple formula referencing built-in metrics
    # e.g., "avg_case_duration / 86400" (convert to days)
    expression = Column(String, nullable=True)
    # Optional filter: only compute for cases matching these conditions
    filters = Column(JSON, nullable=True)
    # Display config
    unit = Column(String, nullable=True)  # "days", "hours", "%", "$", etc.
    target_value = Column(Float, nullable=True)  # optional target for gauge display
    warning_threshold = Column(Float, nullable=True)
    critical_threshold = Column(Float, nullable=True)
    # Last computed value (cached)
    last_value = Column(Float, nullable=True)
    last_computed_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
