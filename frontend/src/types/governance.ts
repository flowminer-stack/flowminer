// ─── Governance + capability + log versions ────────────────────────────

export type GovernanceStatus = 'draft' | 'review' | 'approved' | 'published' | 'retired';

export interface GovernanceEntry {
  id: string;
  name: string;
  owner_id: string | null;
  event_log_id: string | null;
  version: string;
  status: GovernanceStatus;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Capability {
  id: string;
  name: string;
  description: string | null;
  parent_id: string | null;
  linked_event_log_ids: string[];
  owner_id: string | null;
  created_at: string;
}

export interface LogVersion {
  id: string;
  event_log_id: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  filter_payload: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
}
