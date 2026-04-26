from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class EventLogResponse(BaseModel):
    id: UUID
    project_id: UUID
    name: str
    source_type: str
    log_type: str = "standard"
    object_types: list[str] = []
    case_id_column: str | None = None
    activity_column: str | None = None
    timestamp_column: str | None = None
    resource_column: str | None = None
    cost_column: str | None = None
    additional_columns: list[str] = []
    total_cases: int = 0
    total_events: int = 0
    total_activities: int = 0
    activities_list: list[str] = []
    status: str
    error_message: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ColumnMappingRequest(BaseModel):
    case_id_column: str = Field(..., description="Column name for case identifier")
    activity_column: str = Field(..., description="Column name for activity")
    timestamp_column: str = Field(..., description="Column name for timestamp")
    resource_column: str | None = Field(
        default=None, description="Column name for resource"
    )
    cost_column: str | None = Field(
        default=None, description="Column name for cost"
    )
    additional_columns: list[str] = Field(
        default=[], description="Additional columns to include"
    )


class EventLogPreview(BaseModel):
    columns: list[str] = Field(..., description="List of column names")
    sample_rows: list[dict] = Field(..., description="Sample data rows")
    total_rows: int = Field(..., description="Total number of rows in the file")
