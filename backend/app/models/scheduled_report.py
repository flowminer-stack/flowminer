import enum
import uuid

from sqlalchemy import Column, DateTime, ForeignKey, String, Boolean, Integer
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from sqlalchemy import Enum as SQLEnum

from app.database import Base


class ReportFrequency(str, enum.Enum):
    daily = "daily"
    weekly = "weekly"
    monthly = "monthly"


class ReportFormat(str, enum.Enum):
    html = "html"
    csv = "csv"


class ScheduledReport(Base):
    __tablename__ = "scheduled_reports"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    event_log_id = Column(UUID(as_uuid=True), ForeignKey("event_logs.id"), nullable=False)
    name = Column(String, nullable=False)
    frequency = Column(SQLEnum(ReportFrequency), nullable=False, default=ReportFrequency.weekly)
    report_format = Column(SQLEnum(ReportFormat), nullable=False, default=ReportFormat.html)
    email_recipients = Column(JSON, default=[])
    include_sections = Column(JSON, default=["summary", "bottlenecks", "variants", "insights"])
    is_active = Column(Boolean, default=True)
    last_sent_at = Column(DateTime(timezone=True), nullable=True)
    send_count = Column(Integer, default=0)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    project = relationship("Project")
