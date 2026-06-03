import api from './http';
import type { Alert, AlertCreate } from '@/types';

// ─── Alerts ──────────────────────────────────────────────────────────────────

export const alerts = {
  list: async (projectId?: string): Promise<Alert[]> => {
    const params = projectId ? `?project_id=${projectId}` : '';
    const response = await api.get<Alert[]>(`/alerts${params}`);
    return response.data;
  },

  create: async (data: AlertCreate): Promise<Alert> => {
    const response = await api.post<Alert>('/alerts', data);
    return response.data;
  },

  get: async (id: string): Promise<Alert> => {
    const response = await api.get<Alert>(`/alerts/${id}`);
    return response.data;
  },

  update: async (id: string, data: Partial<AlertCreate>): Promise<Alert> => {
    const response = await api.put<Alert>(`/alerts/${id}`, data);
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await api.delete(`/alerts/${id}`);
  },

  test: async (id: string): Promise<{ success: boolean; message: string }> => {
    const response = await api.post<{ success: boolean; message: string }>(
      `/alerts/${id}/test`,
    );
    return response.data;
  },
};
