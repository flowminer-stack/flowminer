// ─── Version History ─────────────────────────────────────────────────────────

export interface VersionRecord {
  id: string;
  entity_type: string;
  entity_id: string;
  version_number: string;
  snapshot: Record<string, unknown>;
  change_summary: string | null;
  created_by: string;
  created_at: string;
}

export interface RestoreResult {
  status: string;
  entity_type: string;
  entity_id: string;
  version: string;
}
