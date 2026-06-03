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
