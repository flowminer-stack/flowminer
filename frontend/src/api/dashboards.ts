import api from './http';
import type { Dashboard, DashboardCreate } from '@/types';

// ─── Dashboards ──────────────────────────────────────────────────────────────

export const dashboards = {
  list: async (projectId?: string): Promise<Dashboard[]> => {
    const params = projectId ? `?project_id=${projectId}` : '';
    const response = await api.get<Dashboard[]>(`/dashboards${params}`);
    return response.data;
  },

  create: async (data: DashboardCreate): Promise<Dashboard> => {
    const response = await api.post<Dashboard>('/dashboards', data);
    return response.data;
  },

  get: async (id: string): Promise<Dashboard> => {
    const response = await api.get<Dashboard>(`/dashboards/${id}`);
    return response.data;
  },

  update: async (id: string, data: Partial<Dashboard>): Promise<Dashboard> => {
    const response = await api.put<Dashboard>(`/dashboards/${id}`, data);
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await api.delete(`/dashboards/${id}`);
  },

  getShared: async (shareToken: string): Promise<Dashboard> => {
    const response = await api.get<Dashboard>(
      `/dashboards/shared/${shareToken}`,
    );
    return response.data;
  },
};
