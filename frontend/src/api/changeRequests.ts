import api from './http';
import type { ChangeRequest, ChangeRequestCreate } from '@/types/changeRequest';

// ─── Change Requests ─────────────────────────────────────────────────────────
// Endpoint prefix: /api/v1/change-requests

export const changeRequests = {
  /**
   * List change requests for a project. Optionally filter by status.
   * Uses the `get_owned_project` dep which reads `project_id` as a query param.
   */
  list: async (
    projectId: string,
    opts?: { status?: string; limit?: number; offset?: number },
  ): Promise<ChangeRequest[]> => {
    const params = new URLSearchParams({ project_id: projectId });
    if (opts?.status) params.set('status', opts.status);
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    const res = await api.get<ChangeRequest[]>(`/change-requests?${params}`);
    return res.data;
  },

  /**
   * Create a new change request in draft status.
   */
  create: async (body: ChangeRequestCreate): Promise<ChangeRequest> => {
    const res = await api.post<ChangeRequest>('/change-requests', body);
    return res.data;
  },

  /**
   * Submit a draft change request for review.
   */
  submit: async (crId: string): Promise<ChangeRequest> => {
    const res = await api.post<ChangeRequest>(`/change-requests/${crId}/submit`);
    return res.data;
  },

  /**
   * Approve a submitted/in_review change request. Admins or listed reviewers only.
   */
  approve: async (crId: string): Promise<ChangeRequest> => {
    const res = await api.post<ChangeRequest>(`/change-requests/${crId}/approve`);
    return res.data;
  },

  /**
   * Reject a submitted/in_review change request with an optional reason.
   */
  reject: async (crId: string, reason?: string): Promise<ChangeRequest> => {
    const params = reason ? `?reason=${encodeURIComponent(reason)}` : '';
    const res = await api.post<ChangeRequest>(`/change-requests/${crId}/reject${params}`);
    return res.data;
  },
};
