from uuid import UUID

from pydantic import BaseModel, Field


# --- Process Filters ---


class AttributeFilter(BaseModel):
    column: str = Field(..., description="Column name to filter on")
    values: list[str] = Field(..., description="Accepted values (OR logic)")
    exclude: bool = Field(default=False, description="If true, exclude matching rows")


class ProcessFilter(BaseModel):
    """Filters applied to event log data before analysis."""
    time_start: str | None = Field(default=None, description="ISO datetime lower bound")
    time_end: str | None = Field(default=None, description="ISO datetime upper bound")
    duration_min: float | None = Field(default=None, description="Min case duration in seconds")
    duration_max: float | None = Field(default=None, description="Max case duration in seconds")
    activities_include: list[str] | None = Field(default=None, description="Only cases containing ALL these activities")
    activities_exclude: list[str] | None = Field(default=None, description="Exclude cases containing ANY of these activities")
    start_activities: list[str] | None = Field(default=None, description="Only cases starting with one of these")
    end_activities: list[str] | None = Field(default=None, description="Only cases ending with one of these")
    variants: list[int] | None = Field(default=None, description="Variant indices (0-based) to include")
    attributes: list[AttributeFilter] | None = Field(default=None, description="Attribute-based filters")
    required_edges: list[tuple[str, str]] | None = Field(
        default=None,
        description="Only cases whose trace contains EVERY listed [source, target] directly-follows pair",
    )
    forbidden_edges: list[tuple[str, str]] | None = Field(
        default=None,
        description="Exclude cases whose trace contains ANY listed [source, target] directly-follows pair",
    )


# --- Process Discovery ---


class DiscoveryRequest(BaseModel):
    event_log_id: UUID = Field(..., description="Event log to discover process from")
    algorithm: str = Field(
        default="dfg",
        description="Discovery algorithm: dfg, alpha, heuristic, inductive",
    )
    parameters: dict = Field(
        default={}, description="Algorithm-specific parameters"
    )
    filters: ProcessFilter | None = Field(
        default=None, description="Optional filters to apply before discovery"
    )


class ProcessNode(BaseModel):
    id: str = Field(..., description="Unique node identifier")
    label: str = Field(..., description="Activity label")
    frequency: int = Field(..., description="Number of occurrences")
    avg_duration: float | None = Field(
        default=None, description="Average duration in seconds"
    )
    median_duration: float | None = Field(
        default=None, description="Median duration in seconds"
    )
    is_start: bool = Field(default=False, description="Whether this is a start activity")
    is_end: bool = Field(default=False, description="Whether this is an end activity")


class ProcessEdge(BaseModel):
    source: str = Field(..., description="Source node ID")
    target: str = Field(..., description="Target node ID")
    frequency: int = Field(..., description="Number of traversals")
    avg_duration: float | None = Field(
        default=None, description="Average transition duration in seconds"
    )
    median_duration: float | None = Field(
        default=None, description="Median transition duration in seconds"
    )
    performance_color: str | None = Field(
        default=None, description="Color indicator for performance visualization"
    )


class DiscoveryResponse(BaseModel):
    event_log_id: UUID
    algorithm: str
    nodes: list[ProcessNode]
    edges: list[ProcessEdge]
    statistics: dict = Field(default={}, description="Additional algorithm statistics")


# --- Variant Analysis ---


class Variant(BaseModel):
    id: int = Field(..., description="Variant identifier")
    activities: list[str] = Field(..., description="Ordered list of activities")
    frequency: int = Field(..., description="Number of cases following this variant")
    percentage: float = Field(
        ..., description="Percentage of total cases"
    )
    avg_duration: float | None = Field(
        default=None, description="Average case duration in seconds"
    )
    min_duration: float | None = Field(
        default=None, description="Minimum case duration in seconds"
    )
    max_duration: float | None = Field(
        default=None, description="Maximum case duration in seconds"
    )


class VariantResponse(BaseModel):
    variants: list[Variant]
    total_cases: int
    total_variants: int


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


class BottleneckResponse(BaseModel):
    bottlenecks: list[Bottleneck]
    waiting_times: list[WaitingTime]


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


# --- Process Statistics ---


class ProcessStatistics(BaseModel):
    total_cases: int
    total_events: int
    total_activities: int
    avg_case_duration: float = Field(
        ..., description="Average case duration in seconds"
    )
    median_case_duration: float = Field(
        ..., description="Median case duration in seconds"
    )
    min_case_duration: float = Field(
        ..., description="Minimum case duration in seconds"
    )
    max_case_duration: float = Field(
        ..., description="Maximum case duration in seconds"
    )
    avg_events_per_case: float
    start_activities: list[dict] = Field(
        default=[], description="Start activities with frequencies"
    )
    end_activities: list[dict] = Field(
        default=[], description="End activities with frequencies"
    )
    activity_frequencies: list[dict] = Field(
        default=[], description="Activity frequency breakdown"
    )
    cases_over_time: list[dict] = Field(
        default=[], description="Cases over time series data"
    )
    sla_compliance: float | None = Field(
        default=None, description="SLA compliance percentage (0.0 to 100.0)"
    )


# --- Process Summary (Auto-analysis) ---


class ProcessSummary(BaseModel):
    statistics: ProcessStatistics
    top_variants: list[Variant]
    bottlenecks: list[Bottleneck]
    process_map: DiscoveryResponse


# --- Case Explorer ---


class CaseInfo(BaseModel):
    case_id: str
    event_count: int
    duration_seconds: float | None
    start_activity: str
    end_activity: str
    start_time: str
    end_time: str
    variant: str  # activities joined by " → "


class CaseListResponse(BaseModel):
    cases: list[CaseInfo]
    total_cases: int


# --- Case Detail ---


class CaseEvent(BaseModel):
    activity: str
    timestamp: str
    resource: str | None = None
    duration_to_next: float | None = None  # seconds until next event


class CaseDetailResponse(BaseModel):
    case_id: str
    events: list[CaseEvent]
    total_duration: float | None


# --- BPMN Export ---


class BPMNExportResponse(BaseModel):
    event_log_id: UUID
    bpmn_xml: str
    algorithm: str = "inductive"


# --- Events Timeline ---


class TimelineEvent(BaseModel):
    timestamp: str
    case_id: str
    activity: str
    source: str | None = None  # previous activity (for edge animation)


class TimelineResponse(BaseModel):
    events: list[TimelineEvent]
    start_time: str
    end_time: str
    total_events: int


# --- Dotted Chart ---


class DottedChartEvent(BaseModel):
    timestamp: str
    case_id: str
    activity: str
    resource: str | None = None
    case_index: int  # numeric index for Y-axis positioning


class DottedChartResponse(BaseModel):
    events: list[DottedChartEvent]
    activities: list[str]
    resources: list[str]
    case_count: int
    time_range: dict  # {start: str, end: str}


# --- Social Network ---


class SocialNetworkNode(BaseModel):
    id: str
    label: str
    frequency: int  # total events handled


class SocialNetworkEdge(BaseModel):
    source: str
    target: str
    frequency: int  # handover count


class SocialNetworkResponse(BaseModel):
    nodes: list[SocialNetworkNode]
    edges: list[SocialNetworkEdge]
    total_resources: int
    total_handovers: int


# --- Process Comparison ---


class ComparisonRequest(BaseModel):
    event_log_id: UUID
    split_attribute: str  # column name to split by
    split_value_a: str    # value for group A
    split_value_b: str    # value for group B


class ComparisonEdge(BaseModel):
    source: str
    target: str
    frequency_a: int
    frequency_b: int
    diff: int  # frequency_b - frequency_a
    status: str  # "added", "removed", "increased", "decreased", "unchanged"


class ComparisonNode(BaseModel):
    id: str
    label: str
    frequency_a: int
    frequency_b: int


class ComparisonResponse(BaseModel):
    nodes: list[ComparisonNode]
    edges: list[ComparisonEdge]
    stats_a: dict  # {total_cases, total_events, avg_duration}
    stats_b: dict


# --- Rework Detection ---


class ActivityRework(BaseModel):
    activity: str
    total_occurrences: int
    cases_with_rework: int
    total_cases: int
    rework_rate: float  # percentage of cases that have this activity more than once
    avg_repetitions: float


class ReworkResponse(BaseModel):
    activities: list[ActivityRework]
    overall_rework_rate: float  # % of cases with ANY rework
    cases_with_rework: int
    total_cases: int
    self_loops: list[dict]  # [{activity, count}] — immediate self-loops (A→A)


# --- Activity Detail ---


class ActivityDetailResponse(BaseModel):
    activity: str
    frequency: int
    case_count: int  # how many unique cases contain this activity
    avg_duration: float | None
    median_duration: float | None
    min_duration: float | None
    max_duration: float | None
    duration_histogram: list[dict]  # [{bin_start, bin_end, count}]
    resources: list[dict]  # [{name, count}] — resources that perform this activity
    predecessors: list[dict]  # [{activity, frequency}]
    successors: list[dict]  # [{activity, frequency}]
    is_start: bool
    is_end: bool


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


# --- Data Quality Report ---


class DataQualityIssue(BaseModel):
    severity: str = Field(
        ..., description="Issue severity: 'error', 'warning', 'info'"
    )
    category: str = Field(
        ...,
        description=(
            "Issue category: 'missing_values', 'duplicates', 'timestamps', "
            "'outliers'"
        ),
    )
    message: str = Field(..., description="Human-readable description of the issue")
    affected_count: int = Field(..., description="Number of affected events or cases")
    affected_percentage: float = Field(
        ..., description="Percentage of total events / cases affected"
    )


class DataQualityResponse(BaseModel):
    overall_score: float = Field(
        ..., description="Overall data quality score (0-100)"
    )
    total_events: int = Field(..., description="Total number of events in the log")
    issues: list[DataQualityIssue] = Field(
        default=[], description="List of identified data quality issues"
    )


# --- PDF / HTML Report ---


class ReportResponse(BaseModel):
    html: str = Field(..., description="HTML string of the generated report")
    event_log_name: str = Field(..., description="Name of the event log")


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


# --- Organizational Roles ---


class OrgRole(BaseModel):
    activities: list[str]
    resources: list[str]


class OrgRolesResponse(BaseModel):
    roles: list[OrgRole]


# --- SNA Networks ---


class SNAResponse(BaseModel):
    resources: list[str]
    matrix: list[list[float]]
    network_type: str


# --- Case Clustering ---


class ClusterInfo(BaseModel):
    cluster_id: int
    case_count: int
    avg_duration: float | None
    top_variant: list[str]


class ClusterRequest(BaseModel):
    n_clusters: int = Field(default=3, ge=2, le=20)


class ClusterResponse(BaseModel):
    clusters: list[ClusterInfo]


# --- Log Skeleton ---


class LogSkeletonResponse(BaseModel):
    constraints: dict


# --- DECLARE ---


class DeclareRule(BaseModel):
    template: str
    activity_a: str
    activity_b: str | None = None
    support: float


class DeclareResponse(BaseModel):
    rules: list[DeclareRule]


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


# --- Performance Spectrum ---


class PerformanceSpectrumEvent(BaseModel):
    activity: str
    timestamp: str


class PerformanceSpectrumCase(BaseModel):
    case_id: str
    events: list[PerformanceSpectrumEvent]


class PerformanceSpectrumResponse(BaseModel):
    cases: list[PerformanceSpectrumCase]


# --- Feature Export ---


class FeatureExportResponse(BaseModel):
    columns: list[str]
    rows: list[dict]
    total_cases: int


# --- Automated Insights ---


class Insight(BaseModel):
    category: str      # bottleneck, rework, conformance, variant, resource, performance, duration, waiting_time, automation, batch, workload, root_cause, timing_anomaly, cost
    severity: str      # critical, warning, info
    title: str
    description: str
    metric_value: float | None = None
    recommendation: str | None = None
    related_activities: list[str] | None = None
    impact_estimate: str | None = None


class InsightsResponse(BaseModel):
    insights: list[Insight]
    summary: str


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
