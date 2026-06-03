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
