"""
Pydantic schemas for Object-Centric Event Log (OCEL) endpoints.
"""

from pydantic import BaseModel, Field


# --- Upload / Convert ---


class OCELUploadResponse(BaseModel):
    id: str = Field(..., description="Generated OCEL identifier")
    object_types: list[str] = Field(..., description="Object types found in the log")
    event_count: int = Field(..., description="Total number of events")
    object_count: int = Field(..., description="Total number of objects")


class OCELConvertRequest(BaseModel):
    object_type_columns: list[str] = Field(
        ...,
        description=(
            "Columns in the traditional event log that represent object types "
            "(e.g. ['customer_id', 'order_id', 'item_id'])"
        ),
    )


class OCELConvertResponse(BaseModel):
    ocel_id: str = Field(..., description="Generated OCEL identifier")
    object_types: list[str] = Field(..., description="Object types derived from the columns")
    event_count: int = Field(..., description="Total number of events")
    object_count: int = Field(..., description="Total number of objects")


# --- Summary ---


class OCELSummary(BaseModel):
    ocel_id: str
    object_types: list[str]
    event_count: int
    object_count: int
    activities: list[str]
    objects_per_type: dict[str, int] = Field(
        ..., description="Number of objects per object type"
    )


# --- OC-DFG Discovery ---


class OCDFGNode(BaseModel):
    id: str = Field(..., description="Unique node identifier (sanitised activity name)")
    label: str = Field(..., description="Human-readable activity label")
    object_type: str = Field(..., description="Object type this node belongs to")
    frequency: int = Field(..., description="Number of times this activity occurs")


class OCDFGEdge(BaseModel):
    source: str = Field(..., description="Source node ID")
    target: str = Field(..., description="Target node ID")
    object_type: str = Field(..., description="Object type this edge belongs to")
    frequency: int = Field(..., description="Number of times this transition occurs")


class OCDFGResponse(BaseModel):
    ocel_id: str
    nodes: list[OCDFGNode]
    edges: list[OCDFGEdge]
    object_types: list[str]
