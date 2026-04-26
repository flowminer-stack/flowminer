from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class AlertCreate(BaseModel):
    project_id: UUID = Field(..., description="Associated project ID")
    event_log_id: UUID = Field(..., description="Associated event log ID")
    name: str = Field(..., min_length=1, description="Alert name")
    metric: str = Field(..., description="Metric to monitor (e.g., avg_case_duration, bottleneck_count)")
    condition: str = Field(..., description="Condition: gt, lt, eq, gte, lte")
    threshold: float = Field(..., description="Threshold value for the condition")
    notification_channel: str = Field(
        default="email", description="Notification channel: email, webhook, slack"
    )
    webhook_url: str | None = Field(
        default=None, description="Webhook URL for webhook notifications"
    )
    email_recipients: list[str] | None = Field(
        default=None, description="Email addresses for email notifications"
    )


class AlertUpdate(BaseModel):
    name: str | None = Field(default=None, description="Updated alert name")
    metric: str | None = Field(default=None, description="Updated metric")
    condition: str | None = Field(default=None, description="Updated condition")
    threshold: float | None = Field(default=None, description="Updated threshold")
    is_active: bool | None = Field(default=None, description="Whether alert is active")
    notification_channel: str | None = Field(
        default=None, description="Updated notification channel"
    )
    webhook_url: str | None = Field(
        default=None, description="Updated webhook URL"
    )
    email_recipients: list[str] | None = Field(
        default=None, description="Updated email recipients"
    )


class AlertResponse(BaseModel):
    id: UUID
    project_id: UUID
    event_log_id: UUID
    name: str
    metric: str
    condition: str
    threshold: float
    is_active: bool
    notification_channel: str
    webhook_url: str | None = None
    email_recipients: list[str] = []
    last_triggered: datetime | None = None
    last_value: float | None = None
    created_by: UUID
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
