import api from './http';
import type { GovernanceStatus, GovernanceEntry, Capability, LogVersion } from '@/types';

// Re-export the governance domain types so the historical '@/api/client'
// surface (which exposed these alongside the `governance` resource) keeps
// resolving unchanged.
export type { GovernanceStatus, GovernanceEntry, Capability, LogVersion } from '@/types';

// ─── Governance + capability + log versions ────────────────────────────

export const governance = {
  // Governance entries
  listEntries: async (): Promise<GovernanceEntry[]> =>
    (await api.get('/governance/entries')).data,
  createEntry: async (body: {
    name: string;
    event_log_id?: string | null;
    version?: string;
    notes?: string | null;
  }): Promise<GovernanceEntry> => (await api.post('/governance/entries', body)).data,
  updateEntry: async (
    id: string,
    body: Partial<Pick<GovernanceEntry, 'name' | 'version' | 'notes' | 'owner_id'>>,
  ): Promise<GovernanceEntry> => (await api.put(`/governance/entries/${id}`, body)).data,
  promoteEntry: async (
    id: string,
    toStatus: GovernanceStatus,
    comment?: string,
  ): Promise<GovernanceEntry> =>
    (await api.post(`/governance/entries/${id}/promote`, { to_status: toStatus, comment })).data,
  entryHistory: async (id: string) =>
    (await api.get(`/governance/entries/${id}/history`)).data as Array<{
      id: string;
      from_status: GovernanceStatus | null;
      to_status: GovernanceStatus;
      actor_id: string;
      comment: string | null;
      created_at: string;
    }>,
  deleteEntry: async (id: string) => (await api.delete(`/governance/entries/${id}`)).data,

  // Capabilities
  listCapabilities: async (): Promise<Capability[]> =>
    (await api.get('/governance/capabilities')).data,
  createCapability: async (body: {
    name: string;
    description?: string | null;
    parent_id?: string | null;
    linked_event_log_ids?: string[];
  }): Promise<Capability> => (await api.post('/governance/capabilities', body)).data,
  updateCapability: async (
    id: string,
    body: Partial<Pick<Capability, 'name' | 'description' | 'parent_id' | 'linked_event_log_ids'>>,
  ): Promise<Capability> => (await api.put(`/governance/capabilities/${id}`, body)).data,
  deleteCapability: async (id: string) =>
    (await api.delete(`/governance/capabilities/${id}`)).data,

  // Log versions
  listLogVersions: async (eventLogId: string): Promise<LogVersion[]> =>
    (await api.get(`/governance/log-versions?event_log_id=${eventLogId}`)).data,
  createLogVersion: async (body: {
    event_log_id: string;
    name: string;
    description?: string | null;
    parent_id?: string | null;
    filter_payload?: Record<string, unknown> | null;
  }): Promise<LogVersion> => (await api.post('/governance/log-versions', body)).data,
  deleteLogVersion: async (id: string) =>
    (await api.delete(`/governance/log-versions/${id}`)).data,
};
