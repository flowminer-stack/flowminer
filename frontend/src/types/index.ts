// ─── Auth ────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: 'admin' | 'analyst' | 'viewer';
  team_id: string | null;
  is_active: boolean;
  created_at: string;
}

export interface Team {
  id: string;
  name: string;
  created_at: string;
  member_count: number;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  full_name: string;
  role?: string;
}

export interface Token {
  access_token: string;
  token_type: string;
}

// ─── Project ─────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  description: string | null;
  team_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  event_log_count: number;
  cost_log_count: number;
  ocel_log_count: number;
}

export interface ProjectCreate {
  name: string;
  description?: string;
  team_id?: string;
}

// ─── Event Log ───────────────────────────────────────────────────────────────

export interface EventLog {
  id: string;
  project_id: string;
  name: string;
  source_type: 'upload' | 'connector' | 'api';
  log_type: 'standard' | 'ocel';
  object_types: string[];
  case_id_column: string | null;
  activity_column: string | null;
  timestamp_column: string | null;
  resource_column: string | null;
  cost_column: string | null;
  additional_columns: string[];
  total_cases: number;
  total_events: number;
  total_activities: number;
  activities_list: string[];
  status: 'processing' | 'ready' | 'error';
  error_message: string | null;
  created_at: string;
}

export interface ColumnMapping {
  case_id_column: string;
  activity_column: string;
  timestamp_column: string;
  resource_column?: string;
  cost_column?: string;
  additional_columns?: string[];
}

export interface EventLogPreview {
  columns: string[];
  sample_rows: Record<string, unknown>[];
  total_rows: number;
}

export interface TimestampRepairResult {
  ties_fixed: number;
  inversions_fixed: number;
  outliers_found: number;
  rows_total: number;
}

// ─── Mining ──────────────────────────────────────────────────────────────────

export interface ProcessNode {
  id: string;
  label: string;
  frequency: number;
  avg_duration: number | null;
  median_duration: number | null;
  is_start: boolean;
  is_end: boolean;
}

export interface ProcessEdge {
  source: string;
  target: string;
  frequency: number;
  avg_duration: number | null;
  median_duration: number | null;
  performance_color: string | null;
}

export interface AttributeFilter {
  column: string;
  values: string[];
  exclude?: boolean;
}

export interface EdgeStatsResponse {
  source: string;
  target: string;
  frequency: number;
  case_count_with: number;
  case_count_without: number;
  coverage_pct: number;
  avg_duration: number;
  median_duration: number;
  p95_duration: number;
  min_duration: number;
  max_duration: number;
  histogram: Array<{ bin_start: number; bin_end: number; count: number }>;
  // True when the backend couldn't find a direct A→B transition in
  // the log and fell back to eventually-follows stats (common for
  // edges in inductive / heuristic miner output that represent
  // abstracted control flow rather than literal log transitions).
  is_eventually_follows?: boolean;
}

export type TaskStatus = 'open' | 'in_progress' | 'snoozed' | 'closed' | 'resolved';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Task {
  id: string;
  project_id: string;
  event_log_id: string | null;
  case_id: string | null;
  title: string;
  description: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  assignee_id: string | null;
  source_rule_id: string | null;
  context: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  snoozed_until: string | null;
  resolved_at: string | null;
}

export interface TaskSummary {
  open: number;
  in_progress: number;
  snoozed: number;
  closed: number;
  resolved: number;
  total: number;
}

export interface OverviewResponse {
  totals: {
    projects: number;
    event_logs: number;
    total_cases: number;
    total_events: number;
    total_activities: number;
    avg_events_per_case: number;
  };
  alerts: {
    total: number;
    active: number;
    triggered_last_24h: number;
  };
  initiatives: {
    total: number;
    active: number;
    achieved: number;
    realized_savings: number;
  };
  working_capital: {
    logs_with_cost: number;
    total_cost: number | null;
    cost_per_case: number | null;
    logs: Array<{
      id: string;
      name: string;
      project_id: string;
      project_name: string | null;
      total_cases: number;
    }>;
  } | null;
  recent_event_logs: Array<{
    id: string;
    name: string;
    project_id: string;
    project_name: string | null;
    total_cases: number;
    total_events: number;
    created_at: string | null;
  }>;
}

export interface ProcessFilter {
  time_start?: string;
  time_end?: string;
  duration_min?: number;
  duration_max?: number;
  activities_include?: string[];
  activities_exclude?: string[];
  start_activities?: string[];
  end_activities?: string[];
  variants?: number[];
  attributes?: AttributeFilter[];
  // Edge-based filtering: a tuple [source, target]. `required_edges` keeps
  // only cases that contain every listed transition; `forbidden_edges` drops
  // any case that contains any of them.
  required_edges?: Array<[string, string]>;
  forbidden_edges?: Array<[string, string]>;
}

export interface FilterOptions {
  activities: string[];
  start_activities: string[];
  end_activities: string[];
  date_min: string | null;
  date_max: string | null;
  duration_min: number;
  duration_max: number;
  attributes: Record<string, string[]>;
}

export interface DiscoveryRequest {
  event_log_id: string;
  algorithm: 'dfg' | 'alpha' | 'heuristic' | 'inductive' | 'split_miner';
  parameters?: Record<string, unknown>;
  filters?: ProcessFilter;
}

export interface DiscoveryResponse {
  event_log_id: string;
  algorithm: string;
  nodes: ProcessNode[];
  edges: ProcessEdge[];
  statistics: Record<string, unknown>;
}

export interface Variant {
  id: number;
  activities: string[];
  frequency: number;
  percentage: number;
  avg_duration: number | null;
  min_duration: number | null;
  max_duration: number | null;
}

export interface VariantResponse {
  variants: Variant[];
  total_cases: number;
  total_variants: number;
}

export interface Bottleneck {
  activity: string;
  avg_duration: number;
  median_duration: number;
  frequency: number;
  is_bottleneck: boolean;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface WaitingTime {
  source: string;
  target: string;
  avg_waiting: number;
  median_waiting: number;
  max_waiting: number;
  frequency: number;
}

export interface DBSMScore {
  activity: string;
  dbsm_score: number;
  delay_component: number;
  pressure_component: number;
  impact_component: number;
  rank: number;
}

export interface BottleneckResponse {
  bottlenecks: Bottleneck[];
  waiting_times: WaitingTime[];
  dbsm_scores?: DBSMScore[];
}

export interface ConformanceResponse {
  fitness: number;
  precision: number | null;
  generalization: number | null;
  deviations: Deviation[];
  conformant_cases: number;
  total_cases: number;
}

export interface Deviation {
  case_id: string;
  deviation_type: string;
  expected: string | null;
  actual: string | null;
  activity: string | null;
}

export interface RootCauseFactor {
  attribute: string;
  value: string;
  impact: string;
  avg_duration_affected: number;
  avg_duration_normal: number;
  case_count: number;
}

export interface Correlation {
  attribute: string;
  correlation_value: number;
  p_value: number;
}

export interface RootCauseResponse {
  factors: RootCauseFactor[];
  correlations: Correlation[];
}

export interface ProcessStatistics {
  total_cases: number;
  total_events: number;
  total_activities: number;
  avg_case_duration: number;
  median_case_duration: number;
  min_case_duration: number;
  max_case_duration: number;
  avg_events_per_case: number;
  start_activities: Array<{ activity: string; frequency: number }>;
  end_activities: Array<{ activity: string; frequency: number }>;
  activity_frequencies: Array<{
    activity: string;
    frequency: number;
    relative_frequency: number;
  }>;
  cases_over_time: Array<{ date: string; count: number }>;
  sla_compliance?: number;
}

export interface ProcessSummary {
  statistics: ProcessStatistics;
  top_variants: Variant[];
  bottlenecks: Bottleneck[];
  process_map: DiscoveryResponse;
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export interface Dashboard {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  layout: Record<string, unknown>;
  widgets: WidgetConfig[];
  is_shared: boolean;
  share_token: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface WidgetConfig {
  id: string;
  type: string;
  title: string;
  config: Record<string, unknown>;
  position: { x: number; y: number; w: number; h: number };
}

export interface DashboardCreate {
  project_id: string;
  name: string;
  description?: string;
}

// ─── Alert ───────────────────────────────────────────────────────────────────

export interface Alert {
  id: string;
  project_id: string;
  event_log_id: string;
  name: string;
  metric: string;
  condition: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
  threshold: number;
  is_active: boolean;
  notification_channel: 'email' | 'webhook' | 'slack';
  webhook_url: string | null;
  email_recipients: string[];
  last_triggered: string | null;
  last_value: number | null;
  created_by: string;
  created_at: string;
}

export interface AlertCreate {
  project_id: string;
  event_log_id: string;
  name: string;
  metric: string;
  condition: string;
  threshold: number;
  notification_channel?: string;
  webhook_url?: string;
  email_recipients?: string[];
}

// ─── Connector ───────────────────────────────────────────────────────────────

export interface Connector {
  id: string;
  project_id: string;
  name: string;
  connector_type:
    | 'postgresql'
    | 'mysql'
    | 'sqlserver'
    | 'csv_watch'
    | 'api_endpoint';
  config: Record<string, unknown>;
  column_mapping: Record<string, unknown>;
  schedule: string | null;
  last_sync: string | null;
  status: 'active' | 'inactive' | 'error';
  error_message: string | null;
  created_by: string;
  created_at: string;
}

// ─── Template ────────────────────────────────────────────────────────────────

export interface ProcessTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  reference_model: Record<string, unknown>;
  expected_activities: string[];
  kpis: Array<{ name: string; metric: string; target: number; unit: string }>;
  anti_patterns: Array<{
    name: string;
    pattern: string;
    description: string;
    activity?: string;
  }>;
  is_builtin: boolean;
  created_at: string;
}

// ─── Annotation ──────────────────────────────────────────────────────────────

export interface Annotation {
  id: string;
  project_id: string;
  event_log_id: string;
  activity_name: string | null;
  edge_source: string | null;
  edge_target: string | null;
  content: string;
  created_by: string;
  created_at: string;
}

// ─── Cases ───────────────────────────────────────────────────────────────────

export interface CaseInfo {
  case_id: string;
  event_count: number;
  duration_seconds: number | null;
  start_activity: string;
  end_activity: string;
  start_time: string;
  end_time: string;
  variant: string;
}

export interface CaseListResponse {
  cases: CaseInfo[];
  total_cases: number;
}

export interface CaseEvent {
  activity: string;
  timestamp: string;
  resource: string | null;
  duration_to_next: number | null;
}

export interface CaseDetailResponse {
  case_id: string;
  events: CaseEvent[];
  total_duration: number | null;
}

export interface TimelineEvent {
  timestamp: string;
  case_id: string;
  activity: string;
  source: string | null;
}

export interface TimelineResponse {
  events: TimelineEvent[];
  start_time: string;
  end_time: string;
  total_events: number;
}

// ─── Dotted Chart ────────────────────────────────────────────────────────────

export interface DottedChartEvent {
  timestamp: string;
  case_id: string;
  activity: string;
  resource: string | null;
  case_index: number;
}

export interface DottedChartResponse {
  events: DottedChartEvent[];
  activities: string[];
  resources: string[];
  case_count: number;
  time_range: { start: string; end: string };
}

// ─── Social Network ──────────────────────────────────────────────────────────

export interface SocialNetworkNode {
  id: string;
  label: string;
  frequency: number;
}

export interface SocialNetworkEdge {
  source: string;
  target: string;
  frequency: number;
}

export interface SocialNetworkResponse {
  nodes: SocialNetworkNode[];
  edges: SocialNetworkEdge[];
  total_resources: number;
  total_handovers: number;
}

// ─── Process Comparison ──────────────────────────────────────────────────────

export interface ComparisonNode {
  id: string;
  label: string;
  frequency_a: number;
  frequency_b: number;
}

export interface ComparisonEdge {
  source: string;
  target: string;
  frequency_a: number;
  frequency_b: number;
  diff: number;
  status: string;
}

export interface ComparisonResponse {
  nodes: ComparisonNode[];
  edges: ComparisonEdge[];
  stats_a: Record<string, number>;
  stats_b: Record<string, number>;
}

// ─── Rework ──────────────────────────────────────────────────────────────────

export interface ActivityRework {
  activity: string;
  total_occurrences: number;
  cases_with_rework: number;
  total_cases: number;
  rework_rate: number;
  avg_repetitions: number;
}

export interface ReworkResponse {
  activities: ActivityRework[];
  overall_rework_rate: number;
  cases_with_rework: number;
  total_cases: number;
  self_loops: Array<{ activity: string; count: number }>;
}

// ─── Activity Detail ─────────────────────────────────────────────────────────

export interface ActivityDetailResponse {
  activity: string;
  frequency: number;
  case_count: number;
  avg_duration: number | null;
  median_duration: number | null;
  min_duration: number | null;
  max_duration: number | null;
  duration_histogram: Array<{ bin_start: number; bin_end: number; count: number }>;
  resources: Array<{ name: string; count: number }>;
  predecessors: Array<{ activity: string; frequency: number }>;
  successors: Array<{ activity: string; frequency: number }>;
  is_start: boolean;
  is_end: boolean;
}

// ─── OCPM ────────────────────────────────────────────────────────────────────

export interface OCELSummary {
  ocel_id: string;
  object_types: string[];
  event_count: number;
  object_count: number;
  activities: string[];
  objects_per_type: Record<string, number>;
}

export interface OCDFGNode {
  id: string;
  label: string;
  object_type: string;
  frequency: number;
}

export interface OCDFGEdge {
  source: string;
  target: string;
  object_type: string;
  frequency: number;
}

export interface OCDFGResponse {
  ocel_id: string;
  nodes: OCDFGNode[];
  edges: OCDFGEdge[];
  object_types: string[];
}

export interface ObjectInteraction {
  type_a: string;
  type_b: string;
  interaction_count: number;
}

export interface ObjectInteractionsResponse {
  interactions: ObjectInteraction[];
  total_interactions: number;
}

export interface ObjectLifecycle {
  object_type: string;
  object_count: number;
  avg_lifecycle_duration: number | null;
  avg_events_per_object: number;
  activities: string[];
}

export interface ObjectLifecycleResponse {
  lifecycles: ObjectLifecycle[];
}

export interface ActivityObjectType {
  activity: string;
  object_types: Record<string, number>;
  total_events: number;
}

export interface ActivityObjectTypesResponse {
  activities: ActivityObjectType[];
}

export interface FlattenResponse {
  event_log_id: string;
  object_type: string;
  total_cases: number;
  total_events: number;
  total_activities: number;
}

export interface OCPetriNetObjectType {
  object_type: string;
  activity_count: number;
  place_count: number;
  arc_count: number;
  activities: string[];
}

export interface OCPetriNetResponse {
  object_types: OCPetriNetObjectType[];
  total_object_types: number;
}

export interface ObjectsGraphEdge {
  source_obj: string;
  target_obj: string;
  count: number;
}

export interface ObjectsGraphResponse {
  edges: ObjectsGraphEdge[];
  total_edges: number;
  graph_type: string;
}

export interface OCELFeaturesResponse {
  columns: string[];
  rows: Record<string, unknown>[];
  total_objects: number;
  object_type: string;
}

export interface TemporalHourBucket {
  hour: number;
  count: number;
}

export interface TemporalDayBucket {
  date: string;
  count: number;
}

export interface ActivityTimeline {
  activity: string;
  first_seen: string;
  last_seen: string;
  event_count: number;
}

export interface OCELTemporalResponse {
  events_by_hour: TemporalHourBucket[];
  events_by_day: TemporalDayBucket[];
  activity_timeline: ActivityTimeline[];
}

export interface ComponentSizeBucket {
  size: number;
  count: number;
}

export interface ConnectedComponentsResponse {
  total_components: number;
  size_distribution: ComponentSizeBucket[];
  largest_component_size: number;
  avg_component_size: number;
}

// ─── Simulation ──────────────────────────────────────────────────────────────

export interface SimulationModification {
  type: 'duration_scale' | 'remove_activity' | 'adjust_frequency';
  activity: string;
  value: number;
}

export interface SimulationActivityStats {
  name: string;
  frequency: number;
  avg_duration: number;
}

export interface SimulationStats {
  total_cases: number;
  total_events: number;
  avg_case_duration: number;
  median_case_duration: number;
  avg_events_per_case: number;
  activities: SimulationActivityStats[];
}

export interface SimulationResponse {
  original: SimulationStats;
  simulated: SimulationStats;
  improvement: {
    avg_duration_change_pct: number;
    case_count_change: number;
    activities_removed: string[];
  };
}

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

// ─── UI ──────────────────────────────────────────────────────────────────────

export interface Notification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message?: string;
  duration?: number;
}
