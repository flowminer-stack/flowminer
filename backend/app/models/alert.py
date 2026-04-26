import enum
import uuid

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum as SQLEnum,
    Float,
    ForeignKey,
    String,
)
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class AlertCondition(str, enum.Enum):
    gt = "gt"
    lt = "lt"
    eq = "eq"
    gte = "gte"
    lte = "lte"


class NotificationChannel(str, enum.Enum):
    email = "email"
    webhook = "webhook"
    slack = "slack"
    teams = "teams"
    in_app = "in_app"


class Alert(Base):
    __tablename__ = "alerts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(
        UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False
    )
    event_log_id = Column(
        UUID(as_uuid=True), ForeignKey("event_logs.id"), nullable=False
    )
    name = Column(String, nullable=False)
    metric = Column(String, nullable=False)
    condition = Column(SQLEnum(AlertCondition), nullable=False)
    threshold = Column(Float, nullable=False)
    is_active = Column(Boolean, default=True)
    notification_channel = Column(
        SQLEnum(NotificationChannel),
        default=NotificationChannel.email,
        nullable=False,
    )
    webhook_url = Column(String, nullable=True)
    email_recipients = Column(JSON, default=[])
    last_triggered = Column(DateTime(timezone=True), nullable=True)
    last_value = Column(Float, nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    project = relationship("Project", back_populates="alerts")
