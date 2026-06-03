"""
Pydantic schemas for process simulation / what-if and discrete-event-simulation endpoints.
"""

from uuid import UUID

from pydantic import BaseModel, Field


# --- Process Simulation / What-If Analysis ---


class SimulationModification(BaseModel):
    type: str = Field(
        ...,
        description="Modification type: duration_scale, remove_activity, adjust_frequency",
    )
    activity: str = Field(..., description="Target activity name")
    value: float = Field(
        ...,
        description=(
            "Modification value: scale factor for duration_scale, "
            "percentage (0-100) for adjust_frequency, ignored for remove_activity"
        ),
    )


class SimulationRequest(BaseModel):
    event_log_id: UUID = Field(..., description="Event log to simulate from")
    num_traces: int = Field(
        default=500,
        ge=1,
        le=5000,
        description="Number of synthetic traces to generate via Petri net playout",
    )
    modifications: list[SimulationModification] = Field(
        default=[],
        description="List of what-if modifications to apply to the simulated log",
    )


class SimulationStats(BaseModel):
    total_cases: int = Field(..., description="Number of cases")
    total_events: int = Field(..., description="Total number of events")
    avg_case_duration: float = Field(
        ..., description="Average case duration in seconds"
    )
    median_case_duration: float = Field(
        ..., description="Median case duration in seconds"
    )
    avg_events_per_case: float = Field(..., description="Average events per case")
    activities: list[dict] = Field(
        default=[],
        description="Per-activity stats: [{name, frequency, avg_duration}]",
    )


class SimulationResponse(BaseModel):
    original: SimulationStats
    simulated: SimulationStats
    improvement: dict = Field(
        ...,
        description=(
            "Comparison metrics: {avg_duration_change_pct, "
            "case_count_change, activities_removed}"
        ),
    )


# --- Discrete-Event Simulation (DES) ---


class DESScenario(BaseModel):
    """What-if scenario for the DES engine."""
    arrival_rate_multiplier: float = Field(
        default=1.0,
        description="Multiply arrival rate (>1 = more cases per day)",
    )
    activity_duration_overrides: dict[str, float] = Field(
        default={},
        description="Per-activity duration multiplier (0.5 = 2x faster)",
    )
    activity_automation: dict[str, bool] = Field(
        default={},
        description="Mark activity as automated (duration → 0)",
    )
    resource_pool_overrides: dict[str, int] = Field(
        default={},
        description="Override capacity for named resource pools",
    )
    new_resources: list[dict] = Field(
        default=[],
        description="Add new resource pools [{name: str, capacity: int}]",
    )


class DESSummary(BaseModel):
    avg_case_duration_s: float
    p50: float
    p90: float
    p95: float
    throughput_cases_per_day: float
    max_concurrent_cases: int
    resource_utilization: dict[str, float]


class DESSimulationResponse(BaseModel):
    summary: DESSummary
    baseline: DESSummary
    delta: dict[str, float]
    runs: int
