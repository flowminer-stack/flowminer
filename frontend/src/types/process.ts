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
  // Threading — a reply points at its parent annotation.
  parent_id: string | null;
  // Resolution
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  // Assignment
  assignee_id: string | null;
  // Populated only when listed with nest_replies=true; flat otherwise.
  replies: Annotation[];
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
