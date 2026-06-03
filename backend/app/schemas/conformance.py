"""
Pydantic schemas for conformance checking, root-cause and stochastic-conformance endpoints.
"""

from uuid import UUID

from pydantic import BaseModel, Field


# --- Conformance Checking ---


class ConformanceRequest(BaseModel):
    event_log_id: UUID = Field(..., description="Event log to check conformance for")
    reference_model: dict | None = Field(
        default=None, description="Reference process model as a dict"
    )
    template_id: UUID | None = Field(
        default=None, description="Process template ID to check against"
    )


class Deviation(BaseModel):
    case_id: str = Field(..., description="Case identifier with deviation")
    deviation_type: str = Field(
        ..., description="Type of deviation (e.g., missing_activity, extra_activity, wrong_order)"
    )
    expected: str | None = Field(
        default=None, description="Expected activity or behavior"
    )
    actual: str | None = Field(
        default=None, description="Actual activity or behavior"
    )
    activity: str | None = Field(
        default=None, description="Activity involved in the deviation"
    )


class ConformanceResponse(BaseModel):
    fitness: float = Field(..., description="Fitness score (0.0 to 1.0)")
    precision: float | None = Field(
        default=None, description="Precision score (0.0 to 1.0)"
    )
    generalization: float | None = Field(
        default=None, description="Generalization score (0.0 to 1.0)"
    )
    deviations: list[Deviation]
    conformant_cases: int = Field(
        ..., description="Number of fully conformant cases"
    )
    total_cases: int = Field(..., description="Total number of cases analyzed")


# --- Root Cause Analysis ---


class RootCauseFactor(BaseModel):
    attribute: str = Field(..., description="Attribute name")
    value: str = Field(..., description="Attribute value")
    impact: str = Field(
        ..., description="Impact level: low, medium, high, critical"
    )
    avg_duration_affected: float = Field(
        ..., description="Average duration for affected cases in seconds"
    )
    avg_duration_normal: float = Field(
        ..., description="Average duration for normal cases in seconds"
    )
    case_count: int = Field(
        ..., description="Number of cases with this attribute value"
    )


class Correlation(BaseModel):
    attribute: str = Field(..., description="Attribute name")
    correlation_value: float = Field(
        ..., description="Correlation coefficient (-1.0 to 1.0)"
    )
    p_value: float = Field(..., description="Statistical p-value")


class RootCauseResponse(BaseModel):
    factors: list[RootCauseFactor]
    correlations: list[Correlation]


# --- Four-Eyes Principle ---


class FourEyesRequest(BaseModel):
    activity1: str
    activity2: str


class FourEyesViolation(BaseModel):
    case_id: str
    resource: str


class FourEyesResponse(BaseModel):
    violations: list[FourEyesViolation]
    total_cases: int
    violating_cases: int


# --- Stochastic Conformance (EMD-based) ---
# Ref: Polyvyanyy et al., "Earth Movers' Stochastic Conformance"
#      Information Systems 2021.


class DeviatingVariant(BaseModel):
    """Per-variant deviation entry from stochastic conformance analysis."""

    variant: list[str] = Field(
        ...,
        description="Ordered list of activity labels constituting the trace variant",
    )
    log_frequency: float = Field(
        ...,
        description="Relative frequency of this variant in the event log (sums to 1.0 across all variants)",
    )
    model_probability: float = Field(
        ...,
        description="Estimated probability of this variant under the stochastic process model",
    )
    contribution: float = Field(
        ...,
        description="Absolute difference |log_frequency - model_probability| — higher means more deviation",
    )


class SeverityBreakdown(BaseModel):
    """Counts of variants bucketed by deviation severity."""

    minor: int = Field(..., description="Variants with |Δ| < 0.05 (negligible frequency mismatch)")
    moderate: int = Field(..., description="Variants with 0.05 ≤ |Δ| < 0.15")
    severe: int = Field(..., description="Variants with |Δ| ≥ 0.15 (material frequency deviation)")


class StochasticConformanceResponse(BaseModel):
    """Response model for GET /conformance/{event_log_id}/stochastic.

    Captures the Earth Mover's Distance (EMD) between the log's empirical
    variant distribution and the model's sampled stochastic language.
    Lower EMD = log behaviour more closely matches the model.
    """

    emd_distance: float = Field(
        ...,
        description="Earth Mover's Distance in [0, 1]; 0 = perfect distributional fit",
    )
    stochastic_fitness: float = Field(
        ...,
        description="1 - emd_distance; in [0, 1], higher = better distributional fit",
    )
    top_deviating_variants: list[DeviatingVariant] = Field(
        ...,
        description="Up to 20 variants sorted by |log_frequency - model_probability| descending",
    )
    severity_breakdown: SeverityBreakdown = Field(
        ...,
        description="Counts of all variants bucketed by deviation severity",
    )
    log_variants_count: int = Field(
        ..., description="Total number of distinct trace variants observed in the event log"
    )
    model_traces_sampled: int = Field(
        ...,
        description="Number of traces sampled from the model during stochastic playout",
    )
