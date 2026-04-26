from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ProjectCreate(BaseModel):
    name: str = Field(..., min_length=1, description="Project name")
    description: str | None = Field(default=None, description="Project description")
    team_id: UUID | None = Field(default=None, description="Associated team ID")


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, description="Updated project name")
    description: str | None = Field(default=None, description="Updated description")


class ProjectResponse(BaseModel):
    id: UUID
    name: str
    description: str | None = None
    team_id: UUID | None = None
    created_by: UUID
    created_at: datetime
    updated_at: datetime | None = None
    event_log_count: int = 0
    # Count of ready standard event logs that have a cost column mapped.
    # Used by the frontend ProjectsPage filters to hide / surface
    # projects by whether they have cost data available.
    cost_log_count: int = 0
    # Count of ready OCEL logs in this project.
    ocel_log_count: int = 0

    model_config = ConfigDict(from_attributes=True)
