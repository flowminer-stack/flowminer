"""
Pydantic schemas for performance, bottleneck and queue-mining endpoints.
"""

from pydantic import BaseModel, Field


# --- Bottleneck Analysis ---


class Bottleneck(BaseModel):
    activity: str = Field(..., description="Activity name")
    avg_duration: float = Field(..., description="Average duration in seconds")
    median_duration: float = Field(..., description="Median duration in seconds")
    frequency: int = Field(..., description="Number of occurrences")
    is_bottleneck: bool = Field(
        ..., description="Whether this activity is classified as a bottleneck"
    )
    severity: str = Field(
        ..., description="Bottleneck severity: low, medium, high, critical"
    )


class WaitingTime(BaseModel):
    source: str = Field(..., description="Source activity")
    target: str = Field(..., description="Target activity")
    avg_waiting: float = Field(..., description="Average waiting time in seconds")
    median_waiting: float = Field(..., description="Median waiting time in seconds")
    max_waiting: float = Field(..., description="Maximum waiting time in seconds")
    frequency: int = Field(..., description="Number of transitions observed")


class DBSMScore(BaseModel):
    activity: str = Field(..., description="Activity name")
    dbsm_score: float = Field(..., description="DBSM composite score 0-100")
    delay_component: float = Field(..., description="Delay component score 0-100")
    pressure_component: float = Field(..., description="Resource pressure component score 0-100")
    impact_component: float = Field(..., description="Cycle-time impact component score 0-100")
    rank: int = Field(..., description="Rank by DBSM score (1 = worst)")


class BottleneckResponse(BaseModel):
    bottlenecks: list[Bottleneck]
    waiting_times: list[WaitingTime]
    dbsm_scores: list[DBSMScore] = Field(default_factory=list)


# --- Performance DFG ---


class PerformanceDFGEdge(BaseModel):
    source: str
    target: str
    avg_duration: float  # seconds


class PerformanceDFGResponse(BaseModel):
    edges: list[PerformanceDFGEdge]
    activities: list[str]


# --- Eventually-Follows Graph ---


class EFGPair(BaseModel):
    source: str
    target: str
    frequency: int


class EFGResponse(BaseModel):
    pairs: list[EFGPair]
    activities: list[str]


# --- Temporal Profile ---


class TemporalProfileEntry(BaseModel):
    source: str
    target: str
    mean: float   # seconds
    stdev: float  # seconds


class TemporalDeviation(BaseModel):
    case_id: str
    activity_pair: list[str]  # [source, target]
    expected: float           # mean ± zeta*stdev
    actual: float
    is_deviation: bool


class TemporalProfileResponse(BaseModel):
    profiles: list[TemporalProfileEntry]
    deviations: list[TemporalDeviation]


# --- Batch Detection ---


class BatchInfo(BaseModel):
    activity: str
    resource: str
    batch_type: str
    num_cases: int
    start_time: str | None = None
    end_time: str | None = None


class BatchResponse(BaseModel):
    batches: list[BatchInfo]


# --- Case Overlap ---


class CaseOverlapResponse(BaseModel):
    overlaps: list[int]
    max_overlap: int
    avg_overlap: float


# --- Performance Spectrum ---


class PerformanceSpectrumEvent(BaseModel):
    activity: str
    timestamp: str


class PerformanceSpectrumCase(BaseModel):
    case_id: str
    events: list[PerformanceSpectrumEvent]


class PerformanceSpectrumResponse(BaseModel):
    cases: list[PerformanceSpectrumCase]


# --- Queue Mining (M/M/c) ---


class WaitDecomposition(BaseModel):
    resource_contention_s: float = Field(..., description="Estimated wait due to resource contention (M/M/c Erlang-C model)")
    inter_batch_wait_s: float = Field(..., description="Estimated wait due to inter-batch arrival clustering")
    external_dependency_s: float = Field(..., description="Residual wait (external dependencies / other)")
    processing_s: float = Field(..., description="Mean activity service/processing time")


class QueueActivity(BaseModel):
    activity: str = Field(..., description="Activity name")
    arrival_rate_per_hour: float = Field(..., description="Arrival rate lambda (arrivals/hour)")
    service_rate_per_hour: float = Field(..., description="Service rate mu (completions/hour per server)")
    estimated_servers: int = Field(..., description="Estimated server count c (distinct resources)")
    utilization: float = Field(..., description="Traffic intensity rho = lambda / (c * mu), clamped to 0.999")
    expected_wait_time_s: float | None = Field(default=None, description="E[Wq] from M/M/c Erlang-C formula (seconds); null if unstable")
    actual_avg_wait_time_s: float = Field(..., description="Observed average waiting time before this activity (seconds)")
    wait_decomposition: WaitDecomposition
    queue_health: str = Field(..., description="healthy (rho<0.7) | strained (0.7-0.9) | saturated (>0.9)")
    stability: bool = Field(..., description="True if rho < 1 (system is stable)")


class QueueSummary(BaseModel):
    max_utilization_activity: str | None = Field(default=None, description="Activity with highest utilization")
    system_throughput_cases_per_hour: float = Field(..., description="Overall case throughput (cases/hour)")


class QueueMiningResponse(BaseModel):
    per_activity: list[QueueActivity]
    summary: QueueSummary
