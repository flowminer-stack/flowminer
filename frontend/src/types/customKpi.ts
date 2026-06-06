// ─── Custom KPI types ────────────────────────────────────────────────────────

export type KpiMetric =
  | 'avg_case_duration'
  | 'case_count'
  | 'event_count'
  | 'activity_count'
  | 'rework_rate'
  | 'variant_count'
  | 'conformance_fitness'
  | 'bottleneck_count'
  | 'median_case_duration'
  | 'custom_expression';

export type KpiStatus = 'ok' | 'warning' | 'critical';

export interface CustomKpi {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  metric: KpiMetric;
  expression: string | null;
  filters: Record<string, unknown> | null;
  unit: string | null;
  target_value: number | null;
  warning_threshold: number | null;
  critical_threshold: number | null;
  last_value: number | null;
  last_computed_at: string | null;
  created_at: string;
}

export interface KpiCreate {
  project_id: string;
  name: string;
  description?: string;
  metric: KpiMetric;
  expression?: string;
  unit?: string;
  target_value?: number;
  warning_threshold?: number;
  critical_threshold?: number;
}

export interface KpiUpdate {
  name?: string;
  description?: string;
  target_value?: number;
  warning_threshold?: number;
  critical_threshold?: number;
  unit?: string;
}

export interface KpiComputeResult {
  kpi_id: string;
  name: string;
  value: number;
  unit: string | null;
  target_value: number | null;
  status: KpiStatus;
  expression_warnings: string[];
}
