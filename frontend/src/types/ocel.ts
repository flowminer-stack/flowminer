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

// ─── OPerA object-centric performance ─────────────────────────────────────────

export interface OPeraActivityMetrics {
  activity: string;
  flow_time: number | null;
  synchronization_time: number | null;
  pooling_time: number | null;
  lagging_time: number | null;
}

export interface OPeraPerformanceResponse {
  ocel_id: string;
  activities: OPeraActivityMetrics[];
  method: string;
  note: string | null;
}

// ─── State-Aware OCPM ──────────────────────────────────────────────────────────

export interface StateTransition {
  oid: string;
  object_type: string;
  from_state: string | null;
  to_state: string;
  timestamp: string;
  activity: string;
}

export interface StateAwareResponse {
  new_events_count: number;
  annotated_events: number;
  state_transitions: StateTransition[];
  distinct_states: Record<string, string[]>;
  annotations_by_event: Record<string, Record<string, string>>;
  method: string;
  state_column: string | null;
  object_type_filter: string | null;
  note: string | null;
}

// ─── OCPM improvement report ───────────────────────────────────────────────

// Shape of the new unified OCPM improvement report. Matches the
// pydantic models in backend/app/api/ocel.py.
export interface OCPMImprovementFinding {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  title: string;
  description: string;
  recommendation: string | null;
  metric_value: number | null;
  impact_estimate: string | null;
  related_activities: string[] | null;
  object_type: string | null;
}

export interface OCPMObjectTypeSection {
  object_type: string;
  total_cases: number;
  total_events: number;
  total_activities: number;
  critical_count: number;
  warning_count: number;
  findings: OCPMImprovementFinding[];
  error: string | null;
}

export interface OCPMImprovementReport {
  summary: string;
  ocel_event_count: number;
  ocel_object_count: number;
  object_type_count: number;
  total_findings: number;
  critical_count: number;
  warning_count: number;
  ocel_findings: OCPMImprovementFinding[];
  per_object_type: OCPMObjectTypeSection[];
  cross_object_findings: OCPMImprovementFinding[];
}
