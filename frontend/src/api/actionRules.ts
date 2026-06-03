import api from './http';

// ─── Action Rules ────────────────────────────────────────────────────────────

export const actionRules = {
  list: async (projectId: string): Promise<any[]> => {
    const r = await api.get('/action-rules', { params: { project_id: projectId } });
    return r.data;
  },
  create: async (body: any): Promise<any> => {
    const r = await api.post('/action-rules', body);
    return r.data;
  },
  update: async (id: string, body: any): Promise<any> => {
    const r = await api.put(`/action-rules/${id}`, body);
    return r.data;
  },
  delete: async (id: string): Promise<void> => {
    await api.delete(`/action-rules/${id}`);
  },
  evaluate: async (id: string, dryRun = true): Promise<any> => {
    const r = await api.post(`/action-rules/${id}/evaluate`, null, { params: { dry_run: dryRun } });
    return r.data;
  },
  executions: async (id: string, limit = 100): Promise<any[]> => {
    const r = await api.get(`/action-rules/${id}/executions`, { params: { limit } });
    return r.data;
  },
};
