import api from './http';
import type { VersionRecord, RestoreResult } from '@/types/version';

// ─── Version History ─────────────────────────────────────────────────────────
// Endpoint prefix: /api/v1/versions (mounted in main.py)

export const versions = {
  /**
   * List all version snapshots for a given entity.
   * entity_type: 'dashboard' | 'event_log' | ...
   */
  list: async (
    entityType: string,
    entityId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<VersionRecord[]> => {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    const qs = params.toString() ? `?${params}` : '';
    const res = await api.get<VersionRecord[]>(`/versions/${entityType}/${entityId}${qs}`);
    return res.data;
  },

  /**
   * Fetch a single version record by id.
   */
  get: async (versionId: string): Promise<VersionRecord> => {
    const res = await api.get<VersionRecord>(`/versions/detail/${versionId}`);
    return res.data;
  },

  /**
   * Save a manual snapshot of an entity's current state.
   * The snapshot dict is the caller's responsibility (pass e.g. the current dashboard object).
   */
  snapshot: async (
    entityType: string,
    entityId: string,
    snapshot: Record<string, unknown>,
    changeSummary?: string,
  ): Promise<VersionRecord> => {
    const params = new URLSearchParams({ entity_type: entityType, entity_id: entityId });
    if (changeSummary) params.set('change_summary', changeSummary);
    const res = await api.post<VersionRecord>(`/versions/snapshot?${params}`, snapshot);
    return res.data;
  },

  /**
   * Restore an entity to a previous version. Currently only dashboards are supported.
   */
  restore: async (versionId: string): Promise<RestoreResult> => {
    const res = await api.post<RestoreResult>(`/versions/restore/${versionId}`);
    return res.data;
  },
};
