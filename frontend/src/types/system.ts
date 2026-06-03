// ─── Log Builder (multi-table) ────────────────────────────────────────────────

// A single join applied while assembling a wide table from multiple
// staging sources. `right_source` is either a 0-based index into the
// build request's `additional_sources` array or an explicit staging
// path string. Keys must exist on both sides; if `right_on` is omitted
// the join uses `left_on` for both sides.
export interface LogBuilderJoin {
  right_source: number | string;
  left_on: string[];
  right_on?: string[];
  how?: 'left' | 'inner' | 'right' | 'outer';
  suffixes?: [string, string];
}

export interface LogBuilderEventSpec {
  activity_name: string;
  timestamp_column: string;
}

export interface LogBuilderBuildRequest {
  project_id: string;
  name: string;
  staging_path: string;
  case_id_column: string;
  events: LogBuilderEventSpec[];
  resource_column?: string | null;
  passthrough_columns?: string[];
  // Multi-table assembly (additive, optional). Upload each extra table
  // via uploadRaw, collect the staging paths into `additional_sources`,
  // and reference them by index from each join's `right_source`.
  additional_sources?: string[];
  joins?: LogBuilderJoin[];
}

export interface LogBuilderColumn {
  name: string;
  dtype: string;
  kind: 'text' | 'numeric' | 'datetime' | 'datetime_like';
  nunique: number;
  null_ratio: number;
}

export interface LogBuilderUploadResponse {
  staging_path: string;
  columns: LogBuilderColumn[];
  sample_rows: Record<string, unknown>[];
  total_rows: number;
}

export interface LogBuilderBuildResponse {
  event_log_id: string;
  total_events: number;
  total_cases: number;
  activities: string[];
}

// ─── System settings (admin-only) ─────────────────────────────────────────

export interface LLMConfigResponse {
  provider: string;
  provider_source: 'db' | 'env' | 'unset';
  model: string;
  model_source: 'db' | 'env' | 'unset';
  has_api_key: boolean;
  api_key_source: 'db' | 'env' | 'unset';
  api_key_preview: string | null;
  is_configured: boolean;
}

export interface LLMConfigUpdate {
  provider?: string;
  model?: string;
  /** Empty string clears the stored key; omit to leave alone. */
  api_key?: string;
}

export interface ComponentStatus {
  ok: boolean;
  detail: string;
}

export interface SystemHealthResponse {
  database: ComponentStatus;
  redis: ComponentStatus;
  encryption: ComponentStatus;
  llm_provider: ComponentStatus;
  smtp: ComponentStatus;
  upload_dir: ComponentStatus;
}
