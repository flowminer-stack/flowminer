// ─── Data Lineage / Impact Analysis ──────────────────────────────────────────
// Mirrors GET /api/v1/lineage/{event_log_id} — every downstream resource that
// references a given event log. Used to answer "what breaks if I delete this?".

export interface LineageEventLog {
  id: string;
  name: string;
  source_type: string;
  log_type: string;
  created_at: string | null;
  total_events: number | null;
  total_cases: number | null;
}

export interface LineageRef {
  id: string;
  name: string;
}

export interface LineageAlert extends LineageRef {
  is_active: boolean;
}

export interface LineageInitiative extends LineageRef {
  status: string;
  metric: string;
}

export interface LineageActionRule extends LineageRef {
  enabled: boolean;
  trigger_count: number;
}

export interface LineageKPI extends LineageRef {
  metric: string;
}

export interface LineageScheduledReport extends LineageRef {
  frequency: string;
}

export interface LineageDerivedLog extends LineageRef {
  created_at: string | null;
}

export interface EventLogLineage {
  event_log: LineageEventLog;
  dashboards: LineageRef[];
  alerts: LineageAlert[];
  etl_pipelines: LineageRef[];
  initiatives: LineageInitiative[];
  action_rules: LineageActionRule[];
  custom_kpis: LineageKPI[];
  scheduled_reports: LineageScheduledReport[];
  annotations_count: number;
  derived_logs: LineageDerivedLog[];
  version_history_count: number;
}
