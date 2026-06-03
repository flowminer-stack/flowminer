"""
Pydantic schemas for predictive / concept-drift detection endpoints.
"""

from pydantic import BaseModel, Field


# --- Concept Drift Detection ---


class DriftWindowVariant(BaseModel):
    variant: str
    count: int


class DriftWindow(BaseModel):
    start: str
    end: str
    case_count: int
    variant_count: int
    top_variants: list[DriftWindowVariant]


class DriftMagnitudeChange(BaseModel):
    edge: list[str] = Field(..., description="[source, target] activity pair")
    before: float
    after: float
    delta: float


class DriftPoint(BaseModel):
    window_index: int
    timestamp: str
    jsd: float = Field(..., description="Jensen-Shannon divergence in [0, 1]")
    added_edges: list[list[str]] = Field(default_factory=list)
    removed_edges: list[list[str]] = Field(default_factory=list)
    magnitude_changes: list[DriftMagnitudeChange] = Field(default_factory=list)


class DriftSummary(BaseModel):
    total_windows: int
    total_drifts: int
    avg_jsd: float
    max_jsd: float


class DriftResponse(BaseModel):
    windows: list[DriftWindow]
    drifts: list[DriftPoint]
    summary: DriftSummary
