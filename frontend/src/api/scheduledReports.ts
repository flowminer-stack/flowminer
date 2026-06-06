import api from './http';
import type {
  ScheduledReport,
  ScheduledReportCreate,
  ScheduledReportUpdate,
} from '@/types/scheduledReport';

// ─── Scheduled Reports ───────────────────────────────────────────────────────

export const scheduledReports = {
  list: async (projectId?: string): Promise<ScheduledReport[]> => {
    const params = projectId ? `?project_id=${projectId}` : '';
    const response = await api.get<ScheduledReport[]>(
      `/scheduled-reports${params}`,
    );
    return response.data;
  },

  create: async (data: ScheduledReportCreate): Promise<ScheduledReport> => {
    const response = await api.post<ScheduledReport>('/scheduled-reports', data);
    return response.data;
  },

  get: async (id: string): Promise<ScheduledReport> => {
    const response = await api.get<ScheduledReport>(`/scheduled-reports/${id}`);
    return response.data;
  },

  update: async (
    id: string,
    data: ScheduledReportUpdate,
  ): Promise<ScheduledReport> => {
    const response = await api.put<ScheduledReport>(
      `/scheduled-reports/${id}`,
      data,
    );
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await api.delete(`/scheduled-reports/${id}`);
  },

  sendNow: async (id: string): Promise<{ status: string; report_id: string }> => {
    const response = await api.post<{ status: string; report_id: string }>(
      `/scheduled-reports/${id}/send`,
    );
    return response.data;
  },
};
