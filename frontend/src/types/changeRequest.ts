// ─── Change Requests ─────────────────────────────────────────────────────────

export type ChangeRequestStatus = 'draft' | 'submitted' | 'in_review' | 'approved' | 'rejected';

export interface ChangeRequest {
  id: string;
  project_id: string;
  entity_type: string;
  entity_id: string;
  title: string;
  description: string | null;
  before_payload: Record<string, unknown> | null;
  after_payload: Record<string, unknown> | null;
  status: ChangeRequestStatus;
  reviewers: string[];
  apply_on_approve: boolean;
  created_by: string | null;
  approver_id: string | null;
  rejection_reason: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ChangeRequestCreate {
  project_id: string;
  entity_type: string;
  entity_id: string;
  title: string;
  description?: string;
  before_payload?: Record<string, unknown>;
  after_payload?: Record<string, unknown>;
  reviewers?: string[];
  apply_on_approve?: boolean;
}
