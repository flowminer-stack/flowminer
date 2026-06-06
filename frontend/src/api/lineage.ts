import api from './http';
import type { EventLogLineage } from '@/types/lineage';

// Re-export the lineage domain types so consumers can pull them from the
// api module alongside the resource (matches the governance.ts convention).
export type * from '@/types/lineage';

// ─── Data Lineage / Impact Analysis ──────────────────────────────────────────
// GET /api/v1/lineage/{event_log_id} → everything downstream of an event log.

export const lineage = {
  /** Fetch the full downstream dependency graph for a single event log. */
  get: async (eventLogId: string): Promise<EventLogLineage> =>
    (await api.get(`/lineage/${eventLogId}`)).data,
};

export default lineage;
