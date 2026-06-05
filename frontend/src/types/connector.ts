// ─── Connector ───────────────────────────────────────────────────────────────

// Connector type ids. The authoritative, runtime source of truth is the
// backend registry (GET /connectors/registry); this union mirrors the backend
// ConnectorType enum so the API types stay honest. (It previously listed only
// 5 of the ~19 types — silent drift.)
export type ConnectorTypeId =
  | 'postgresql'
  | 'mysql'
  | 'sqlserver'
  | 'oracle'
  | 'csv_watch'
  | 'api_endpoint'
  | 'jira'
  | 'github'
  | 'odoo'
  | 'zendesk'
  | 'sap'
  | 'salesforce'
  | 'servicenow'
  | 'snowflake'
  | 'bigquery'
  | 'workday'
  | 'oracle_fusion'
  | 'coupa'
  | 'ariba';

// One entry per pickable connector type, served by GET /connectors/registry.
// Drives the type picker so a backend-added connector appears in the UI with
// no frontend edit.
export interface ConnectorRegistryEntry {
  id: ConnectorTypeId;
  label: string;
  category: string;
  mapping_mode: 'auto' | 'manual' | 'none';
  supports_incremental: boolean;
  config_schema: Record<string, unknown>;
}

export interface Connector {
  id: string;
  project_id: string;
  name: string;
  connector_type: ConnectorTypeId;
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
