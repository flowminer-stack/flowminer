import api from './http';

// ─── Initiatives (Value/ROI Tracker) ─────────────────────────────────────────

export const initiatives = {
  list: async (projectId: string): Promise<any[]> => {
    const r = await api.get('/initiatives', { params: { project_id: projectId } });
    return r.data;
  },
  create: async (body: any): Promise<any> => {
    const r = await api.post('/initiatives', body);
    return r.data;
  },
  update: async (id: string, body: any): Promise<any> => {
    const r = await api.put(`/initiatives/${id}`, body);
    return r.data;
  },
  delete: async (id: string): Promise<void> => {
    await api.delete(`/initiatives/${id}`);
  },
  measure: async (id: string): Promise<any> => {
    const r = await api.post(`/initiatives/${id}/measure`);
    return r.data;
  },
  summary: async (projectId: string): Promise<any> => {
    const r = await api.get(`/initiatives/summary/${projectId}`);
    return r.data;
  },
};
