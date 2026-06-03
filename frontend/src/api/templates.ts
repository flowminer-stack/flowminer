import api from './http';
import type { ProcessTemplate } from '@/types';

// ─── Templates ───────────────────────────────────────────────────────────────

export const templates = {
  list: async (): Promise<ProcessTemplate[]> => {
    const response = await api.get<ProcessTemplate[]>('/templates');
    return response.data;
  },

  get: async (id: string): Promise<ProcessTemplate> => {
    const response = await api.get<ProcessTemplate>(`/templates/${id}`);
    return response.data;
  },

  create: async (data: Partial<ProcessTemplate>): Promise<ProcessTemplate> => {
    const response = await api.post<ProcessTemplate>('/templates', data);
    return response.data;
  },

  seed: async (): Promise<{ message: string }> => {
    const response = await api.post<{ message: string }>('/templates/seed');
    return response.data;
  },
};
