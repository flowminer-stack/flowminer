// ─── Search ──────────────────────────────────────────────────────────────────

export interface SearchResult {
  type: 'project' | 'event_log' | 'activity';
  id: string;
  name: string;
  description: string | null;
  parent_id: string | null;
  parent_name: string | null;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  total: number;
}

// ─── Data Quality ─────────────────────────────────────────────────────────────

export interface DataQualityIssue {
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  affected_count: number;
  affected_percentage: number;
}

export interface DataQualityResponse {
  overall_score: number;
  total_events: number;
  issues: DataQualityIssue[];
}

// ─── Analysis Hub ─────────────────────────────────────────────────────────────

// Performance DFG
export interface PerformanceDFGEdge { source: string; target: string; avg_duration: number; }
export interface PerformanceDFGResponse { edges: PerformanceDFGEdge[]; activities: string[]; }

// Eventually-Follows
export interface EFGPair { source: string; target: string; frequency: number; }
export interface EFGResponse { pairs: EFGPair[]; activities: string[]; }

// Temporal Profile
export interface TemporalProfileEntry { source: string; target: string; mean: number; stdev: number; }
export interface TemporalDeviation { case_id: string; activity_pair: string; expected: number; actual: number; is_deviation: boolean; }
export interface TemporalProfileResponse { profiles: TemporalProfileEntry[]; deviations: TemporalDeviation[]; }

// Batch Detection
export interface BatchInfo { activity: string; resource: string; batch_type: string; num_cases: number; }
export interface BatchResponse { batches: BatchInfo[]; }

// Case Overlap
export interface CaseOverlapResponse { overlaps: number[]; max_overlap: number; avg_overlap: number; }

// Org Roles
export interface OrgRole { activities: string[]; resources: string[]; }
export interface OrgRolesResponse { roles: OrgRole[]; }

// SNA
export interface SNAResponse { resources: string[]; matrix: number[][]; network_type: string; }

// Clustering
export interface CaseCluster { cluster_id: number; case_count: number; avg_duration: number; top_variant: string[]; }
export interface ClusterResponse { clusters: CaseCluster[]; }

// Log Skeleton
export interface LogSkeletonResponse { constraints: Record<string, unknown>; }

// DECLARE
export interface DeclareRule { template: string; activity_a: string; activity_b: string | null; support: number; confidence?: number | null; narrative?: string | null; }
export interface DeclareResponse { rules: DeclareRule[]; }

// Four-Eyes
export interface FourEyesResponse { violations: Array<{ case_id: string; resource: string }>; total_cases: number; violating_cases: number; }

// Performance Spectrum
export interface PerformanceSpectrumCase { case_id: string; events: Array<{ activity: string; timestamp: string }>; }
export interface PerformanceSpectrumResponse { cases: PerformanceSpectrumCase[]; }

// Feature Export
export interface FeatureExportResponse { columns: string[]; rows: Record<string, unknown>[]; total_cases: number; }

// ─── Insights ────────────────────────────────────────────────────────────────

export interface Insight {
  category: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  metric_value: number | null;
  recommendation: string | null;
  related_activities?: string[] | null;
  impact_estimate?: string | null;
}

export interface InsightsResponse {
  insights: Insight[];
  summary: string;
}

// ─── Concept Drift ────────────────────────────────────────────────────────────

export interface DriftWindowVariant {
  variant: string;
  count: number;
}

export interface DriftWindow {
  start: string;
  end: string;
  case_count: number;
  variant_count: number;
  top_variants: DriftWindowVariant[];
}

export interface DriftMagnitudeChange {
  edge: [string, string];
  before: number;
  after: number;
  delta: number;
}

export interface DriftPoint {
  window_index: number;
  timestamp: string;
  jsd: number;
  added_edges: [string, string][];
  removed_edges: [string, string][];
  magnitude_changes: DriftMagnitudeChange[];
}

export interface DriftSummary {
  total_windows: number;
  total_drifts: number;
  avg_jsd: number;
  max_jsd: number;
}

export interface DriftResponse {
  windows: DriftWindow[];
  drifts: DriftPoint[];
  summary: DriftSummary;
}

// ─── Queue Mining (M/M/c) ────────────────────────────────────────────────────

export interface WaitDecomposition {
  resource_contention_s: number;
  inter_batch_wait_s: number;
  external_dependency_s: number;
  processing_s: number;
}

export interface QueueActivity {
  activity: string;
  arrival_rate_per_hour: number;
  service_rate_per_hour: number;
  estimated_servers: number;
  utilization: number;
  expected_wait_time_s: number | null;
  actual_avg_wait_time_s: number;
  wait_decomposition: WaitDecomposition;
  queue_health: 'healthy' | 'strained' | 'saturated';
  stability: boolean;
}

export interface QueueSummary {
  max_utilization_activity: string | null;
  system_throughput_cases_per_hour: number;
}

export interface QueueMiningResponse {
  per_activity: QueueActivity[];
  summary: QueueSummary;
}

// ─── Competitive-parity endpoints ───────────────────────────────────────

export interface WhatIfBottleneckResponse {
  original_case_avg_seconds: number;
  new_case_avg_seconds: number;
  saving_per_case_seconds: number;
  total_saving_seconds: number;
  pct_improvement: number;
  activity_avg_dwell_seconds: number;
  activity_new_dwell_seconds: number;
  activity_occurrences: number;
  cases_affected: number;
  cases_total: number;
}

export interface AutomationCandidate {
  activity: string;
  frequency: number;
  avg_duration_seconds: number;
  total_time_seconds: number;
  score: number;
  estimated_hours_saved: number;
  estimated_cost_saved: number;
}

export interface AutomationCandidatesResponse {
  candidates: AutomationCandidate[];
  hourly_cost_used: number;
  automation_rate_used: number;
}

export interface VariantEvolutionResponse {
  buckets: Array<{
    period: string;
    total_cases: number;
    top_variants: Array<{ rank: number; signature: string; case_count: number }>;
  }>;
  granularity: string;
}

export interface AttributeHistogramResponse {
  attribute: string;
  buckets: Array<{ label: string; count: number; min: number | null; max: number | null }>;
  min: number | null;
  max: number | null;
  is_numeric: boolean;
}

export interface ActivityTreemapResponse {
  activity: string;
  split_by: string;
  cells: Array<{ label: string; value: number; avg_duration_seconds: number | null }>;
}

export interface CaseGanttResponse {
  cases: Array<{
    case_id: string;
    start: string;
    end: string;
    events: Array<{ activity: string; start: string; end: string }>;
  }>;
  total: number;
}

export interface CohortSignificanceResponse {
  results: Array<{
    metric: string;
    cohort_a_value: number;
    cohort_b_value: number;
    p_value: number | null;
    significant: boolean;
  }>;
}

export interface ComplianceMatrixResponse {
  segments: string[];
  rules: string[];
  cells: Array<{ rule: string; segment: string; pass_rate: number; cases: number }>;
}

export interface InterAppGraphResponse {
  apps: string[];
  edges: Array<{
    source_app: string;
    target_app: string;
    count: number;
    avg_dwell_seconds: number;
  }>;
}

export interface AppTeamHeatmapResponse {
  teams: string[];
  apps: string[];
  cells: Array<{ team: string; app: string; seconds: number }>;
}
