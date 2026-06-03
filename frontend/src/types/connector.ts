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

// Schema introspection for column-mapping dropdowns. `columns` is a
// best-effort flat list of field names; treat an empty array as
// "fall back to free-text input". Never errors — introspection
// failures come back with columns:[] and a populated `error`.
export interface ConnectorSchemaResponse {
  connector_id: string;
  connector_type: string;
  columns: string[];
  schema: Record<string, unknown>;
  error: string | null;
}
