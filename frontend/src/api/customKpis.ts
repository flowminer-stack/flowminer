import api from './http';
import type { CustomKpi, KpiCreate, KpiUpdate, KpiComputeResult } from '@/types/customKpi';

// ─── Custom KPIs ─────────────────────────────────────────────────────────────

export const customKpis = {
  list: async (projectId: string): Promise<CustomKpi[]> => {
    const response = await api.get<CustomKpi[]>(`/kpis?project_id=${projectId}`);
    return response.data;
  },

  create: async (data: KpiCreate): Promise<CustomKpi> => {
    const response = await api.post<CustomKpi>('/kpis', data);
    return response.data;
  },

  update: async (id: string, data: KpiUpdate): Promise<CustomKpi> => {
    const response = await api.put<CustomKpi>(`/kpis/${id}`, data);
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await api.delete(`/kpis/${id}`);
  },

  compute: async (id: string, eventLogId: string): Promise<KpiComputeResult> => {
    const response = await api.post<KpiComputeResult>(
      `/kpis/${id}/compute?event_log_id=${eventLogId}`,
    );
    return response.data;
  },
};
