from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class DashboardCreate(BaseModel):
    project_id: UUID = Field(..., description="Associated project ID")
    name: str = Field(..., min_length=1, description="Dashboard name")
    description: str | None = Field(default=None, description="Dashboard description")


class DashboardUpdate(BaseModel):
    name: str | None = Field(default=None, description="Updated dashboard name")
    description: str | None = Field(
        default=None, description="Updated dashboard description"
    )
    layout: dict | None = Field(
        default=None, description="Updated layout configuration"
    )
    widgets: list[dict] | None = Field(
        default=None, description="Updated widget list"
    )
    is_shared: bool | None = Field(
        default=None, description="Whether dashboard is shared"
    )


class DashboardResponse(BaseModel):
    id: UUID
    project_id: UUID
    name: str
    description: str | None = None
    layout: dict = {}
    widgets: list[dict] = []
    is_shared: bool = False
    share_token: str | None = None
    created_by: UUID
    created_at: datetime
    updated_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class WidgetConfig(BaseModel):
    id: str = Field(..., description="Unique widget identifier")
    type: str = Field(
        ...,
        description="Widget type (e.g., process_map, variant_chart, kpi_card, bottleneck_heatmap)",
    )
    title: str = Field(..., description="Widget display title")
    config: dict = Field(default={}, description="Widget-specific configuration")
    position: dict = Field(
        ...,
        description="Widget position with x, y, w, h properties",
    )
