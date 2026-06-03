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

// Project export/import manifest. Event-log *files* are not embedded —
// the manifest references them by SHA-256 checksum so the importer knows
// which files to re-attach afterward. The exact child-resource shapes are
// emitted by the backend and treated opaquely by the UI, so the manifest
// is typed as an open record.
export type ProjectExportManifest = Record<string, unknown>;

export interface ProjectImportRequest {
  manifest: ProjectExportManifest;
  target_project_name?: string | null;
}

export interface ProjectImportResponse {
  project_id: string;
  imported: {
    event_logs: number;
    dashboards: number;
    alerts: number;
    custom_kpis: number;
    initiatives: number;
    action_rules: number;
  };
  notice: string;
}
